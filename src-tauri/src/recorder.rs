use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command as AsyncCommand};
use xcap::Monitor;

use crate::video::find_binary;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecStatus {
    pub platform: String,
    pub screen: String,
    pub microphone: String,
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub thumbnail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecSourcesResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub sources: Vec<RecSource>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecStartOpts {
    pub source_id: String,
    #[serde(default)]
    pub mic: bool,
    #[serde(default)]
    #[allow(dead_code)]
    pub system_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecStartResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecStopResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct ActiveRecording {
    child: Child,
    file_path: PathBuf,
}

#[derive(Default)]
pub struct ScreenRecorder {
    active: Mutex<Option<ActiveRecording>>,
}

pub fn default_output_dir() -> PathBuf {
    dirs::video_dir()
        .or_else(|| {
            dirs::home_dir().map(|h| {
                if cfg!(target_os = "macos") {
                    h.join("Movies")
                } else {
                    h.join("Videos")
                }
            })
        })
        .unwrap_or_else(std::env::temp_dir)
        .join("SyncBoard")
}

pub fn get_status() -> RecStatus {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };

    RecStatus {
        platform: platform.to_string(),
        screen: "granted".to_string(),
        microphone: "granted".to_string(),
        output_dir: default_output_dir().to_string_lossy().to_string(),
    }
}

pub fn open_privacy_settings(kind: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let pane = if kind == "microphone" {
            "Privacy_Microphone"
        } else {
            "Privacy_ScreenCapture"
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
        return Command::new("open")
            .arg(url)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        false
    }
}

fn encode_thumbnail_data_url(width: u32, height: u32, rgba: Vec<u8>) -> Option<String> {
    let img = RgbaImage::from_raw(width, height, rgba)?;
    let dyn_img = DynamicImage::ImageRgba8(img).resize(320, 200, FilterType::Triangle);
    let mut out = Cursor::new(Vec::new());
    dyn_img.write_to(&mut out, ImageFormat::Png).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(out.into_inner());
    Some(format!("data:image/png;base64,{b64}"))
}

/// Lista monitores disponíveis usando `xcap` com miniaturas leves.
pub fn list_sources() -> RecSourcesResult {
    let monitors = match Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            return RecSourcesResult {
                ok: false,
                error: Some(format!("Falha ao listar telas: {e}")),
                sources: Vec::new(),
            };
        }
    };

    let mut sources = Vec::new();
    for (idx, mon) in monitors.into_iter().enumerate() {
        let name = mon.name().unwrap_or_else(|_| format!("Tela {}", idx + 1));
        let thumb = mon
            .capture_image()
            .ok()
            .and_then(|img| encode_thumbnail_data_url(img.width(), img.height(), img.into_raw()))
            .unwrap_or_else(|| {
                "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'><rect width='100%' height='100%' fill='%231a1a21'/></svg>".to_string()
            });
        sources.push(RecSource {
            id: format!("screen:{idx}"),
            name,
            kind: "screen".to_string(),
            thumbnail: thumb,
        });
    }

    RecSourcesResult {
        ok: true,
        error: None,
        sources,
    }
}

/// No macOS, consulta `ffmpeg -f avfoundation -list_devices true -i ""` para descobrir o índice de "Capture screen N" e microfone.
#[cfg(target_os = "macos")]
fn resolve_avfoundation_indices(ffmpeg: &PathBuf, screen_idx: usize, want_mic: bool) -> (String, Option<String>) {
    let out = Command::new(ffmpeg)
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output();

    let mut video_screens: Vec<String> = Vec::new();
    let mut first_audio: Option<String> = None;
    let mut in_audio = false;

    if let Ok(o) = out {
        let stderr = String::from_utf8_lossy(&o.stderr);
        for line in stderr.lines() {
            if line.contains("AVFoundation audio devices:") {
                in_audio = true;
                continue;
            }
            if line.contains("AVFoundation video devices:") {
                in_audio = false;
                continue;
            }
            if let Some(bracket_start) = line.rfind('[') {
                if let Some(bracket_end) = line[bracket_start..].find(']') {
                    let idx_str = &line[bracket_start + 1..bracket_start + bracket_end];
                    if idx_str.chars().all(|c| c.is_ascii_digit()) {
                        let rest = &line[bracket_start + bracket_end + 1..];
                        if !in_audio && rest.to_lowercase().contains("capture screen") {
                            video_screens.push(idx_str.to_string());
                        } else if in_audio && first_audio.is_none() {
                            first_audio = Some(idx_str.to_string());
                        }
                    }
                }
            }
        }
    }

    let v_idx = video_screens
        .get(screen_idx)
        .or_else(|| video_screens.first())
        .cloned()
        .unwrap_or_else(|| "1".to_string());
    let a_idx = if want_mic { first_audio } else { None };
    (v_idx, a_idx)
}

fn timestamp_filename() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("gravacao-{secs}.mp4")
}

impl ScreenRecorder {
    pub fn start(&self, opts: RecStartOpts) -> RecStartResult {
        {
            let guard = self.active.lock().unwrap();
            if guard.is_some() {
                return RecStartResult {
                    ok: false,
                    file_path: None,
                    error: Some("Já existe uma gravação em andamento".to_string()),
                };
            }
        }

        let Some(ffmpeg) = find_binary("ffmpeg") else {
            return RecStartResult {
                ok: false,
                file_path: None,
                error: Some("ffmpeg não encontrado. Instale o ffmpeg para gravar a tela.".to_string()),
            };
        };

        let out_dir = default_output_dir();
        if let Err(e) = fs::create_dir_all(&out_dir) {
            return RecStartResult {
                ok: false,
                file_path: None,
                error: Some(e.to_string()),
            };
        }

        let file_path = out_dir.join(timestamp_filename());
        let screen_idx: usize = opts
            .source_id
            .strip_prefix("screen:")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];

        #[cfg(target_os = "macos")]
        {
            let (v_idx, a_idx) = resolve_avfoundation_indices(&ffmpeg, screen_idx, opts.mic);
            let input_spec = match a_idx {
                Some(a) => format!("{v_idx}:{a}"),
                None => format!("{v_idx}:none"),
            };
            args.extend([
                "-f".into(),
                "avfoundation".into(),
                "-framerate".into(),
                "30".into(),
                "-capture_cursor".into(),
                "1".into(),
                "-i".into(),
                input_spec,
            ]);
        }

        #[cfg(target_os = "linux")]
        {
            let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0.0".to_string());
            let _ = screen_idx;
            args.extend([
                "-f".into(),
                "x11grab".into(),
                "-framerate".into(),
                "30".into(),
                "-i".into(),
                display,
            ]);
            if opts.mic {
                args.extend(["-f".into(), "pulse".into(), "-i".into(), "default".into()]);
            }
        }

        #[cfg(target_os = "windows")]
        {
            let _ = screen_idx;
            args.extend([
                "-f".into(),
                "gdigrab".into(),
                "-framerate".into(),
                "30".into(),
                "-i".into(),
                "desktop".into(),
            ]);
        }

        args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);

        if opts.mic {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
        }

        args.extend([
            "-movflags".into(),
            "+faststart".into(),
            file_path.to_string_lossy().into(),
        ]);

        let child = match AsyncCommand::new(&ffmpeg)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return RecStartResult {
                    ok: false,
                    file_path: None,
                    error: Some(format!("Falha ao iniciar ffmpeg: {e}")),
                };
            }
        };

        let mut guard = self.active.lock().unwrap();
        *guard = Some(ActiveRecording {
            child,
            file_path: file_path.clone(),
        });

        RecStartResult {
            ok: true,
            file_path: Some(file_path.to_string_lossy().to_string()),
            error: None,
        }
    }

    pub async fn stop(&self, discard: bool) -> RecStopResult {
        let rec = { self.active.lock().unwrap().take() };
        let Some(mut rec) = rec else {
            return RecStopResult {
                ok: false,
                output_path: None,
                size_bytes: None,
                error: Some("Sem gravação ativa".to_string()),
            };
        };

        // Envia 'q' para o ffmpeg finalizar o contêiner MP4 (moov atom) limpo
        if let Some(mut stdin) = rec.child.stdin.take() {
            let _ = stdin.write_all(b"q\n").await;
            let _ = stdin.flush().await;
        }

        let _ = tokio::time::timeout(Duration::from_secs(6), rec.child.wait()).await;
        let _ = rec.child.kill().await;

        if discard {
            let _ = fs::remove_file(&rec.file_path);
            return RecStopResult {
                ok: false,
                output_path: None,
                size_bytes: None,
                error: Some("Gravação descartada".to_string()),
            };
        }

        match fs::metadata(&rec.file_path) {
            Ok(meta) if meta.len() > 0 => RecStopResult {
                ok: true,
                output_path: Some(rec.file_path.to_string_lossy().to_string()),
                size_bytes: Some(meta.len()),
                error: None,
            },
            _ => {
                let _ = fs::remove_file(&rec.file_path);
                RecStopResult {
                    ok: false,
                    output_path: None,
                    size_bytes: None,
                    error: Some("Gravação vazia (verifique permissão de Gravação de Tela no macOS)".to_string()),
                }
            }
        }
    }
}
