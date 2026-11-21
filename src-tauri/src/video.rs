use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;

const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
    "/opt/local/bin",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegCheck {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOpts {
    pub input: String,
    pub preset: Option<String>,
    #[serde(rename = "maxMB")]
    pub max_mb: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

struct ActiveJob {
    pid: Option<u32>,
    cancelled: bool,
}

#[derive(Default)]
pub struct VideoConverter {
    active: Mutex<Option<Arc<Mutex<ActiveJob>>>>,
}

pub fn find_binary(name: &str) -> Option<PathBuf> {
    if let Ok(env_path) = std::env::var("FFMPEG_PATH") {
        let p = PathBuf::from(&env_path);
        if p.is_dir() {
            let cand = p.join(name);
            if cand.is_file() {
                return Some(cand);
            }
        } else if name == "ffmpeg" && p.is_file() {
            return Some(p);
        } else if name == "ffprobe" {
            if let Some(parent) = p.parent() {
                let cand = parent.join("ffprobe");
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }

    let bin_name = if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    for dir in EXTRA_DIRS {
        let cand = Path::new(dir).join(&bin_name);
        if cand.is_file() {
            return Some(cand);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let cand = dir.join(&bin_name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }

    None
}

fn install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Instale o ffmpeg: brew install ffmpeg"
    } else if cfg!(target_os = "windows") {
        "Instale o ffmpeg: winget install Gyan.FFmpeg"
    } else {
        "Instale o ffmpeg: sudo apt install ffmpeg"
    }
}

pub fn check_ffmpeg() -> FfmpegCheck {
    let Some(ffmpeg) = find_binary("ffmpeg") else {
        return FfmpegCheck {
            ok: false,
            path: None,
            version: None,
            error: Some(format!("ffmpeg não encontrado. {}", install_hint())),
        };
    };

    let version = Command::new(&ffmpeg)
        .arg("-version")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|s| s.to_string())
        });

    FfmpegCheck {
        ok: true,
        path: Some(ffmpeg.to_string_lossy().to_string()),
        version,
        error: None,
    }
}

fn probe_duration(ffmpeg: &Path, input: &Path) -> Option<f64> {
    if let Some(ffprobe) = find_binary("ffprobe") {
        if let Ok(out) = Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                &input.to_string_lossy(),
            ])
            .output()
        {
            if let Ok(d) = String::from_utf8_lossy(&out.stdout).trim().parse::<f64>() {
                if d.is_finite() && d > 0.0 {
                    return Some(d);
                }
            }
        }
    }

    if let Ok(out) = Command::new(ffmpeg)
        .args(["-hide_banner", "-i", &input.to_string_lossy()])
        .output()
    {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if let Some(pos) = stderr.find("Duration:") {
            let slice = &stderr[pos + 9..];
            let token = slice.split(',').next().unwrap_or("").trim();
            let parts: Vec<&str> = token.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                let total = h * 3600.0 + m * 60.0 + s;
                if total > 0.0 {
                    return Some(total);
                }
            }
        }
    }
    None
}

fn unique_output_path(input: &Path) -> PathBuf {
    let dir = input.parent().unwrap_or_else(|| Path::new("."));
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let mut cand = dir.join(format!("{stem}-whatsapp.mp4"));
    let mut i = 2;
    while cand.exists() {
        cand = dir.join(format!("{stem}-whatsapp-{i}.mp4"));
        i += 1;
    }
    cand
}

impl VideoConverter {
    pub fn cancel(&self) -> bool {
        let guard = self.active.lock().unwrap();
        let Some(job) = guard.as_ref() else {
            return false;
        };
        let mut j = job.lock().unwrap();
        j.cancelled = true;
        if let Some(pid) = j.pid {
            #[cfg(unix)]
            let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
            #[cfg(windows)]
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status();
        }
        true
    }

    pub async fn convert(&self, app: &AppHandle, opts: ConvertOpts) -> ConvertResult {
        let input = PathBuf::from(&opts.input);
        if !input.is_file() {
            return ConvertResult {
                ok: false,
                output_path: None,
                size_bytes: None,
                error: Some("Arquivo não encontrado".to_string()),
                cancelled: None,
            };
        }

        let Some(ffmpeg) = find_binary("ffmpeg") else {
            return ConvertResult {
                ok: false,
                output_path: None,
                size_bytes: None,
                error: Some(format!("ffmpeg não encontrado. {}", install_hint())),
                cancelled: None,
            };
        };

        let job = Arc::new(Mutex::new(ActiveJob {
            pid: None,
            cancelled: false,
        }));
        {
            let mut active = self.active.lock().unwrap();
            if active.is_some() {
                return ConvertResult {
                    ok: false,
                    output_path: None,
                    size_bytes: None,
                    error: Some("Já existe uma conversão em andamento".to_string()),
                    cancelled: None,
                };
            }
            *active = Some(Arc::clone(&job));
        }

        let (height, crf, audio_kbps) = match opts.preset.as_deref() {
            Some("light") => (480, "28", 96),
            Some("high") => (1080, "21", 128),
            _ => (720, "23", 128),
        };
        let max_mb = opts.max_mb.filter(|v| *v > 0.0);
        let duration = probe_duration(&ffmpeg, &input);
        if max_mb.is_some() && duration.is_none() {
            *self.active.lock().unwrap() = None;
            return ConvertResult {
                ok: false,
                output_path: None,
                size_bytes: None,
                error: Some(
                    "Não foi possível ler a duração do vídeo para respeitar o limite de tamanho"
                        .to_string(),
                ),
                cancelled: None,
            };
        }

        let output = unique_output_path(&input);
        let partial = PathBuf::from(format!("{}.part", output.display()));
        let pass_log = std::env::temp_dir().join(format!(
            "syncboard-ffpass-{}-{}",
            std::process::id(),
            syncboard_core::models::now_millis()
        ));

        let vf = format!("scale=-2:'min({height},ih)',format=yuv420p");
        let common: Vec<String> = vec![
            "-hide_banner".into(),
            "-nostdin".into(),
            "-y".into(),
            "-i".into(),
            input.to_string_lossy().into(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "0:a:0?".into(),
            "-sn".into(),
            "-dn".into(),
            "-vf".into(),
            vf,
        ];
        let video: Vec<String> = vec![
            "-c:v".into(),
            "libx264".into(),
            "-profile:v".into(),
            "main".into(),
            "-preset".into(),
            "medium".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ];
        let audio: Vec<String> = vec![
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            format!("{audio_kbps}k"),
            "-ac".into(),
            "2".into(),
        ];
        let progress_flags: Vec<String> = vec!["-progress".into(), "pipe:1".into(), "-nostats".into()];

        let run_res: Result<(), (String, bool)> = async {
            if let (Some(limit_mb), Some(dur)) = (max_mb, duration) {
                let total_kbps = (limit_mb * 8192.0 * 0.95) / dur;
                let video_kbps = (total_kbps - audio_kbps as f64).floor() as i64;
                if video_kbps < 80 {
                    return Err((
                        format!("Vídeo longo demais para {limit_mb} MB (bitrate inviável). Aumente o limite."),
                        false,
                    ));
                }
                let rate: Vec<String> = vec![
                    "-b:v".into(),
                    format!("{video_kbps}k"),
                    "-maxrate".into(),
                    format!("{}k", (video_kbps as f64 * 1.5).floor() as i64),
                    "-bufsize".into(),
                    format!("{}k", video_kbps * 2),
                ];
                let null_sink = if cfg!(target_os = "windows") {
                    "NUL"
                } else {
                    "/dev/null"
                };

                let mut pass1 = Vec::new();
                pass1.extend(common.clone());
                pass1.extend(video.clone());
                pass1.extend(rate.clone());
                pass1.extend([
                    "-pass".into(),
                    "1".into(),
                    "-passlogfile".into(),
                    pass_log.to_string_lossy().into(),
                    "-an".into(),
                    "-f".into(),
                    "null".into(),
                    null_sink.into(),
                ]);
                pass1.extend(progress_flags.clone());
                run_ffmpeg_pass(&ffmpeg, &pass1, Some(dur), &job, app, 0.0, 50.0).await?;

                let mut pass2 = Vec::new();
                pass2.extend(common);
                pass2.extend(video);
                pass2.extend(rate);
                pass2.extend([
                    "-pass".into(),
                    "2".into(),
                    "-passlogfile".into(),
                    pass_log.to_string_lossy().into(),
                ]);
                pass2.extend(audio);
                pass2.extend([
                    "-movflags".into(),
                    "+faststart".into(),
                    "-f".into(),
                    "mp4".into(),
                    partial.to_string_lossy().into(),
                ]);
                pass2.extend(progress_flags);
                run_ffmpeg_pass(&ffmpeg, &pass2, Some(dur), &job, app, 50.0, 50.0).await?;
            } else {
                let mut args = Vec::new();
                args.extend(common);
                args.extend(video);
                args.extend(["-crf".into(), crf.into()]);
                args.extend(audio);
                args.extend([
                    "-movflags".into(),
                    "+faststart".into(),
                    "-f".into(),
                    "mp4".into(),
                    partial.to_string_lossy().into(),
                ]);
                args.extend(progress_flags);
                run_ffmpeg_pass(&ffmpeg, &args, duration, &job, app, 0.0, 100.0).await?;
            }
            Ok(())
        }
        .await;

        *self.active.lock().unwrap() = None;

        // Limpa logs do 2-pass
        if let Some(prefix) = pass_log.file_name().and_then(|s| s.to_str()) {
            if let Ok(entries) = fs::read_dir(std::env::temp_dir()) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(prefix) {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }

        match run_res {
            Ok(()) => {
                if let Err(e) = fs::rename(&partial, &output) {
                    let _ = fs::remove_file(&partial);
                    return ConvertResult {
                        ok: false,
                        output_path: None,
                        size_bytes: None,
                        error: Some(e.to_string()),
                        cancelled: None,
                    };
                }
                let _ = app.emit("video-progress", serde_json::json!({ "percent": 100 }));
                let size_bytes = fs::metadata(&output).map(|m| m.len()).ok();
                ConvertResult {
                    ok: true,
                    output_path: Some(output.to_string_lossy().to_string()),
                    size_bytes,
                    error: None,
                    cancelled: None,
                }
            }
            Err((msg, cancelled)) => {
                let _ = fs::remove_file(&partial);
                ConvertResult {
                    ok: false,
                    output_path: None,
                    size_bytes: None,
                    error: Some(msg),
                    cancelled: cancelled.then_some(true),
                }
            }
        }
    }
}

async fn run_ffmpeg_pass(
    ffmpeg: &Path,
    args: &[String],
    duration: Option<f64>,
    job: &Arc<Mutex<ActiveJob>>,
    app: &AppHandle,
    offset: f64,
    weight: f64,
) -> Result<(), (String, bool)> {
    let mut child = AsyncCommand::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| (e.to_string(), false))?;

    {
        let mut j = job.lock().unwrap();
        j.pid = child.id();
    }

    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if let Some(val) = trimmed
                .strip_prefix("out_time_us=")
                .or_else(|| trimmed.strip_prefix("out_time_ms="))
            {
                if let (Ok(us), Some(dur)) = (val.parse::<f64>(), duration) {
                    let frac = (us / 1_000_000.0 / dur).clamp(0.0, 1.0);
                    let pct = (offset + frac * weight).round() as i64;
                    let _ = app.emit("video-progress", serde_json::json!({ "percent": pct }));
                }
            }
        }
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| (e.to_string(), false))?;

    if job.lock().unwrap().cancelled {
        return Err(("Conversão cancelada".to_string(), true));
    }
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let last = stderr
        .trim()
        .lines()
        .last()
        .unwrap_or("ffmpeg falhou")
        .to_string();
    Err((last, false))
}
