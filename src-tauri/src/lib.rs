mod clipboard;
mod commands;
mod config;
mod recorder;
mod state;
mod sync;
mod tray;
mod video;
mod windows;
#[cfg(target_os = "linux")]
mod x11_watch;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use syncboard_core::hub::Hub;
use syncboard_core::migration::{discover_legacy_sources, migrate_legacy_data};
use syncboard_core::store::ClipStore;
use syncboard_core::update::UpdateChecker;
use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

use crate::clipboard::ClipDedup;
use crate::commands::register_global_hotkey;
use crate::config::{app_data_root, load_config};
use crate::recorder::ScreenRecorder;
use crate::state::AppShared;
use crate::sync::{restart_network_services, start_clipboard_watcher};
use crate::tray::setup_tray;
use crate::video::VideoConverter;
use crate::windows::open_main_window;

fn resolve_client_dist(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("client");
        if bundled.join("index.html").is_file() {
            return Some(bundled);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for cand in [cwd.join("client/dist"), cwd.join("../client/dist")] {
            if cand.join("index.html").is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// Log em stdout e em `<app_data>/logs/syncboard.YYYY-MM-DD.log` (rotação diária, 7 arquivos),
/// e um panic hook que grava local + backtrace antes do abort (`panic = "abort"` no release).
fn init_logging(log_dir: &std::path::Path) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let file_layer = std::fs::create_dir_all(log_dir)
        .ok()
        .and_then(|_| {
            tracing_appender::rolling::Builder::new()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .filename_prefix("syncboard")
                .filename_suffix("log")
                .max_log_files(7)
                .build(log_dir)
                .ok()
        })
        .map(|appender| fmt::layer().with_ansi(false).with_writer(Mutex::new(appender)));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .with(file_layer)
        .try_init();

    let crash_file = log_dir.join("crash.log");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let bt = std::backtrace::Backtrace::force_capture();
        let msg = format!(
            "[{}] PANIC na thread '{}' (v{}): {info}\n{bt}\n",
            chrono_like_now(),
            thread.name().unwrap_or("?"),
            env!("CARGO_PKG_VERSION")
        );
        tracing::error!("{msg}");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&crash_file) {
            use std::io::Write;
            let _ = f.write_all(msg.as_bytes());
            let _ = f.sync_all();
        }
        default_hook(info);
    }));

    tracing::info!("SyncBoard v{} iniciando (log em {})", env!("CARGO_PKG_VERSION"), log_dir.display());
}

fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix {secs}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_root = app_data_root();
    init_logging(&app_root.join("logs"));
    let data_dir = app_root.join("data");
    let config_path = app_root.join("config.json");

    let store = Arc::new(ClipStore::open(&data_dir).expect("Falha ao abrir banco SQLite do SyncBoard"));

    // Migração automática, idempotente e segura (com backup prévio) de todos os dados legados —
    // garantindo preservação integral dos itens da aba "Fixo", histórico, blobs e config.json.
    let legacy_sources = discover_legacy_sources(None);
    match migrate_legacy_data(&store, &config_path, &legacy_sources, false) {
        Ok(report) => {
            if !report.sources_imported.is_empty() {
                tracing::info!(
                    "[migration] migrados {} fixados, {} histórico, {} blobs (total fixos={})",
                    report.pinned_imported,
                    report.history_imported,
                    report.blobs_copied,
                    report.final_pinned_count
                );
            }
        }
        Err(e) => {
            tracing::error!("[migration] aviso: {e}");
        }
    }

    let cfg = load_config(&config_path);
    let hub = Arc::new(Hub::new());
    let updater = Arc::new(UpdateChecker::new(env!("CARGO_PKG_VERSION")));

    let shared = Arc::new(AppShared {
        app_root,
        config_path,
        config: Mutex::new(cfg.clone()),
        store,
        hub,
        pair: Mutex::new(None),
        server_stop: Mutex::new(None),
        remote_stop: Mutex::new(None),
        updater,
        dedup: ClipDedup::new(),
        clip_io: tokio::sync::Mutex::new(()),
        pending_publish: Mutex::new(None),
        connected: AtomicBool::new(false),
        video: VideoConverter::default(),
        recorder: ScreenRecorder::default(),
        allowed_outputs: Mutex::new(HashSet::new()),
        client_dist: None,
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_main_window(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::test_hotkey,
            commands::paste_item,
            commands::apply_remote_item,
            commands::discover_servers,
            commands::join_with_code,
            commands::check_update,
            commands::download_update,
            commands::install_update,
            commands::get_update_notes,
            commands::open_external,
            commands::video_check,
            commands::video_pick,
            commands::video_convert,
            commands::video_cancel,
            commands::video_reveal,
            commands::video_send_to_history,
            commands::rec_status,
            commands::rec_open_privacy,
            commands::rec_ask_mic,
            commands::rec_sources,
            commands::rec_start_native,
            commands::rec_stop_native,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Reconstrói AppShared com `client_dist` resolvido a partir dos resources empacotados
            let client_dist = resolve_client_dist(&handle);
            let final_shared = Arc::new(AppShared {
                app_root: shared.app_root.clone(),
                config_path: shared.config_path.clone(),
                config: Mutex::new(shared.get_config()),
                store: Arc::clone(&shared.store),
                hub: Arc::clone(&shared.hub),
                pair: Mutex::new(None),
                server_stop: Mutex::new(None),
                remote_stop: Mutex::new(None),
                updater: Arc::clone(&shared.updater),
                dedup: ClipDedup::new(),
        clip_io: tokio::sync::Mutex::new(()),
        pending_publish: Mutex::new(None),
                connected: AtomicBool::new(false),
                video: VideoConverter::default(),
                recorder: ScreenRecorder::default(),
                allowed_outputs: Mutex::new(HashSet::new()),
                client_dist,
            });
            app.manage(Arc::clone(&final_shared));

            // Configura ícone na bandeja/barra de menu
            setup_tray(&handle, Arc::clone(&final_shared))?;

            // Sincroniza autostart com a preferência migrada/salva
            if final_shared.get_config().launch_at_login {
                let auto = handle.autolaunch();
                if !auto.is_enabled().unwrap_or(false) {
                    let _ = auto.enable();
                }
            }

            // Registra atalho global (padrão Alt+V)
            let hk = final_shared.get_config().hotkey;
            if let Err(e) = register_global_hotkey(&handle, "", &hk) {
                tracing::warn!("[hotkey] {e}");
            }

            // Se pedido via env (ex.: wrapper Linux), abre janela principal ao iniciar
            if std::env::var("SYNCBOARD_START_VISIBLE").ok().as_deref() == Some("1") {
                open_main_window(&handle);
            }

            // Inicia servidor embutido / cliente remoto e watcher nativo de clipboard
            let h_net = handle.clone();
            let s_net = Arc::clone(&final_shared);
            tauri::async_runtime::spawn(async move {
                restart_network_services(h_net.clone(), Arc::clone(&s_net)).await;
                start_clipboard_watcher(h_net, s_net);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao construir SyncBoard Tauri");

    // Mantém o app vivo na bandeja mesmo quando todas as janelas forem fechadas/destruídas
    // (garante ~15–30 MB em background).
    app.run(|_app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                open_main_window(_app_handle);
            }
        }
        _ => {}
    });
}
