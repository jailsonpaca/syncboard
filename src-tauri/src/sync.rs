use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[cfg(not(target_os = "linux"))]
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

/// Intervalo de ping do cliente e tempo máximo sem receber nada antes de considerar a conexão
/// morta (conexão meio aberta após suspensão ou queda de Wi-Fi).
const WS_PING_EVERY: Duration = Duration::from_secs(20);
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(50);
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

fn start_remote_ws_client(app: AppHandle, shared: Arc<AppShared>) {
    let (stop_tx, mut stop_rx) = watch::channel(false);
    *shared.remote_stop.lock().unwrap() = Some(stop_tx);

    tokio::spawn(async move {
        let mut was_connected = false;
        loop {
            if *stop_rx.borrow() {
                break;
            }
            let ws_url = shared.ws_url();
            let device_name = shared.get_config().device_name;
            match tokio::time::timeout(WS_CONNECT_TIMEOUT, tokio_tungstenite::connect_async(&ws_url)).await {
                Ok(Ok((ws_stream, _))) => {
                    tracing::info!("[ws] conectado em {ws_url}");
                    shared.connected.store(true, Ordering::Relaxed);
                    was_connected = true;
                    refresh_tray_menu(&app, &shared);
                    flush_pending_publish(&app, &shared);

                    let (mut write, mut read) = ws_stream.split();
                    let hello = serde_json::json!({
                        "type": "hello",
                        "deviceName": device_name,
                    })
                    .to_string();
                    let _ = write.send(WsMsg::Text(hello.into())).await;

                    let mut ping = tokio::time::interval(WS_PING_EVERY);
                    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    let mut last_rx = tokio::time::Instant::now();

                    let reason = loop {
                        tokio::select! {
                            _ = stop_rx.changed() => {
                                if *stop_rx.borrow() { return; }
                            }
                            _ = ping.tick() => {
                                if last_rx.elapsed() > WS_IDLE_TIMEOUT {
                                    break format!("sem resposta há {:?}", last_rx.elapsed());
                                }
                                if let Err(e) = write.send(WsMsg::Ping(Vec::new().into())).await {
                                    break format!("falha ao enviar ping: {e}");
                                }
                            }
                            frame = read.next() => {
                                last_rx = tokio::time::Instant::now();
                                match frame {
                                    Some(Ok(WsMsg::Text(text))) => {
                                        match serde_json::from_str::<WsMessage>(&text) {
                                            Ok(msg) => {
                                                handle_incoming_ws_message(&app, &shared, msg).await;
                                                // Aplicar um item grande pode demorar; não conta como silêncio.
                                                last_rx = tokio::time::Instant::now();
                                            }
                                            Err(e) => tracing::debug!("[ws] mensagem ignorada: {e}"),
                                        }
                                    }
                                    Some(Ok(WsMsg::Close(_))) | None => break "fechada pelo servidor".to_string(),
                                    Some(Err(e)) => break format!("erro: {e}"),
                                    _ => {}
                                }
                            }
                        }
                    };
                    tracing::warn!("[ws] conexão perdida ({reason}); reconectando");
                    shared.connected.store(false, Ordering::Relaxed);
                    refresh_tray_menu(&app, &shared);
                }
                Ok(Err(e)) => {
                    if was_connected {
                        tracing::warn!("[ws] falha ao conectar em {ws_url}: {e}");
                    } else {
                        tracing::debug!("[ws] falha ao conectar em {ws_url}: {e}");
                    }
                    was_connected = false;
                    if shared.connected.swap(false, Ordering::Relaxed) {
                        refresh_tray_menu(&app, &shared);
                    }
                }
                Err(_) => {
                    tracing::warn!("[ws] tempo esgotado ao conectar em {ws_url}");
                    was_connected = false;
                    if shared.connected.swap(false, Ordering::Relaxed) {
                        refresh_tray_menu(&app, &shared);
                    }
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
/// AddClipboardFormatListener no Windows, XFixes no Linux/X11).
///
/// Não há polling: a leitura do conteúdo só acontece quando o SO avisa que a área de
/// transferência mudou. Os watchers são supervisionados e reiniciados com backoff.
pub fn start_clipboard_watcher(app: AppHandle, shared: Arc<AppShared>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    #[cfg(target_os = "linux")]
    crate::x11_watch::spawn(tx);

    #[cfg(not(target_os = "linux"))]
    spawn_native_watcher(tx);

    tokio::spawn(async move {
        // Marca o estado inicial da clipboard para não enviar o que já estava copiado antes do
        // app abrir. Feito aqui, depois de o watcher já estar ativo: mudanças ocorridas durante
        // esta leitura ficam na fila e são processadas em seguida (antes se perdiam).
        let initial = tokio::task::spawn_blocking(read_system_clipboard)
            .await
            .ok()
            .flatten();
        if let Some(initial) = initial {
            shared.dedup.mark_seen(initial.hash());
        }

        while rx.recv().await.is_some() {
            // Pequeno debounce (120ms) para apps que escrevem múltiplos formatos na sequência
            tokio::time::sleep(Duration::from_millis(120)).await;
            while rx.try_recv().is_ok() {}

            if !shared.get_config().auto_sync {
                continue;
            }

            let t_read = std::time::Instant::now();
            let captured = {
                // Serializa com escritas vindas do remoto (ver apply_remote_item_to_clipboard)
                let _io = shared.clip_io.lock().await;
                tokio::task::spawn_blocking(read_system_clipboard)
                    .await
                    .ok()
                    .flatten()
            };

            let Some(cap) = captured else {
                tracing::debug!("[clipboard] nada legível ({:?})", t_read.elapsed());
                continue;
            };
            tracing::debug!("[clipboard] lido {} em {:?}", cap.kind(), t_read.elapsed());
            if !shared.dedup.observe(cap.hash()) {
                tracing::debug!("[clipboard] {} ignorado (repetido ou eco)", cap.kind());
                continue;
            }

            publish_with_retry(&app, &shared, cap).await;
        }
    });
}

/// Watcher da clipboard-rs (macOS/Windows), reiniciado com backoff se terminar.
#[cfg(not(target_os = "linux"))]
fn spawn_native_watcher(tx: tokio::sync::mpsc::UnboundedSender<()>) {
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

            let mut backoff = Duration::from_secs(1);
            loop {
                if tx.is_closed() {
                    return;
                }
                match ClipboardWatcherContext::new() {
                    Ok(mut watcher) => {
                        let _ = watcher.add_handler(Handler { tx: tx.clone() });
                        watcher.start_watch();
                        tracing::warn!("[clipboard] watcher nativo encerrou; reiniciando em {backoff:?}");
                    }
                    Err(e) => tracing::warn!("[clipboard] watcher nativo indisponível: {e}"),
                }
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
        })
        .ok();
}

/// Publica uma captura local tentando de novo em falhas transitórias. Se todas as tentativas
/// falharem, a captura fica pendente e é reenviada quando o WebSocket reconectar.
async fn publish_with_retry(app: &AppHandle, shared: &Arc<AppShared>, cap: ClipboardCapture) {
    const DELAYS: [u64; 4] = [0, 2, 5, 10];
    let kind = cap.kind();
    let hash = cap.hash().to_string();
    let mut last_err = String::new();
    for (i, delay) in DELAYS.iter().enumerate() {
        if *delay > 0 {
            tokio::time::sleep(Duration::from_secs(*delay)).await;
            // Se o usuário copiou outra coisa nesse meio tempo, esta captura ficou velha.
            if shared.dedup.last_seen().as_deref() != Some(hash.as_str()) {
                tracing::info!("[sync] {kind} substituído por cópia mais nova; abandonando reenvio");
                return;
            }
        }
        match publish_local_capture(app, shared, cap.clone()).await {
            Ok(()) => {
                tracing::info!(
                    "[sync] {kind} enviado (tentativa {}, hash {})",
                    i + 1,
                    &hash[..hash.len().min(10)]
                );
                if shared.pending_publish.lock().unwrap_or_else(|e| e.into_inner()).take().is_some() {
                    tracing::debug!("[sync] pendência anterior descartada");
                }
                return;
            }
            Err(e) => {
                tracing::warn!("[sync] falha ao enviar {kind} (tentativa {}): {e}", i + 1);
                last_err = e;
            }
        }
    }
    tracing::error!("[sync] {kind} NÃO enviado após {} tentativas: {last_err}; fica pendente até reconectar", DELAYS.len());
    shared.dedup.forget(&hash);
    *shared.pending_publish.lock().unwrap_or_else(|e| e.into_inner()) = Some(cap);
}

/// Reenvia a captura pendente (chamado quando o WebSocket conecta).
fn flush_pending_publish(app: &AppHandle, shared: &Arc<AppShared>) {
    let pending = shared.pending_publish.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(cap) = pending {
        // Só reenvia se ainda for o conteúdo atual (ou se nada mais novo foi visto).
        let last = shared.dedup.last_seen();
        if last.is_some() && last.as_deref() != Some(cap.hash()) {
            return;
        }
        shared.dedup.mark_seen(cap.hash());
        tracing::info!("[sync] reenviando {} pendente após reconectar", cap.kind());
        let app = app.clone();
        let shared = Arc::clone(shared);
        tokio::spawn(async move {
            publish_with_retry(&app, &shared, cap).await;
        });
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .build()
            .expect("cliente HTTP")
    })
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
    let client = http_client();
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
                .and_then(|r| r.error_for_status())
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
                .and_then(|r| r.error_for_status())
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
                .and_then(|r| r.error_for_status())
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
    let bytes = http_client()
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
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
    // Baixa o blob antes de travar a clipboard (pode demorar).
    let blob_path = match item.item_type {
        ItemType::Text => None,
        _ => Some(ensure_item_blob(shared, item).await?),
    };
    // Enquanto escreve (e lê de volta), o watcher não lê: assim o eco é reconhecido.
    let _io = shared.clip_io.lock().await;
    match item.item_type {
        ItemType::Text => {
            let text = item.content.clone().unwrap_or_default();
            if text.is_empty() {
                return Ok((false, None));
            }
            shared.dedup.note_own_write(&hash_text(text.trim()));
            tokio::task::spawn_blocking(move || write_clipboard_text(&text))
                .await
                .map_err(|e| e.to_string())??;
            Ok((true, None))
        }
        ItemType::Image => {
            let Some(blob_path) = blob_path else {
                return Err("blob ausente".into());
            };
            let bytes = tokio::fs::read(&blob_path).await.map_err(|e| e.to_string())?;
            shared.dedup.note_own_write(&hash_image(&bytes));
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
                shared.dedup.note_own_write(&hash);
            }
            Ok((true, Some(blob_path)))
        }
        ItemType::File => {
            let Some(blob_path) = blob_path else {
                return Err("blob ausente".into());
            };
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
                    .dedup
                    .note_own_write(&hash_file(&inbox_path, meta.len(), mtime_ms));
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
