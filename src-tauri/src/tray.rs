use std::sync::atomic::Ordering;
use std::sync::Arc;

use syncboard_core::models::{ClipItem, ItemType};
use syncboard_core::pair::get_local_ip;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::config::format_hotkey_display;
use crate::state::AppShared;
use crate::sync::paste_item_into_focus;
use crate::windows::{open_main_window, open_prefs_window, toggle_compact_window};

pub const TRAY_ID: &str = "syncboard-tray";

fn truncate(s: &str, max_chars: usize) -> String {
    let clean = s.replace(['\n', '\r'], " ");
    let trimmed = clean.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn item_label(item: &ClipItem) -> String {
    if let Some(ref lbl) = item.label {
        if !lbl.trim().is_empty() {
            return truncate(lbl, 40);
        }
    }
    if let Some(ref content) = item.content {
        if !content.trim().is_empty() {
            return truncate(content, 40);
        }
    }
    if let Some(ref name) = item.filename {
        if !name.trim().is_empty() {
            return truncate(name, 40);
        }
    }
    match item.item_type {
        ItemType::Image => "Imagem".to_string(),
        ItemType::File => "Arquivo".to_string(),
        ItemType::Text => "Texto".to_string(),
    }
}

fn load_tray_icon(app: &AppHandle) -> Option<Image<'static>> {
    let icon_bytes: &[u8] = if cfg!(target_os = "macos") {
        include_bytes!("../icons/tray-template-22.png")
    } else {
        include_bytes!("../icons/tray-32.png")
    };
    if let Ok(img) = Image::from_bytes(icon_bytes) {
        return Some(img.to_owned());
    }
    app.default_window_icon()
        .map(|img| Image::new_owned(img.rgba().to_vec(), img.width(), img.height()))
}

pub fn build_tray_menu(app: &AppHandle, shared: &Arc<AppShared>) -> tauri::Result<Menu<tauri::Wry>> {
    let cfg = shared.get_config();
    let is_conn = shared.connected.load(Ordering::Relaxed);
    let dot = if is_conn { "●" } else { "○" };

    let status_text = if cfg.run_local_server {
        format!("Servidor local :{} {dot}", cfg.port)
    } else {
        format!("Servidor: {} {dot}", cfg.server_url)
    };

    let pinned = shared.store.list(true, 12).unwrap_or_default();
    let history = shared.store.list(false, 8).unwrap_or_default();

    let header = MenuItem::with_id(app, "header", "SyncBoard", false, None::<&str>)?;
    let status_item = MenuItem::with_id(app, "status", &status_text, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    let hotkey_disp = format_hotkey_display(&cfg.hotkey);
    let open_main = MenuItem::with_id(app, "open-main", "Abrir SyncBoard", true, None::<&str>)?;
    let open_compact = MenuItem::with_id(
        app,
        "open-compact",
        &format!("Popup rápido ({hotkey_disp})"),
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    // Submenu Fixados
    let mut pinned_items_menu: Vec<MenuItem<tauri::Wry>> = Vec::new();
    if pinned.is_empty() {
        pinned_items_menu.push(MenuItem::with_id(
            app,
            "pin-empty",
            "(nenhum fixado)",
            false,
            None::<&str>,
        )?);
    } else {
        for item in &pinned {
            let icon = match item.item_type {
                ItemType::Text => "📝",
                ItemType::Image => "🖼",
                ItemType::File => "📎",
            };
            pinned_items_menu.push(MenuItem::with_id(
                app,
                format!("paste:{}", item.id),
                format!("{icon} {}", item_label(item)),
                true,
                None::<&str>,
            )?);
        }
    }
    let pinned_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = pinned_items_menu
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let pinned_sub = Submenu::with_items(app, "Fixo", true, &pinned_refs)?;

    // Submenu Recentes
    let mut hist_items_menu: Vec<MenuItem<tauri::Wry>> = Vec::new();
    if history.is_empty() {
        hist_items_menu.push(MenuItem::with_id(
            app,
            "hist-empty",
            "(vazio)",
            false,
            None::<&str>,
        )?);
    } else {
        for item in &history {
            hist_items_menu.push(MenuItem::with_id(
                app,
                format!("paste:{}", item.id),
                item_label(item),
                true,
                None::<&str>,
            )?);
        }
    }
    let hist_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = hist_items_menu
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let hist_sub = Submenu::with_items(app, "Recentes", true, &hist_refs)?;

    let sep3 = PredefinedMenuItem::separator(app)?;
    let net_info = if cfg.run_local_server {
        Some(MenuItem::with_id(
            app,
            "net-info",
            &format!("Rede: http://{}:{}", get_local_ip(), cfg.port),
            false,
            None::<&str>,
        )?)
    } else {
        None
    };

    let prefs = MenuItem::with_id(app, "open-prefs", "Preferências…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;

    let mut entries: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &header,
        &status_item,
        &sep1,
        &open_main,
        &open_compact,
        &sep2,
        &pinned_sub,
        &hist_sub,
        &sep3,
    ];
    if let Some(ref net) = net_info {
        entries.push(net);
    }
    entries.push(&prefs);
    entries.push(&quit);

    Menu::with_items(app, &entries)
}

pub fn refresh_tray_menu(app: &AppHandle, shared: &Arc<AppShared>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, shared) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn setup_tray(app: &AppHandle, shared: Arc<AppShared>) -> tauri::Result<()> {
    let menu = build_tray_menu(app, &shared)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("SyncBoard — Clipboard Sync")
        .show_menu_on_left_click(true);

    if let Some(icon) = load_tray_icon(app) {
        builder = builder.icon(icon);
        #[cfg(target_os = "macos")]
        {
            builder = builder.icon_as_template(true);
        }
    }

    let shared_menu = Arc::clone(&shared);
    builder
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "open-main" => open_main_window(app),
                "open-compact" => toggle_compact_window(app),
                "open-prefs" => open_prefs_window(app),
                "quit" => {
                    if let Some(st) = app.try_state::<Arc<AppShared>>() {
                        if let Some(pair) = st.pair.lock().unwrap().as_ref() {
                            pair.stop_beacon();
                        }
                    }
                    app.exit(0);
                }
                other if other.starts_with("paste:") => {
                    let item_id = other.trim_start_matches("paste:").to_string();
                    if let Ok(Some(item)) = shared_menu.store.get(&item_id) {
                        let app_c = app.clone();
                        let sh_c = Arc::clone(&shared_menu);
                        tauri::async_runtime::spawn(async move {
                            let _ = paste_item_into_focus(&app_c, &sh_c, item).await;
                        });
                    }
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Menu já abre automaticamente
            }
        })
        .build(app)?;

    Ok(())
}
