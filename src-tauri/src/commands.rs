use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use syncboard_core::models::{ClipItem, ItemType};
use syncboard_core::pair::{
    discover_by_code, discover_servers as core_discover_servers, get_local_ip, parse_join_payload,
};
use syncboard_core::store::CreateItemInput;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::clipboard::{mime_from_path, reveal_file_in_folder};
use crate::config::{
    format_hotkey_display, normalize_hotkey, save_config as persist_config, to_tauri_shortcut,
};
use crate::recorder::{
    get_status as rec_get_status, list_sources as rec_list_sources,
    open_privacy_settings as rec_open_privacy_os, RecSourcesResult, RecStartOpts, RecStartResult,
    RecStatus, RecStopResult,
};
use crate::state::AppShared;
use crate::sync::{
    apply_remote_item_to_clipboard, paste_item_into_focus, restart_network_services, PasteResult,
};
use crate::tray::refresh_tray_menu;
use crate::video::{check_ffmpeg, ConvertOpts, ConvertResult, FfmpegCheck};
use crate::windows::toggle_compact_window;

#[tauri::command]
pub fn get_config(shared: State<'_, Arc<AppShared>>) -> serde_json::Value {
    let cfg = shared.get_config();
    serde_json::json!({
        "serverUrl": cfg.server_url,
        "runLocalServer": cfg.run_local_server,
        "deviceName": cfg.device_name,
        "autoSync": cfg.auto_sync,
        "launchAtLogin": cfg.launch_at_login,
        "autoUpdate": cfg.auto_update,
        "port": cfg.port,
        "hotkey": cfg.hotkey,
        "hotkeyDisplay": format_hotkey_display(&cfg.hotkey),
        "localIp": get_local_ip(),
        "appVersion": env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConfigInput {
    pub run_local_server: Option<bool>,
    pub port: Option<u16>,
    pub server_url: Option<String>,
    pub device_name: Option<String>,
    pub auto_sync: Option<bool>,
    pub auto_update: Option<bool>,
    pub launch_at_login: Option<bool>,
    pub hotkey: Option<String>,
}

#[tauri::command]
pub async fn save_config(
    app: AppHandle,
    shared: State<'_, Arc<AppShared>>,
    cfg: SaveConfigInput,
) -> Result<serde_json::Value, String> {
    let prev = shared.get_config();
    let mut next = prev.clone();

    if let Some(v) = cfg.run_local_server {
        next.run_local_server = v;
    }
    if let Some(p) = cfg.port {
        if p >= 1024 {
            next.port = p;
        }
    }
    if let Some(url) = cfg.server_url {
        let trimmed = url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            next.server_url = trimmed;
        }
    }
    if next.run_local_server {
        next.server_url = format!("http://127.0.0.1:{}", next.port);
    }
    if let Some(name) = cfg.device_name {
        let trimmed = name.trim().to_string();
        if !trimmed.is_empty() {
            next.device_name = trimmed;
        }
    }
    if let Some(v) = cfg.auto_sync {
        next.auto_sync = v;
    }
    if let Some(v) = cfg.auto_update {
        next.auto_update = v;
    }
    if let Some(v) = cfg.launch_at_login {
        next.launch_at_login = v;
        let auto = app.autolaunch();
        if v {
            let _ = auto.enable();
        } else {
            let _ = auto.disable();
        }
    }
    if let Some(hk) = cfg.hotkey {
        let norm = normalize_hotkey(&hk);
        if norm != prev.hotkey {
            let _ = register_global_hotkey(&app, &prev.hotkey, &norm);
            next.hotkey = norm;
        }
    }

    *shared.config.lock().unwrap() = next.clone();
    persist_config(&shared.config_path, &next)?;

    if next.run_local_server != prev.run_local_server
        || next.port != prev.port
        || next.server_url != prev.server_url
    {
        restart_network_services(app.clone(), Arc::clone(&shared)).await;
    } else {
        refresh_tray_menu(&app, &shared);
    }

    Ok(serde_json::json!({ "ok": true }))
}

pub fn register_global_hotkey(app: &AppHandle, old_hotkey: &str, new_hotkey: &str) -> Result<String, String> {
    let gs = app.global_shortcut();
    if !old_hotkey.is_empty() {
        let _ = gs.unregister(to_tauri_shortcut(old_hotkey).as_str());
    }
    let norm = normalize_hotkey(new_hotkey);
    let tauri_hk = to_tauri_shortcut(&norm);
    let app_c = app.clone();
    gs.on_shortcut(tauri_hk.as_str(), move |_app, _shortcut, event| {
        if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
            toggle_compact_window(&app_c);
        }
    })
    .map_err(|e| format!("Atalho em uso ou inválido: {e}"))?;
    Ok(norm)
}

#[tauri::command]
pub fn test_hotkey(app: AppHandle, shared: State<'_, Arc<AppShared>>, hotkey: String) -> serde_json::Value {
    let norm = normalize_hotkey(&hotkey);
    let current = shared.get_config().hotkey;
    if norm == current {
        return serde_json::json!({ "ok": true, "hotkey": norm });
    }
    let tauri_hk = to_tauri_shortcut(&norm);
    let gs = app.global_shortcut();
    match gs.register(tauri_hk.as_str()) {
        Ok(()) => {
            let _ = gs.unregister(tauri_hk.as_str());
            serde_json::json!({ "ok": true, "hotkey": norm })
        }
        Err(e) => serde_json::json!({ "ok": false, "hotkey": norm, "error": format!("Atalho inválido ou em uso: {e}") }),
    }
}

#[tauri::command]
pub async fn paste_item(
    app: AppHandle,
    shared: State<'_, Arc<AppShared>>,
    item: ClipItem,
) -> Result<PasteResult, String> {
    Ok(paste_item_into_focus(&app, &shared, item).await)
}

#[tauri::command]
pub async fn apply_remote_item(
    shared: State<'_, Arc<AppShared>>,
    item: ClipItem,
) -> Result<serde_json::Value, String> {
    Ok(match apply_remote_item_to_clipboard(&shared, &item).await {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    })
}

#[tauri::command]
pub async fn discover_servers() -> serde_json::Value {
    let servers = core_discover_servers(Duration::from_millis(3500)).await;
    serde_json::json!({ "ok": true, "servers": servers })
}

#[tauri::command]
pub async fn join_with_code(
    app: AppHandle,
    shared: State<'_, Arc<AppShared>>,
    code: String,
) -> Result<serde_json::Value, String> {
    let Some(parsed) = parse_join_payload(&code) else {
        return Ok(serde_json::json!({ "ok": false, "error": "Código ou URL inválido" }));
    };

    let server_url = if let Some(url) = parsed.server_url {
        url
    } else if let Some(c) = parsed.code {
        match discover_by_code(&c, Duration::from_secs(5)).await {
            Ok(hit) => hit.server_url,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
        }
    } else {
        return Ok(serde_json::json!({ "ok": false, "error": "Código inválido" }));
    };

    {
        let mut cfg = shared.config.lock().unwrap();
        cfg.run_local_server = false;
        cfg.server_url = server_url.clone();
        let _ = persist_config(&shared.config_path, &cfg);
    }
    restart_network_services(app, Arc::clone(&shared)).await;
    Ok(serde_json::json!({ "ok": true, "serverUrl": server_url }))
}

#[tauri::command]
pub async fn check_update(shared: State<'_, Arc<AppShared>>) -> Result<serde_json::Value, String> {
    let st = shared.updater.get_status(true).await;
    Ok(serde_json::json!({
        "ok": true,
        "updateAvailable": st.update_available,
        "version": st.latest,
        "releaseNotes": st.release_notes,
        "downloaded": false,
        "fallbackUrl": st.download_page,
    }))
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    shared: State<'_, Arc<AppShared>>,
) -> Result<serde_json::Value, String> {
    let st = shared.updater.get_status(false).await;
    let url = st
        .download_page
        .unwrap_or_else(|| "https://syncboard.jpinnovation.com.br".to_string());
    let _ = app.opener().open_url(&url, None::<&str>);
    Ok(serde_json::json!({ "ok": true, "fallbackUrl": url }))
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    shared: State<'_, Arc<AppShared>>,
) -> Result<serde_json::Value, String> {
    download_update(app, shared).await
}

#[tauri::command]
pub async fn get_update_notes(
    shared: State<'_, Arc<AppShared>>,
) -> Result<serde_json::Value, String> {
    let st = shared.updater.get_status(false).await;
    Ok(serde_json::json!({
        "ok": true,
        "version": st.latest,
        "releaseNotes": st.release_notes.unwrap_or_default(),
    }))
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> serde_json::Value {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return serde_json::json!({ "ok": false, "error": "URL inválida" });
    }
    match app.opener().open_url(&url, None::<&str>) {
        Ok(()) => serde_json::json!({ "ok": true, "url": url }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string(), "url": url }),
    }
}

#[tauri::command]
pub fn video_check() -> FfmpegCheck {
    check_ffmpeg()
}

#[tauri::command]
pub async fn video_pick(app: AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Vídeos",
            &["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "3gp"],
        )
        .blocking_pick_file();
    picked.and_then(|p| p.into_path().ok().map(|pb| pb.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn video_convert(
    app: AppHandle,
    shared: State<'_, Arc<AppShared>>,
    opts: ConvertOpts,
) -> Result<ConvertResult, String> {
    let res = shared.video.convert(&app, opts).await;
    if let Some(ref out) = res.output_path {
        shared.allowed_outputs.lock().unwrap().insert(out.clone());
    }
    Ok(res)
}

#[tauri::command]
pub fn video_cancel(shared: State<'_, Arc<AppShared>>) -> serde_json::Value {
    serde_json::json!({ "ok": shared.video.cancel() })
}

#[tauri::command]
pub fn video_reveal(path: String) -> serde_json::Value {
    let p = PathBuf::from(path);
    serde_json::json!({ "ok": reveal_file_in_folder(&p) })
}

#[tauri::command]
pub async fn video_send_to_history(
    app: AppHandle,
    shared: State<'_, Arc<AppShared>>,
    path: String,
) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Ok(serde_json::json!({ "ok": false, "error": "Arquivo não encontrado" }));
    }
    let meta = match fs::metadata(&p) {
        Ok(m) => m,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    };
    let filename = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video.mp4")
        .to_string();
    let mime = mime_from_path(&p).to_string();
    let cfg = shared.get_config();

    if cfg.run_local_server && shared.server_stop.lock().unwrap().is_some() {
        let id = Uuid::new_v4().to_string();
        let dst = shared.store.blob_path(&id);
        if let Err(e) = fs::copy(&p, &dst) {
            return Ok(serde_json::json!({ "ok": false, "error": e.to_string() }));
        }
        Ok(match shared.store.create(CreateItemInput {
            id,
            item_type: ItemType::File,
            content: None,
            filename: Some(filename),
            mime_type: Some(mime),
            size: meta.len() as i64,
            pinned: false,
            label: None,
            device_name: Some(cfg.device_name),
            created_at: None,
            updated_at: None,
        }) {
            Ok(created) => {
                for tid in created.trimmed_ids {
                    shared.hub.notify_item_deleted(tid);
                }
                shared.hub.notify_item_created(created.item);
                refresh_tray_menu(&app, &shared);
                serde_json::json!({ "ok": true })
            }
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        })
    } else {
        let bytes = match tokio::fs::read(&p).await {
            Ok(b) => b,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        };
        let part = match reqwest::multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str(&mime)
        {
            Ok(pt) => pt,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        };
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("pinned", "false")
            .text("deviceName", cfg.device_name);
        Ok(match reqwest::Client::new()
            .post(format!("{}/items/upload", shared.api_base()))
            .multipart(form)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => serde_json::json!({ "ok": true }),
            Ok(r) => serde_json::json!({ "ok": false, "error": format!("HTTP {}", r.status()) }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        })
    }
}

#[tauri::command]
pub fn rec_status() -> RecStatus {
    rec_get_status()
}

#[tauri::command]
pub fn rec_open_privacy(kind: String) -> serde_json::Value {
    serde_json::json!({ "ok": rec_open_privacy_os(&kind) })
}

#[tauri::command]
pub fn rec_ask_mic() -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn rec_sources() -> RecSourcesResult {
    tokio::task::spawn_blocking(rec_list_sources)
        .await
        .unwrap_or(RecSourcesResult {
            ok: false,
            error: Some("Falha interna ao capturar fontes".to_string()),
            sources: Vec::new(),
        })
}

#[tauri::command]
pub fn rec_start_native(
    shared: State<'_, Arc<AppShared>>,
    opts: RecStartOpts,
) -> RecStartResult {
    shared.recorder.start(opts)
}

#[tauri::command]
pub async fn rec_stop_native(
    shared: State<'_, Arc<AppShared>>,
    discard: bool,
) -> Result<RecStopResult, String> {
    let res = shared.recorder.stop(discard).await;
    if let Some(ref out) = res.output_path {
        shared.allowed_outputs.lock().unwrap().insert(out.clone());
    }
    Ok(res)
}
