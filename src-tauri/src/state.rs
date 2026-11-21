use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use syncboard_core::hub::Hub;
use syncboard_core::models::DesktopConfig;
use syncboard_core::pair::PairService;
use syncboard_core::store::ClipStore;
use syncboard_core::update::UpdateChecker;
use tokio::sync::watch;

use crate::clipboard::RecentHashes;
use crate::recorder::ScreenRecorder;
use crate::video::VideoConverter;

pub struct AppShared {
    pub app_root: PathBuf,
    pub config_path: PathBuf,
    pub config: Mutex<DesktopConfig>,
    pub store: Arc<ClipStore>,
    pub hub: Arc<Hub>,
    pub pair: Mutex<Option<Arc<PairService>>>,
    pub server_stop: Mutex<Option<watch::Sender<bool>>>,
    pub remote_stop: Mutex<Option<watch::Sender<bool>>>,
    pub updater: Arc<UpdateChecker>,
    pub recent_hashes: RecentHashes,
    pub connected: AtomicBool,
    pub video: VideoConverter,
    pub recorder: ScreenRecorder,
    pub allowed_outputs: Mutex<HashSet<String>>,
    pub client_dist: Option<PathBuf>,
}

impl AppShared {
    pub fn get_config(&self) -> DesktopConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn api_base(&self) -> String {
        let cfg = self.get_config();
        format!("{}/api", cfg.server_url.trim_end_matches('/'))
    }

    pub fn ws_url(&self) -> String {
        let cfg = self.get_config();
        let base = cfg.server_url.trim_end_matches('/');
        if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}/ws")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}/ws")
        } else {
            format!("ws://{base}/ws")
        }
    }
}
