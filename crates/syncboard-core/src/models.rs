use serde::{Deserialize, Serialize};

pub const MAX_HISTORY_ITEMS: usize = 100;
pub const MAX_FILE_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Text,
    Image,
    File,
}

impl ItemType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ItemType::Text => "text",
            ItemType::Image => "image",
            ItemType::File => "file",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "image" => ItemType::Image,
            "file" => ItemType::File,
            _ => ItemType::Text,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub content: Option<String>,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: i64,
    pub pinned: bool,
    pub label: Option<String>,
    pub device_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ListFilter {
    #[default]
    All,
    Text,
    Image,
    Video,
    File,
}

impl ListFilter {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("all") {
            "text" => ListFilter::Text,
            "image" => ListFilter::Image,
            "video" => ListFilter::Video,
            "file" => ListFilter::File,
            _ => ListFilter::All,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub pinned_only: bool,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub query: Option<String>,
    pub filter: ListFilter,
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub items: Vec<ClipItem>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub name: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMessage {
    ItemCreated {
        item: ClipItem,
    },
    ItemUpdated {
        item: ClipItem,
    },
    ItemDeleted {
        id: String,
    },
    SyncRequest {
        items: SyncSnapshot,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub history: Vec<ClipItem>,
    pub pinned: Vec<ClipItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub server_url: String,
    pub run_local_server: bool,
    pub device_name: String,
    pub auto_sync: bool,
    pub launch_at_login: bool,
    pub auto_update: bool,
    pub port: u16,
    pub hotkey: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        let host = hostname::get()
            .ok()
            .and_then(|s| s.into_string().ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "SyncBoard".to_string());
        Self {
            server_url: "http://127.0.0.1:8787".to_string(),
            run_local_server: true,
            device_name: host,
            auto_sync: true,
            launch_at_login: true,
            auto_update: true,
            port: 8787,
            hotkey: "Alt+V".to_string(),
        }
    }
}

pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
