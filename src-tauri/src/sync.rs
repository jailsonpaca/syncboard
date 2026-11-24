use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use clipboard_rs::{ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use syncboard_core::http::{create_router, AppState, ServerPaths};
use syncboard_core::models::{ClipItem, ItemType, WsMessage};
use syncboard_core::pair::PairService;
use syncboard_core::store::CreateItemInput;
use tauri::AppHandle;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use uuid::Uuid;

use crate::clipboard::{
    copy_to_public_inbox, hash_file, hash_image, hash_text, read_system_clipboard,
    reveal_file_in_folder, simulate_paste_with_retry, write_clipboard_files, write_clipboard_image,
    write_clipboard_text, ClipboardCapture,
};
use crate::state::AppShared;
use crate::tray::refresh_tray_menu;
use crate::windows::close_compact_window;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    pub ok: bool,
    pub pasted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revealed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Inicia (ou reinicia) o servidor local embutido se `run_local_server == true`,
/// ou o cliente WebSocket remoto se `run_local_server == false`.
pub async fn restart_network_services(app: AppHandle, shared: Arc<AppShared>) {
    stop_network_services(&shared);

    let cfg = shared.get_config();
    if cfg.run_local_server {
        start_embedded_server(app.clone(), Arc::clone(&shared), cfg.port).await;
    } else {
        start_remote_ws_client(app.clone(), Arc::clone(&shared));
    }

    refresh_tray_menu(&app, &shared);
}

pub fn stop_network_services(shared: &Arc<AppShared>) {
    if let Some(tx) = shared.server_stop.lock().unwrap().take() {
        let _ = tx.send(true);
    }
    if let Some(pair) = shared.pair.lock().unwrap().take() {
        pair.stop_beacon();
    }
    if let Some(tx) = shared.remote_stop.lock().unwrap().take() {
        let _ = tx.send(true);
    }
    shared.connected.store(false, Ordering::Relaxed);
}

async fn start_embedded_server(app: AppHandle, shared: Arc<AppShared>, port: u16) {
    let pair = PairService::new(port);
    let addr: SocketAddr = ([0, 0, 0, 0], port).into();

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("[server] porta {port} já em uso ({e}); conectando como cliente local");
            shared.connected.store(true, Ordering::Relaxed);
            start_remote_ws_client(app, shared);
            return;
        }
    };

    pair.start_beacon();
    *shared.pair.lock().unwrap() = Some(Arc::clone(&pair));

    let (stop_tx, mut stop_rx) = watch::channel(false);
    *shared.server_stop.lock().unwrap() = Some(stop_tx);

    let router = create_router(
        AppState {
            store: Arc::clone(&shared.store),
            hub: Arc::clone(&shared.hub),
            pair: Some(Arc::clone(&pair)),
            updater: Arc::clone(&shared.updater),
        },
        ServerPaths {
            client_dist: shared.client_dist.clone(),
            release_dir: None,
        },
    );

    shared.connected.store(true, Ordering::Relaxed);
    tracing::info!("[server] servidor embutido Rust ouvindo em 0.0.0.0:{port}");

    // Escuta eventos do Hub local (ex.: item vindo do Android ou Linux) para aplicar no clipboard deste Mac!
    let mut hub_rx = shared.hub.subscribe();
    let shared_hub = Arc::clone(&shared);
    let app_hub = app.clone();
    let mut hub_stop = stop_rx.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = hub_stop.changed() => {
                    if *hub_stop.borrow() { break; }
                }
                msg = hub_rx.recv() => {
                    let Ok(raw) = msg else { continue };
                    if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&raw) {
                        handle_incoming_ws_message(&app_hub, &shared_hub, ws_msg).await;
                    }
                }
            }
        }
    });

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stop_rx.changed().await;
            })
            .await;
    });
}

fn start_remote_ws_client(app: AppHandle, shared: Arc<AppShared>) {
    let (stop_tx, mut stop_rx) = watch::channel(false);
    *shared.remote_stop.lock().unwrap() = Some(stop_tx);

    tokio::spawn(async move {
        loop {
            if *stop_rx.borrow() {
                break;
            }
            let ws_url = shared.ws_url();
            let device_name = shared.get_config().device_name;
            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((ws_stream, _)) => {
                    shared.connected.store(true, Ordering::Relaxed);
                    refresh_tray_menu(&app, &shared);

                    let (mut write, mut read) = ws_stream.split();
                    let hello = serde_json::json!({
                        "type": "hello",
                        "deviceName": device_name,
                    })
                    .to_string();
                    let _ = write.send(WsMsg::Text(hello.into())).await;

                    loop {
                        tokio::select! {
                            _ = stop_rx.changed() => {
                                if *stop_rx.borrow() { return; }
                            }
                            frame = read.next() => {
                                match frame {
                                    Some(Ok(WsMsg::Text(text))) => {
                                        if let Ok(msg) = serde_json::from_str::<WsMessage>(&text) {
                                            handle_incoming_ws_message(&app, &shared, msg).await;
                                        }
                                    }
                                    Some(Ok(WsMsg::Close(_))) | Some(Err(_)) | None => break,
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                Err(_) => {
                    shared.connected.store(false, Ordering::Relaxed);
                    refresh_tray_menu(&app, &shared);
                }
            }

            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() { break; }
                }
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
            }
        }
    });
}

async fn handle_incoming_ws_message(app: &AppHandle, shared: &Arc<AppShared>, msg: WsMessage) {
    match msg {
        WsMessage::SyncRequest { items } => {
            for item in items.pinned.iter().chain(items.history.iter()) {
                let _ = shared.store.upsert_preserving_pinned(item);
            }
            refresh_tray_menu(app, shared);
        }
        WsMessage::ItemCreated { item } => {
            let _ = shared.store.upsert_preserving_pinned(&item);
            let my_device = shared.get_config().device_name;
            let from_self = item
                .device_name
                .as_deref()
                .map(|d| d.eq_ignore_ascii_case(&my_device))
                .unwrap_or(false);

            if !from_self && shared.get_config().auto_sync {
                let _ = apply_remote_item_to_clipboard(shared, &item).await;
            }
            refresh_tray_menu(app, shared);
        }
        WsMessage::ItemUpdated { item } => {
            let _ = shared.store.upsert_preserving_pinned(&item);
            refresh_tray_menu(app, shared);
        }
        WsMessage::ItemDeleted { id } => {
            let _ = shared.store.delete(&id);
            refresh_tray_menu(app, shared);
        }
    }
}

/// Inicia o watcher nativo de clipboard do SO (NSPasteboard.changeCount no macOS,
/// AddClipboardFormatListener no Windows, X11/Wayland no Linux).
pub fn start_clipboard_watcher(app: AppHandle, shared: Arc<AppShared>) {
    // Marca o estado inicial da clipboard para não enviar o que já estava copiado antes do app abrir
    if let Some(initial) = read_system_clipboard() {
        let h = match &initial {
            ClipboardCapture::Text { hash, .. } => hash,
            ClipboardCapture::Image { hash, .. } => hash,
            ClipboardCapture::File { hash, .. } => hash,
        };
        shared.recent_hashes.remember(h);
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    // Linux/X11: o watcher nativo pode morrer sem aviso. Polling de 1s como garantia;
    // o dedup por hash (recent_hashes) evita itens duplicados.
    #[cfg(target_os = "linux")]
    {
        let tx_poll = tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                if tx_poll.send(()).is_err() {
                    break;
                }
            }
        });
    }

    // Thread leve dedicada ao watcher nativo do SO
    std::thread::Builder::new()
        .name("syncboard-clipboard-watcher".into())
        .spawn(move || {
            struct Handler {
                tx: tokio::sync::mpsc::UnboundedSender<()>,
            }
            impl ClipboardHandler for Handler {
                fn on_clipboard_change(&mut self) {
                    let _ = self.tx.send(());
                }
            }

            match ClipboardWatcherContext::new() {
                Ok(mut watcher) => {
                    let _ = watcher.add_handler(Handler { tx });
                    watcher.start_watch();
                    tracing::warn!("[clipboard] watcher nativo encerrou");
                }
                Err(e) => tracing::warn!("[clipboard] watcher nativo indisponível: {e}"),
            }
        })
        .ok();

    tokio::spawn(async move {
        while rx.recv().await.is_some() {
            // Pequeno debounce (120ms) para apps que escrevem múltiplos formatos na sequência
            tokio::time::sleep(Duration::from_millis(120)).await;
            while rx.try_recv().is_ok() {}

            if !shared.get_config().auto_sync {
                continue;
            }

            let captured = tokio::task::spawn_blocking(read_system_clipboard)
                .await
                .ok()
                .flatten();

            let Some(cap) = captured else { continue };
            let hash = match &cap {
                ClipboardCapture::Text { hash, .. } => hash.clone(),
                ClipboardCapture::Image { hash, .. } => hash.clone(),
                ClipboardCapture::File { hash, .. } => hash.clone(),
            };

            if shared.recent_hashes.contains(&hash) {
                continue;
            }
            shared.recent_hashes.remember(&hash);

            if let Err(e) = publish_local_capture(&app, &shared, cap).await {
                tracing::warn!("[clipboard] falha ao publicar captura: {e}");
            }
        }
    });
}

async fn publish_local_capture(
    app: &AppHandle,
    shared: &Arc<AppShared>,
    cap: ClipboardCapture,
) -> Result<(), String> {
    let cfg = shared.get_config();
    let device_name = Some(cfg.device_name.clone());

    if cfg.run_local_server && shared.server_stop.lock().unwrap().is_some() {
        // Gravação direta no ClipStore embutido (zero overhead HTTP!)
        let created = match cap {
            ClipboardCapture::Text { content, .. } => {
                let size = content.len() as i64;
                shared
                    .store
                    .create(CreateItemInput {
                        id: Uuid::new_v4().to_string(),
                        item_type: ItemType::Text,
                        content: Some(content),
                        filename: None,
                        mime_type: Some("text/plain".to_string()),
                        size,
                        pinned: false,
                        label: None,
                        device_name,
                        created_at: None,
                        updated_at: None,
                    })
                    .map_err(|e| e.to_string())?
            }
            ClipboardCapture::Image { png_bytes, .. } => {
                let id = Uuid::new_v4().to_string();
                let size = png_bytes.len() as i64;
                shared
                    .store
                    .save_blob(&id, &png_bytes)
                    .map_err(|e| e.to_string())?;
                shared
                    .store
                    .create(CreateItemInput {
                        id,
                        item_type: ItemType::Image,
                        content: None,
                        filename: Some("clipboard.png".to_string()),
                        mime_type: Some("image/png".to_string()),
                        size,
                        pinned: false,
                        label: None,
                        device_name,
                        created_at: None,
                        updated_at: None,
                    })
                    .map_err(|e| e.to_string())?
            }
            ClipboardCapture::File {
                path,
                filename,
                mime,
                size,
                ..
            } => {
                let id = Uuid::new_v4().to_string();
                let dst = shared.store.blob_path(&id);
                fs::copy(&path, &dst).map_err(|e| e.to_string())?;
                let is_img = mime.starts_with("image/");
                shared
                    .store
                    .create(CreateItemInput {
                        id,
                        item_type: if is_img { ItemType::Image } else { ItemType::File },
                        content: None,
                        filename: Some(filename),
                        mime_type: Some(mime),
                        size,
                        pinned: false,
                        label: None,
                        device_name,
                        created_at: None,
                        updated_at: None,
                    })
                    .map_err(|e| e.to_string())?
            }
        };

        for trimmed_id in created.trimmed_ids {
            shared.hub.notify_item_deleted(trimmed_id);
        }
        shared.hub.notify_item_created(created.item);
        refresh_tray_menu(app, shared);
        return Ok(());
    }

    // Modo cliente remoto: envia via HTTP para o servidor configurado
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let api = shared.api_base();

    match cap {
        ClipboardCapture::Text { content, .. } => {
            client
                .post(format!("{api}/items/text"))
                .json(&serde_json::json!({
                    "content": content,
                    "pinned": false,
                    "deviceName": cfg.device_name,
                }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
        }
        ClipboardCapture::Image { png_bytes, .. } => {
            let part = reqwest::multipart::Part::bytes(png_bytes)
                .file_name("clipboard.png")
                .mime_str("image/png")
                .map_err(|e| e.to_string())?;
            let form = reqwest::multipart::Form::new()
                .part("file", part)
                .text("pinned", "false")
                .text("deviceName", cfg.device_name);
            client
                .post(format!("{api}/items/upload"))
                .multipart(form)
                .send()
                .await
                .map_err(|e| e.to_string())?;
        }
        ClipboardCapture::File {
            path,
            filename,
            mime,
            ..
        } => {
            let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(filename)
                .mime_str(&mime)
                .map_err(|e| e.to_string())?;
            let form = reqwest::multipart::Form::new()
                .part("file", part)
                .text("pinned", "false")
                .text("deviceName", cfg.device_name);
            client
                .post(format!("{api}/items/upload"))
                .multipart(form)
                .send()
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// Garante que o blob de um item esteja disponível no disco local (baixando do servidor remoto se necessário).
async fn ensure_item_blob(shared: &Arc<AppShared>, item: &ClipItem) -> Result<PathBuf, String> {
    if let Some(p) = shared.store.get_blob_path(&item.id) {
        return Ok(p);
    }
    let url = format!("{}/items/{}/blob", shared.api_base(), item.id);
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    shared
        .store
        .save_blob(&item.id, &bytes)
        .map_err(|e| e.to_string())
}

pub async fn apply_remote_item_to_clipboard(
    shared: &Arc<AppShared>,
    item: &ClipItem,
) -> Result<(bool, Option<PathBuf>), String> {
    match item.item_type {
        ItemType::Text => {
            let text = item.content.clone().unwrap_or_default();
            if text.is_empty() {
                return Ok((false, None));
            }
            shared.recent_hashes.remember(&hash_text(text.trim()));
            tokio::task::spawn_blocking(move || write_clipboard_text(&text))
                .await
                .map_err(|e| e.to_string())??;
            Ok((true, None))
        }
        ItemType::Image => {
            let blob_path = ensure_item_blob(shared, item).await?;
            let bytes = tokio::fs::read(&blob_path).await.map_err(|e| e.to_string())?;
            shared.recent_hashes.remember(&hash_image(&bytes));
            tokio::task::spawn_blocking(move || write_clipboard_image(&bytes))
                .await
                .map_err(|e| e.to_string())??;
            // Também memoriza o hash lido de volta (macOS às vezes re-codifica PNG)
            if let Some(ClipboardCapture::Image { hash, .. }) =
                tokio::task::spawn_blocking(read_system_clipboard)
                    .await
                    .ok()
                    .flatten()
            {
                shared.recent_hashes.remember(&hash);
            }
            Ok((true, Some(blob_path)))
        }
        ItemType::File => {
            let blob_path = ensure_item_blob(shared, item).await?;
            let filename = item
                .filename
                .clone()
                .unwrap_or_else(|| format!("arquivo-{}", item.id));
            let inbox_path = copy_to_public_inbox(&blob_path, &filename)?;
            if let Ok(meta) = fs::metadata(&inbox_path) {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                shared
                    .recent_hashes
                    .remember(&hash_file(&inbox_path, meta.len(), mtime_ms));
            }
            let p_clone = inbox_path.clone();
            let wrote = tokio::task::spawn_blocking(move || write_clipboard_files(&[p_clone]))
                .await
                .map_err(|e| e.to_string())?
                .is_ok();
            Ok((wrote, Some(inbox_path)))
        }
    }
}

pub async fn paste_item_into_focus(
    app: &AppHandle,
    shared: &Arc<AppShared>,
    item: ClipItem,
) -> PasteResult {
    close_compact_window(app);

    // Move item não-fixado para o topo do histórico
    if !item.pinned {
        if let Ok(Some(updated)) = shared.store.touch(&item.id) {
            shared.hub.notify_item_updated(updated);
            refresh_tray_menu(app, shared);
        }
    }

    let (wrote, local_path) = match apply_remote_item_to_clipboard(shared, &item).await {
        Ok(res) => res,
        Err(e) => {
            return PasteResult {
                ok: false,
                pasted: false,
                kind: Some(item.item_type.as_str().to_string()),
                local_path: None,
                revealed: None,
                error: Some(e),
            };
        }
    };

    if item.item_type == ItemType::File {
        if let Some(ref lp) = local_path {
            let p_clone = lp.clone();
            let revealed = tokio::task::spawn_blocking(move || reveal_file_in_folder(&p_clone))
                .await
                .unwrap_or(false);
            if wrote {
                let _ = simulate_paste_with_retry(2).await;
            }
            return PasteResult {
                ok: true,
                pasted: false,
                kind: Some("file".to_string()),
                local_path: Some(lp.to_string_lossy().to_string()),
                revealed: Some(revealed),
                error: None,
            };
        }
    }

    let pasted = simulate_paste_with_retry(3).await;
    PasteResult {
        ok: true,
        pasted,
        kind: Some(item.item_type.as_str().to_string()),
        local_path: local_path.map(|p| p.to_string_lossy().to_string()),
        revealed: None,
        error: None,
    }
}
