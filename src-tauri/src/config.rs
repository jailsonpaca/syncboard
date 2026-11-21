use std::fs;
use std::path::{Path, PathBuf};

use syncboard_core::models::DesktopConfig;

pub const DEFAULT_HOTKEY: &str = "Alt+V";

pub fn normalize_hotkey(raw: &str) -> String {
    let parts: Vec<String> = raw
        .split('+')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| match p {
            "CmdOrCtrl" | "Control" | "Command" | "Super" => "CommandOrControl".to_string(),
            "Option" => "Alt".to_string(),
            single if single.len() == 1 => single.to_uppercase(),
            other => other.to_string(),
        })
        .collect();

    let is_mod = |s: &str| {
        matches!(
            s,
            "CommandOrControl" | "CmdOrCtrl" | "Control" | "Command" | "Alt" | "Option" | "Shift" | "Super"
        )
    };

    let mods: Vec<String> = parts.iter().filter(|p| is_mod(p)).cloned().collect();
    let keys: Vec<String> = parts.iter().filter(|p| !is_mod(p)).cloned().collect();

    let Some(key) = keys.last() else {
        return DEFAULT_HOTKEY.to_string();
    };
    if key == "Dead" || !key.is_ascii() {
        return DEFAULT_HOTKEY.to_string();
    }

    let mut combined = mods;
    combined.push(key.clone());
    combined.join("+")
}

pub fn format_hotkey_display(accelerator: &str) -> String {
    let is_mac = cfg!(target_os = "macos");
    let mut s = accelerator.to_string();
    if is_mac {
        s = s
            .replace("CommandOrControl", "⌘")
            .replace("Command", "⌘")
            .replace("Control", "Ctrl")
            .replace("Shift", "⇧")
            .replace("Alt", "⌥")
            .replace("Option", "⌥")
            .replace('+', "");
    } else {
        s = s
            .replace("CommandOrControl", "Ctrl")
            .replace("Option", "Alt");
    }
    s
}

/// Converte o formato Electron/SyncBoard (`CommandOrControl+Shift+V`) para o formato `global-shortcut` do Tauri.
pub fn to_tauri_shortcut(accelerator: &str) -> String {
    let norm = normalize_hotkey(accelerator);
    if cfg!(target_os = "macos") {
        norm.replace("CommandOrControl", "Super")
    } else {
        norm.replace("CommandOrControl", "Ctrl")
    }
}

pub fn load_config(config_path: &Path) -> DesktopConfig {
    let mut cfg = fs::read_to_string(config_path)
        .ok()
        .and_then(|s| serde_json::from_str::<DesktopConfig>(&s).ok())
        .unwrap_or_default();

    // Migra atalho legado ou corrompido
    if matches!(
        cfg.hotkey.as_str(),
        "CommandOrControl+Shift+V" | "CmdOrCtrl+Shift+V" | "Control+Shift+V" | "Command+Shift+V"
    ) || !cfg.hotkey.is_ascii()
    {
        cfg.hotkey = DEFAULT_HOTKEY.to_string();
    } else {
        cfg.hotkey = normalize_hotkey(&cfg.hotkey);
    }

    if cfg.port < 1024 {
        cfg.port = 8787;
    }
    if cfg.run_local_server {
        cfg.server_url = format!("http://127.0.0.1:{}", cfg.port);
    }
    cfg
}

pub fn save_config(config_path: &Path, cfg: &DesktopConfig) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(config_path, pretty).map_err(|e| e.to_string())
}

pub fn app_data_root() -> PathBuf {
    if let Ok(custom) = std::env::var("SYNCBOARD_APP_DATA") {
        return PathBuf::from(custom);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.syncboard.app")
}
