use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tokio::sync::broadcast;

use crate::models::{ClipItem, WsMessage};

pub struct Hub {
    tx: broadcast::Sender<String>,
    next_id: AtomicU64,
    devices: Mutex<HashMap<u64, String>>,
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            next_id: AtomicU64::new(1),
            devices: Mutex::new(HashMap::new()),
        }
    }

    pub fn next_client_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub fn set_device_name(&self, client_id: u64, name: String) {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let mut map = self.devices.lock().unwrap();
        map.insert(client_id, trimmed);
    }

    pub fn remove_client(&self, client_id: u64) {
        let mut map = self.devices.lock().unwrap();
        map.remove(&client_id);
    }

    pub fn online_device_names(&self) -> Vec<String> {
        let map = self.devices.lock().unwrap();
        let set: HashSet<String> = map.values().filter(|s| !s.is_empty()).cloned().collect();
        let mut list: Vec<String> = set.into_iter().collect();
        list.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
        list
    }

    pub fn broadcast(&self, message: &WsMessage) {
        if let Ok(payload) = serde_json::to_string(message) {
            let _ = self.tx.send(payload);
        }
    }

    pub fn notify_item_created(&self, item: ClipItem) {
        self.broadcast(&WsMessage::ItemCreated { item });
    }

    pub fn notify_item_updated(&self, item: ClipItem) {
        self.broadcast(&WsMessage::ItemUpdated { item });
    }

    pub fn notify_item_deleted(&self, id: String) {
        self.broadcast(&WsMessage::ItemDeleted { id });
    }
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}
