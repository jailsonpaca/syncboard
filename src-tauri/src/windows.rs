use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const WIN_MAIN: &str = "main";
pub const WIN_COMPACT: &str = "compact";
pub const WIN_PREFS: &str = "prefs";

/// Abre (ou traz à frente) a janela principal. Quando fechada, é destruída para liberar 100% da RAM do WebView.
pub fn open_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WIN_MAIN) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    let _ = WebviewWindowBuilder::new(app, WIN_MAIN, WebviewUrl::App("index.html".into()))
        .title("SyncBoard")
        .inner_size(980.0, 720.0)
        .min_inner_size(360.0, 500.0)
        .center()
        .focused(true)
        .build();
}

/// Abre o popup compacto (`Alt+V`) sob demanda e o destrói ao fechar ou perder foco,
/// mantendo o processo em ~15–30 MB em background.
pub fn toggle_compact_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WIN_COMPACT) {
        let _ = win.destroy();
        return;
    }

    let builder = WebviewWindowBuilder::new(
        app,
        WIN_COMPACT,
        WebviewUrl::App("index.html?view=compact".into()),
    )
    .title("SyncBoard")
    .inner_size(380.0, 480.0)
    .min_inner_size(320.0, 380.0)
    .max_inner_size(480.0, 620.0)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .focused(true);

    if let Ok(win) = builder.build() {
        let app_handle = app.clone();
        win.on_window_event(move |ev| {
            if let WindowEvent::Focused(false) = ev {
                let h = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(90)).await;
                    if let Some(prefs) = h.get_webview_window(WIN_PREFS) {
                        if prefs.is_focused().unwrap_or(false) {
                            return;
                        }
                    }
                    if let Some(w) = h.get_webview_window(WIN_COMPACT) {
                        if !w.is_focused().unwrap_or(false) {
                            let _ = w.destroy();
                        }
                    }
                });
            }
        });
    }
}

pub fn close_compact_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WIN_COMPACT) {
        let _ = win.destroy();
    }
}

pub fn open_prefs_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WIN_PREFS) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    let _ = WebviewWindowBuilder::new(app, WIN_PREFS, WebviewUrl::App("prefs.html".into()))
        .title("Preferências — SyncBoard")
        .inner_size(440.0, 580.0)
        .resizable(false)
        .center()
        .focused(true)
        .build();
}
