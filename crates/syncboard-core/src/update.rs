use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::models::now_millis;

const CACHE_MS: i64 = 30 * 60 * 1000;
const DEFAULT_OWNER: &str = "jailsonpaca";
const DEFAULT_REPO: &str = "syncboard";
const DEFAULT_DOWNLOAD_URL: &str = "https://syncboard.jpinnovation.com.br";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAssets {
    pub mac_dmg: Option<String>,
    pub mac_zip: Option<String>,
    pub linux_app_image: Option<String>,
    pub linux_tar: Option<String>,
    pub win_setup: Option<String>,
    pub win_zip: Option<String>,
    pub android_apk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestManifest {
    pub version: String,
    pub published_at: Option<String>,
    pub download_page: Option<String>,
    pub release_notes: Option<String>,
    pub assets: Option<ReleaseAssets>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: Option<String>,
    pub update_available: bool,
    pub download_page: Option<String>,
    pub release_notes: Option<String>,
    pub assets: Option<ReleaseAssets>,
    pub published_at: Option<String>,
    pub checked_at: i64,
    pub error: Option<String>,
}

#[derive(Default)]
struct UpdateCache {
    checked_at: i64,
    manifest: Option<LatestManifest>,
    error: Option<String>,
}

pub struct UpdateChecker {
    current_version: String,
    owner: String,
    repo: String,
    download_url: String,
    cache: Mutex<UpdateCache>,
}

impl UpdateChecker {
    pub fn new(current_version: impl Into<String>) -> Self {
        let owner = std::env::var("SYNCBOARD_GH_OWNER").unwrap_or_else(|_| DEFAULT_OWNER.to_string());
        let repo = std::env::var("SYNCBOARD_GH_REPO").unwrap_or_else(|_| DEFAULT_REPO.to_string());
        Self {
            current_version: current_version.into(),
            owner,
            repo,
            download_url: DEFAULT_DOWNLOAD_URL.to_string(),
            cache: Mutex::new(UpdateCache::default()),
        }
    }

    pub fn current_version(&self) -> &str {
        &self.current_version
    }

    pub async fn get_status(&self, force: bool) -> UpdateStatus {
        let manifest = self.fetch_latest(force).await;
        let cache = self.cache.lock().unwrap();
        let update_available = manifest
            .as_ref()
            .map(|m| is_newer(&m.version, &self.current_version))
            .unwrap_or(false);

        UpdateStatus {
            current: self.current_version.clone(),
            latest: manifest.as_ref().map(|m| m.version.clone()),
            update_available,
            download_page: manifest
                .as_ref()
                .and_then(|m| m.download_page.clone())
                .or_else(|| Some(self.download_url.clone())),
            release_notes: manifest.as_ref().and_then(|m| m.release_notes.clone()),
            assets: manifest.as_ref().and_then(|m| m.assets.clone()),
            published_at: manifest.as_ref().and_then(|m| m.published_at.clone()),
            checked_at: cache.checked_at,
            error: cache.error.clone(),
        }
    }

    async fn fetch_latest(&self, force: bool) -> Option<LatestManifest> {
        {
            let cache = self.cache.lock().unwrap();
            if !force && cache.manifest.is_some() && now_millis() - cache.checked_at < CACHE_MS {
                return cache.manifest.clone();
            }
        }

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("SyncBoard-Server")
            .build()
            .ok()?;

        let urls = [
            format!(
                "https://github.com/{}/{}/releases/latest/download/latest.json",
                self.owner, self.repo
            ),
            format!(
                "https://api.github.com/repos/{}/{}/releases/latest",
                self.owner, self.repo
            ),
        ];

        let mut last_err = None;
        for url in urls {
            match client
                .get(&url)
                .header("Accept", "application/json")
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    if let Ok(val) = res.json::<serde_json::Value>().await {
                        if let Some(manifest) = self.parse_manifest(val) {
                            let mut cache = self.cache.lock().unwrap();
                            cache.checked_at = now_millis();
                            cache.manifest = Some(manifest.clone());
                            cache.error = None;
                            return Some(manifest);
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => last_err = Some(e.to_string()),
            }
        }

        let mut cache = self.cache.lock().unwrap();
        cache.checked_at = now_millis();
        cache.error = last_err;
        cache.manifest.clone()
    }

    fn parse_manifest(&self, val: serde_json::Value) -> Option<LatestManifest> {
        if val.get("version").and_then(|v| v.as_str()).is_some()
            && val.get("assets").map(|a| a.is_object()).unwrap_or(false)
        {
            let mut m: LatestManifest = serde_json::from_value(val).ok()?;
            if m.download_page.is_none() {
                m.download_page = Some(self.download_url.clone());
            }
            return Some(m);
        }

        if let Some(tag) = val.get("tag_name").and_then(|v| v.as_str()) {
            let version = tag.trim_start_matches('v').to_string();
            let assets_arr = val.get("assets").and_then(|a| a.as_array());
            let find = |suffix: &str| -> Option<String> {
                assets_arr?
                    .iter()
                    .find(|a| {
                        a.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| n.to_lowercase().ends_with(suffix))
                            .unwrap_or(false)
                    })
                    .and_then(|a| a.get("browser_download_url").and_then(|u| u.as_str()))
                    .map(|s| s.to_string())
            };

            return Some(LatestManifest {
                version,
                published_at: val
                    .get("published_at")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                download_page: Some(self.download_url.clone()),
                release_notes: val
                    .get("body")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string()),
                assets: Some(ReleaseAssets {
                    mac_dmg: find(".dmg"),
                    mac_zip: find("-mac.zip"),
                    linux_app_image: find(".appimage"),
                    linux_tar: find(".tar.gz"),
                    win_setup: find(".exe"),
                    win_zip: find("-win.zip"),
                    android_apk: find(".apk"),
                }),
            });
        }

        None
    }
}

pub fn parse_version(v: &str) -> Vec<u32> {
    v.trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().unwrap_or(0)
        })
        .collect()
}

pub fn is_newer(remote: &str, local: &str) -> bool {
    let a = parse_version(remote);
    let b = parse_version(local);
    let len = a.len().max(b.len());
    for i in 0..len {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        if x > y {
            return true;
        }
        if x < y {
            return false;
        }
    }
    false
}
