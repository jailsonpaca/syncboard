use std::collections::VecDeque;
use std::fs;
#[cfg(not(target_os = "linux"))]
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use clipboard_rs::common::RustImage;
use clipboard_rs::{Clipboard, ClipboardContext, RustImageData};
#[cfg(target_os = "linux")]
use clipboard_rs::ClipboardContextX11Options;
#[cfg(not(target_os = "linux"))]
use image::{DynamicImage, ImageFormat, RgbaImage};
use sha2::{Digest, Sha256};

/// Por quanto tempo uma escrita feita pelo próprio app (item vindo do remoto) é considerada eco.
const OWN_WRITE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub enum ClipboardCapture {
    Text {
        content: String,
        hash: String,
    },
    Image {
        png_bytes: Vec<u8>,
        hash: String,
    },
    File {
        path: PathBuf,
        filename: String,
        mime: String,
        size: i64,
        hash: String,
    },
}

impl ClipboardCapture {
    pub fn hash(&self) -> &str {
        match self {
            ClipboardCapture::Text { hash, .. }
            | ClipboardCapture::Image { hash, .. }
            | ClipboardCapture::File { hash, .. } => hash,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            ClipboardCapture::Text { .. } => "text",
            ClipboardCapture::Image { .. } => "image",
            ClipboardCapture::File { .. } => "file",
        }
    }
}

/// Decide quais mudanças da área de transferência local devem ser publicadas.
///
/// Regras:
/// - conteúdo igual ao último visto não é reenviado (evento repetido / leitura redundante);
/// - conteúdo que o próprio app acabou de escrever (item vindo do remoto) é eco e não volta
///   ao servidor; a marca é consumida na primeira observação;
/// - qualquer outra mudança é publicada, inclusive A → B → A.
pub struct ClipDedup {
    inner: Mutex<DedupState>,
}

#[derive(Default)]
struct DedupState {
    last_seen: Option<String>,
    own_writes: VecDeque<(String, Instant)>,
}

impl ClipDedup {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(DedupState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DedupState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Marca o conteúdo como já visto, sem publicar (ex.: estado inicial ao abrir o app).
    pub fn mark_seen(&self, hash: &str) {
        self.lock().last_seen = Some(hash.to_string());
    }

    /// Registra um conteúdo que o app vai escrever na área de transferência.
    pub fn note_own_write(&self, hash: &str) {
        let mut st = self.lock();
        let now = Instant::now();
        st.own_writes.retain(|(h, t)| h != hash && now.duration_since(*t) < OWN_WRITE_TTL);
        st.own_writes.push_back((hash.to_string(), now));
        while st.own_writes.len() > 8 {
            st.own_writes.pop_front();
        }
    }

    /// Observa uma captura local. Retorna `true` se ela deve ser publicada.
    pub fn observe(&self, hash: &str) -> bool {
        let mut st = self.lock();
        if st.last_seen.as_deref() == Some(hash) {
            return false;
        }
        st.last_seen = Some(hash.to_string());
        let now = Instant::now();
        st.own_writes.retain(|(_, t)| now.duration_since(*t) < OWN_WRITE_TTL);
        if let Some(pos) = st.own_writes.iter().position(|(h, _)| h == hash) {
            st.own_writes.remove(pos);
            return false;
        }
        true
    }

    pub fn last_seen(&self) -> Option<String> {
        self.lock().last_seen.clone()
    }

    /// Esquece o último visto se for `hash` (envio falhou: permite reenviar ao copiar de novo).
    pub fn forget(&self, hash: &str) {
        let mut st = self.lock();
        if st.last_seen.as_deref() == Some(hash) {
            st.last_seen = None;
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn hash_text(text: &str) -> String {
    sha256_hex(format!("text:{text}").as_bytes())
}

pub fn hash_image(png_bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"img:");
    hasher.update(png_bytes);
    hex::encode(hasher.finalize())
}

pub fn hash_file(path: &Path, size: u64, mtime_ms: u128) -> String {
    sha256_hex(format!("file:{}:{}:{}", path.display(), size, mtime_ms).as_bytes())
}

pub fn mime_from_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "m4v" => "video/x-m4v",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn is_media_filename(name: &str) -> bool {
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return false;
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "mp4"
            | "m4v"
            | "mov"
            | "mkv"
            | "webm"
            | "avi"
            | "mp3"
            | "wav"
            | "m4a"
            | "aac"
            | "pdf"
            | "zip"
            | "rar"
            | "7z"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "heic"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
    )
}

/// Resolve nomes soltos colocados na clipboard por WhatsApp/etc. em Downloads/Desktop/Documents ou Spotlight.
pub fn resolve_named_media_file(raw_name: &str) -> Option<PathBuf> {
    let clean = raw_name.trim().trim_start_matches("./");
    if !is_media_filename(clean) {
        return None;
    }

    if let Some(home) = dirs::home_dir() {
        for sub in ["Downloads", "Desktop", "Documents"] {
            let p = home.join(sub).join(clean);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let tmp = std::env::temp_dir().join(clean);
    if tmp.is_file() {
        return Some(tmp);
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("mdfind").args(["-name", clean]).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let mut hits: Vec<PathBuf> = text
                    .lines()
                    .map(|l| PathBuf::from(l.trim()))
                    .filter(|p| {
                        p.is_file()
                            && p.file_name().and_then(|n| n.to_str()) == Some(clean)
                    })
                    .collect();
                hits.sort_by_key(|p| {
                    std::cmp::Reverse(
                        fs::metadata(p)
                            .and_then(|m| m.modified())
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis())
                            .unwrap_or(0),
                    )
                });
                if let Some(best) = hits.into_iter().next() {
                    return Some(best);
                }
            }
        }
    }

    None
}

fn file_url_to_path(raw: &str) -> Option<PathBuf> {
    let s = raw.trim().trim_matches('\0');
    let stripped = s
        .strip_prefix("file://localhost")
        .or_else(|| s.strip_prefix("file://"))?;
    let first = stripped.split(['\t', '\n', '\r']).next()?;
    let decoded = urlencoding::decode(first).ok()?;
    let p = PathBuf::from(decoded.as_ref());
    p.is_file().then_some(p)
}

#[cfg(not(target_os = "linux"))]
fn image_to_png_bytes(img: RustImageData) -> Option<Vec<u8>> {
    if let Ok(buf) = img.to_png() {
        let bytes = buf.get_bytes().to_vec();
        if !bytes.is_empty() {
            return Some(bytes);
        }
    }
    let rgba = img.to_rgba8().ok()?;
    let (w, h) = rgba.dimensions();
    let raw = rgba.into_raw();
    let img_buf = RgbaImage::from_raw(w, h, raw)?;
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(img_buf)
        .write_to(&mut out, ImageFormat::Png)
        .ok()?;
    Some(out.into_inner())
}

fn is_screenshot_path(path: &Path) -> bool {
    let s = path.to_string_lossy().to_lowercase();
    s.contains("screenshot") || s.contains("captura de tela") || s.contains("/desktop/")
}

/// Lê o conteúdo atual da área de transferência do SO de forma nativa (sem osascript).
pub fn read_system_clipboard() -> Option<ClipboardCapture> {
    #[cfg(target_os = "linux")]
    {
        if let Some(cap) = read_linux_wayland_fallback() {
            return Some(cap);
        }
    }

    // Linux/X11: pergunta primeiro quais formatos existem (TARGETS) e só lê os presentes.
    // Uma única ida e volta barata; se o dono da seleção não responde, paga-se um só timeout
    // (antes eram 3 leituras de 4 s em série). O erro de TARGETS também é propagado, o que
    // permite detectar conexão X morta (get_files/get_image da lib engolem erros).
    #[cfg(target_os = "linux")]
    let res = with_clipboard(|ctx| {
        let formats = ctx.available_formats()?;
        Ok(read_from_context(ctx, &Avail::from_targets(&formats)))
    });
    #[cfg(not(target_os = "linux"))]
    let res = with_clipboard(|ctx| Ok(read_from_context(ctx, &Avail::all())));

    res.map_err(|e| tracing::debug!("[clipboard] leitura indisponível: {e}"))
        .ok()
        .flatten()
}

/// Quais formatos vale a pena tentar ler.
struct Avail {
    files: bool,
    image: bool,
    text: bool,
}

impl Avail {
    #[cfg(not(target_os = "linux"))]
    fn all() -> Self {
        Self { files: true, image: true, text: true }
    }

    #[cfg(target_os = "linux")]
    fn from_targets(targets: &[String]) -> Self {
        let has = |names: &[&str]| targets.iter().any(|t| names.contains(&t.as_str()));
        Self {
            files: has(&["text/uri-list"]),
            image: has(&["image/png"]),
            text: has(&["UTF8_STRING", "STRING", "TEXT", "text/plain", "text/plain;charset=utf-8"]),
        }
    }
}

fn read_from_context(ctx: &ClipboardContext, avail: &Avail) -> Option<ClipboardCapture> {
    // 1. Verifica arquivos copiados (Finder / Nautilus / Explorer)
    let files: Vec<PathBuf> = avail
        .files
        .then(|| ctx.get_files().unwrap_or_default())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|s| {
            let trimmed = s.trim();
            if trimmed.starts_with("file:") {
                file_url_to_path(trimmed)
            } else {
                let p = PathBuf::from(trimmed);
                p.is_file().then_some(p)
            }
        })
        .collect();

    // 2. Se for screenshot no macOS, prioriza bitmap estável da clipboard (evita oscilar path)
    if let Some(first) = files.first() {
        let is_img_file = mime_from_path(first).starts_with("image/");
        if !(is_img_file && is_screenshot_path(first)) {
            if let Ok(meta) = fs::metadata(first) {
                let size = meta.len();
                if size > 0 && size <= syncboard_core::models::MAX_FILE_UPLOAD_BYTES as u64 {
                    let mtime_ms = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let filename = first
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("file")
                        .to_string();
                    let mime = mime_from_path(first).to_string();
                    let hash = hash_file(first, size, mtime_ms);
                    return Some(ClipboardCapture::File {
                        path: first.clone(),
                        filename,
                        mime,
                        size: size as i64,
                        hash,
                    });
                }
            }
        }
    }

    // 3. Imagem (bitmap na clipboard)
    // Linux/X11: o alvo image/png já é PNG; usa os bytes direto em vez de decodificar e
    // recodificar (uma captura 4K custava segundos de CPU e travava a fila do watcher).
    #[cfg(target_os = "linux")]
    if let Some(Ok(png_bytes)) = avail.image.then(|| ctx.get_buffer("image/png")) {
        if png_bytes.len() > 100 && png_bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            let hash = hash_image(&png_bytes);
            return Some(ClipboardCapture::Image { png_bytes, hash });
        }
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(Ok(img)) = avail.image.then(|| ctx.get_image()) {
        if let Some(png_bytes) = image_to_png_bytes(img) {
            if png_bytes.len() > 100 {
                let hash = hash_image(&png_bytes);
                return Some(ClipboardCapture::Image { png_bytes, hash });
            }
        }
    }

    // 4. Texto (incluindo resolução de path ou nome de mídia do WhatsApp)
    if let Some(Ok(raw_text)) = avail.text.then(|| ctx.get_text()) {
        let trimmed = raw_text.trim();
        if trimmed.is_empty() {
            return None;
        }

        if !trimmed.contains('\n') && trimmed.len() < 1024 {
            let resolved_file = if trimmed.starts_with("file:") {
                file_url_to_path(trimmed)
            } else if trimmed.starts_with('/') {
                let p = PathBuf::from(trimmed);
                p.is_file().then_some(p)
            } else {
                resolve_named_media_file(trimmed)
            };

            if let Some(path) = resolved_file {
                if let Ok(meta) = fs::metadata(&path) {
                    let size = meta.len();
                    if size > 0 && size <= syncboard_core::models::MAX_FILE_UPLOAD_BYTES as u64 {
                        let mtime_ms = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis())
                            .unwrap_or(0);
                        let filename = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("file")
                            .to_string();
                        let mime = mime_from_path(&path).to_string();
                        let hash = hash_file(&path, size, mtime_ms);
                        return Some(ClipboardCapture::File {
                            path,
                            filename,
                            mime,
                            size: size as i64,
                            hash,
                        });
                    }
                }
            }
        }

        let hash = hash_text(trimmed);
        return Some(ClipboardCapture::Text {
            content: raw_text,
            hash,
        });
    }

    None
}

#[cfg(target_os = "linux")]
fn read_linux_wayland_fallback() -> Option<ClipboardCapture> {
    let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE").ok().as_deref() == Some("wayland");
    if !is_wayland {
        return None;
    }
    let targets_out = Command::new("wl-paste").arg("-l").output().ok()?;
    if !targets_out.status.success() {
        return None;
    }
    let targets: Vec<String> = String::from_utf8_lossy(&targets_out.stdout)
        .lines()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty())
        .collect();

    if let Some(img_mime) = ["image/png", "image/jpeg", "image/webp"]
        .iter()
        .find(|m| targets.iter().any(|t| t == *m))
    {
        if let Ok(out) = Command::new("wl-paste").args(["-t", img_mime]).output() {
            if out.status.success() && out.stdout.len() > 100 {
                let hash = hash_image(&out.stdout);
                return Some(ClipboardCapture::Image {
                    png_bytes: out.stdout,
                    hash,
                });
            }
        }
    }

    if targets
        .iter()
        .any(|t| t == "text/uri-list" || t == "x-special/gnome-copied-files")
    {
        if let Ok(out) = Command::new("wl-paste").args(["-t", "text/uri-list"]).output() {
            if out.status.success() {
                let raw = String::from_utf8_lossy(&out.stdout);
                for line in raw.lines() {
                    if let Some(p) = file_url_to_path(line) {
                        if let Ok(meta) = fs::metadata(&p) {
                            let size = meta.len();
                            if size > 0 {
                                let mtime_ms = meta
                                    .modified()
                                    .ok()
                                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                    .map(|d| d.as_millis())
                                    .unwrap_or(0);
                                let filename = p
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("file")
                                    .to_string();
                                let mime = mime_from_path(&p).to_string();
                                let hash = hash_file(&p, size, mtime_ms);
                                return Some(ClipboardCapture::File {
                                    path: p,
                                    filename,
                                    mime,
                                    size: size as i64,
                                    hash,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    if let Ok(out) = Command::new("wl-paste").arg("-n").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            if !text.trim().is_empty() {
                let hash = hash_text(text.trim());
                return Some(ClipboardCapture::Text { content: text, hash });
            }
        }
    }

    None
}

pub fn write_clipboard_text(text: &str) -> Result<(), String> {
    with_clipboard(|ctx| ctx.set_text(text.to_string()))
}

pub fn write_clipboard_image(bytes: &[u8]) -> Result<(), String> {
    let img = RustImageData::from_bytes(bytes).map_err(|e| e.to_string())?;
    with_clipboard(move |ctx| ctx.set_image(img))
}

pub fn write_clipboard_files(paths: &[PathBuf]) -> Result<(), String> {
    let valid: Vec<String> = paths
        .iter()
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    if valid.is_empty() {
        return Err("Nenhum arquivo válido".to_string());
    }
    with_clipboard(move |ctx| ctx.set_files(valid))
}

/// Executa uma operação na área de transferência do SO.
///
/// Linux/X11: usa UM `ClipboardContext` de vida longa para o processo inteiro.
/// Na clipboard-rs 0.2.x cada `ClipboardContext::new()` abre 2 conexões X, 2 janelas e uma
/// thread que nunca termina (não há `Drop`). Criar um contexto por operação esgotava o limite
/// de clientes do servidor X ("Maximum number of clients reached") em poucos minutos, o que
/// parava a sincronização e derrubava o app quando o WebKit tentava abrir um processo novo.
/// O contexto vivo também mantém a posse da seleção depois de escrever.
#[cfg(target_os = "linux")]
fn with_clipboard<R>(
    f: impl FnOnce(&ClipboardContext) -> clipboard_rs::common::Result<R>,
) -> Result<R, String> {
    linux_ctx::with_context(f)
}

#[cfg(not(target_os = "linux"))]
fn with_clipboard<R>(
    f: impl FnOnce(&ClipboardContext) -> clipboard_rs::common::Result<R>,
) -> Result<R, String> {
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    f(&ctx).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
mod linux_ctx {
    use super::*;

    /// Leitura de imagens grandes via INCR passa fácil dos 500 ms padrão da clipboard-rs.
    const READ_TIMEOUT: Duration = Duration::from_secs(4);
    /// Cada recriação vaza o contexto anterior (limitação da lib), então é rara e limitada.
    const MIN_RECREATE_INTERVAL: Duration = Duration::from_secs(30);

    struct Slot {
        ctx: Option<ClipboardContext>,
        broken: bool,
        last_create: Option<Instant>,
        creations: u64,
    }

    static SLOT: Mutex<Slot> = Mutex::new(Slot {
        ctx: None,
        broken: false,
        last_create: None,
        creations: 0,
    });

    // Garante em tempo de compilação que o contexto pode ser compartilhado entre threads.
    const _: () = {
        fn assert_send<T: Send>() {}
        let _ = assert_send::<ClipboardContext>;
    };

    /// Erros de conexão X (socket fechado, servidor reiniciado) tornam o contexto inútil.
    fn is_connection_error(e: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
        use x11rb::errors::{ConnectionError, ReplyError, ReplyOrIdError};
        if e.downcast_ref::<ConnectionError>().is_some() {
            return true;
        }
        if let Some(ReplyError::ConnectionError(_)) = e.downcast_ref::<ReplyError>() {
            return true;
        }
        matches!(
            e.downcast_ref::<ReplyOrIdError>(),
            Some(ReplyOrIdError::ConnectionError(_))
        )
    }

    pub(super) fn with_context<R>(
        f: impl FnOnce(&ClipboardContext) -> clipboard_rs::common::Result<R>,
    ) -> Result<R, String> {
        let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());

        if slot.ctx.is_none() || slot.broken {
            if let Some(t) = slot.last_create {
                if t.elapsed() < MIN_RECREATE_INTERVAL {
                    return Err("contexto X11 indisponível; nova tentativa em instantes".into());
                }
            }
            slot.last_create = Some(Instant::now());
            match ClipboardContext::new_with_options(ClipboardContextX11Options {
                read_timeout: Some(READ_TIMEOUT),
            }) {
                Ok(ctx) => {
                    slot.creations += 1;
                    if slot.creations > 1 {
                        tracing::warn!(
                            "[clipboard] contexto X11 recriado (#{}) após erro de conexão",
                            slot.creations
                        );
                    } else {
                        tracing::info!("[clipboard] contexto X11 criado");
                    }
                    // O contexto antigo (se houver) fica vazado de propósito: a lib não o libera.
                    if let Some(old) = slot.ctx.replace(ctx) {
                        std::mem::forget(old);
                    }
                    slot.broken = false;
                }
                Err(e) => {
                    tracing::error!("[clipboard] não foi possível conectar no X11: {e}");
                    return Err(e.to_string());
                }
            }
        }

        let Some(ctx) = slot.ctx.as_ref() else {
            return Err("contexto X11 ausente".into());
        };
        match f(ctx) {
            Ok(v) => Ok(v),
            Err(e) => {
                if is_connection_error(e.as_ref()) {
                    tracing::warn!("[clipboard] erro de conexão X11: {e}");
                    slot.broken = true;
                }
                Err(e.to_string())
            }
        }
    }
}

pub fn copy_to_public_inbox(src: &Path, filename: &str) -> Result<PathBuf, String> {
    let downloads = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(std::env::temp_dir);
    let inbox = downloads.join("SyncBoard");
    fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;

    let safe_name: String = filename
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '_',
            other => other,
        })
        .collect();
    let safe_name = if safe_name.is_empty() {
        "arquivo".to_string()
    } else {
        safe_name
    };

    let dst = inbox.join(&safe_name);
    fs::copy(src, &dst).map_err(|e| e.to_string())?;
    Ok(dst)
}

pub fn reveal_file_in_folder(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path.to_string_lossy()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        let dir = path.parent().unwrap_or(path);
        Command::new("xdg-open")
            .arg(dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path.to_string_lossy()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

pub fn simulate_paste() -> bool {
    #[cfg(target_os = "macos")]
    {
        Command::new("osascript")
            .args([
                "-e",
                "delay 0.12",
                "-e",
                r#"tell application "System Events" to keystroke "v" using command down"#,
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        for (bin, args) in [
            ("xdotool", vec!["key", "--clearmodifiers", "ctrl+v"]),
            ("wtype", vec!["-M", "ctrl", "v", "-m", "ctrl"]),
            ("ydotool", vec!["key", "29:1", "47:1", "47:0", "29:0"]),
        ] {
            if let Ok(st) = Command::new(bin).args(&args).status() {
                if st.success() {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('^v')",
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

pub async fn simulate_paste_with_retry(attempts: usize) -> bool {
    for i in 0..attempts {
        let ok = tokio::task::spawn_blocking(simulate_paste)
            .await
            .unwrap_or(false);
        if ok {
            return true;
        }
        if i + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_a_b_a_publishes_three_times() {
        let d = ClipDedup::new();
        assert!(d.observe("A"));
        assert!(d.observe("B"));
        assert!(d.observe("A"), "A depois de B deve ser reenviado");
    }

    #[test]
    fn dedup_same_content_is_not_resent() {
        let d = ClipDedup::new();
        assert!(d.observe("A"));
        assert!(!d.observe("A"));
        assert!(!d.observe("A"));
    }

    #[test]
    fn dedup_initial_content_is_not_sent() {
        let d = ClipDedup::new();
        d.mark_seen("X");
        assert!(!d.observe("X"));
        assert!(d.observe("Y"));
    }

    #[test]
    fn dedup_own_write_is_not_echoed_but_later_copy_is_sent() {
        let d = ClipDedup::new();
        assert!(d.observe("A"));
        d.note_own_write("R"); // item vindo do Mac
        assert!(!d.observe("R"), "eco do que o app escreveu");
        assert!(d.observe("B"));
        assert!(d.observe("R"), "copiar R de novo depois é uma cópia real");
    }

    #[test]
    fn dedup_forget_allows_retry_of_same_content() {
        let d = ClipDedup::new();
        assert!(d.observe("A"));
        d.forget("A");
        assert!(d.observe("A"));
    }

    #[test]
    fn hash_text_is_deterministic() {
        assert_eq!(hash_text("abc"), hash_text("abc"));
        assert_ne!(hash_text("abc"), hash_text("def"));
    }
}
