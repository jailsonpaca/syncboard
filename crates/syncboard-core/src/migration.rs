use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::models::{now_millis, ClipItem, DesktopConfig, ItemType, MAX_HISTORY_ITEMS};
use crate::store::ClipStore;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub migrated_at: i64,
    pub sources_checked: Vec<String>,
    pub sources_imported: Vec<String>,
    pub pinned_imported: usize,
    pub history_imported: usize,
    pub blobs_copied: usize,
    pub config_migrated: bool,
    pub backup_dir: Option<String>,
    pub final_pinned_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LegacySources {
    /// Caminhos de arquivos `syncboard.db` legados (com seus respectivos `blobs/` irmãos).
    pub sqlite_dbs: Vec<PathBuf>,
    /// Caminhos de arquivos `offline-cache.json` legados (com `offline-blobs/` irmão).
    pub offline_caches: Vec<PathBuf>,
    /// Caminho para `config.json` do electron-store.
    pub config_json: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineCacheFile {
    #[serde(default)]
    pinned: Vec<OfflineCacheItem>,
    #[serde(default)]
    history: Vec<OfflineCacheItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineCacheItem {
    id: String,
    #[serde(rename = "type")]
    item_type: String,
    content: Option<String>,
    filename: Option<String>,
    mime_type: Option<String>,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    pinned: bool,
    label: Option<String>,
    device_name: Option<String>,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

impl OfflineCacheItem {
    fn into_clip_item(self) -> ClipItem {
        let now = now_millis();
        ClipItem {
            id: self.id,
            item_type: ItemType::from_db(&self.item_type),
            content: self.content,
            filename: self.filename,
            mime_type: self.mime_type,
            size: self.size,
            pinned: self.pinned,
            label: self.label,
            device_name: self.device_name,
            created_at: if self.created_at > 0 { self.created_at } else { now },
            updated_at: if self.updated_at > 0 { self.updated_at } else { now },
        }
    }
}

/// Descobre automaticamente todas as fontes legadas do SyncBoard (Electron + servidor Node standalone).
pub fn discover_legacy_sources(extra_repo_root: Option<&Path>) -> LegacySources {
    let mut out = LegacySources::default();
    let mut seen_dbs = HashSet::new();

    let mut push_db = |p: PathBuf| {
        if p.exists() && seen_dbs.insert(p.clone()) {
            out.sqlite_dbs.push(p);
        }
    };

    // 1. Variável de ambiente SYNCBOARD_LEGACY_DATA ou SYNCBOARD_DATA
    for env_key in ["SYNCBOARD_LEGACY_DATA", "SYNCBOARD_DATA"] {
        if let Ok(dir) = std::env::var(env_key) {
            push_db(PathBuf::from(dir).join("syncboard.db"));
        }
    }

    // 2. Servidor standalone no repositório local (ex.: ~/mesa/projects/syncboard/server/data/syncboard.db)
    if let Some(root) = extra_repo_root {
        push_db(root.join("server").join("data").join("syncboard.db"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_db(cwd.join("server").join("data").join("syncboard.db"));
        if let Some(parent) = cwd.parent() {
            push_db(parent.join("server").join("data").join("syncboard.db"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        for candidate in [
            home.join("mesa/projects/syncboard/server/data/syncboard.db"),
            home.join("Projects/syncboard/server/data/syncboard.db"),
            home.join("syncboard/server/data/syncboard.db"),
        ] {
            push_db(candidate);
        }
    }

    // 3. Pasta de dados do app Electron empacotado (syncboard-desktop / SyncBoard)
    let mut electron_roots: Vec<PathBuf> = Vec::new();
    if let Some(cfg_dir) = dirs::config_dir() {
        electron_roots.push(cfg_dir.join("syncboard-desktop"));
        electron_roots.push(cfg_dir.join("SyncBoard"));
    }
    if let Some(data_dir) = dirs::data_dir() {
        electron_roots.push(data_dir.join("syncboard-desktop"));
        electron_roots.push(data_dir.join("SyncBoard"));
    }

    let mut seen_roots = HashSet::new();
    for root in electron_roots {
        if !root.exists() || !seen_roots.insert(root.clone()) {
            continue;
        }
        push_db(root.join("data").join("syncboard.db"));
        push_db(root.join("server-data").join("syncboard.db"));

        let offline = root.join("offline").join("offline-cache.json");
        if offline.exists() && !out.offline_caches.contains(&offline) {
            out.offline_caches.push(offline);
        }

        let cfg = root.join("config.json");
        if out.config_json.is_none() && cfg.exists() {
            out.config_json = Some(cfg);
        }
    }

    out
}

/// Lê todos os itens de um SQLite legado (incluindo WAL ativo) sem modificar o arquivo de origem.
fn read_items_from_sqlite(db_path: &Path) -> Result<Vec<ClipItem>, String> {
    // Abrir em READ_ONLY garante leitura de syncboard.db + -wal + -shm sem escrever no legado.
    // Se o SQLite exigir acesso de escrita para ler WAL de outro processo, cai para abertura normal.
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .or_else(|_| Connection::open(db_path))
    .map_err(|e| format!("Falha ao abrir {}: {e}", db_path.display()))?;

    let mut stmt = conn
        .prepare("SELECT id, type, content, filename, mime_type, size, pinned, label, device_name, created_at, updated_at FROM items")
        .map_err(|e| format!("Falha ao consultar {}: {e}", db_path.display()))?;

    let rows = stmt
        .query_map([], |row| {
            let ty: String = row.get("type")?;
            let pinned_int: i64 = row.get("pinned")?;
            Ok(ClipItem {
                id: row.get("id")?,
                item_type: ItemType::from_db(&ty),
                content: row.get("content")?,
                filename: row.get("filename")?,
                mime_type: row.get("mime_type")?,
                size: row.get("size")?,
                pinned: pinned_int == 1,
                label: row.get("label")?,
                device_name: row.get("device_name")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|e| format!("Falha ao iterar {}: {e}", db_path.display()))?;

    let mut items = Vec::new();
    for r in rows {
        items.push(r.map_err(|e| e.to_string())?);
    }
    Ok(items)
}

fn copy_blob_if_exists(src_dir: &Path, dst_dir: &Path, id: &str) -> bool {
    let src = src_dir.join(id);
    if !src.is_file() {
        return false;
    }
    let dst = dst_dir.join(id);
    if dst.exists() {
        return false;
    }
    fs::copy(&src, &dst).is_ok()
}

/// Executa migração idempotente e segura (com backup prévio) de todas as fontes legadas
/// para o `store` alvo e grava `config.json` migrado em `config_target_path` (se ainda não existir).
pub fn migrate_legacy_data(
    store: &ClipStore,
    config_target_path: &Path,
    sources: &LegacySources,
    force: bool,
) -> Result<MigrationReport, String> {
    let marker_path = store.data_dir().join("migration-report.json");
    if !force && marker_path.exists() {
        if let Ok(raw) = fs::read_to_string(&marker_path) {
            if let Ok(existing) = serde_json::from_str::<MigrationReport>(&raw) {
                return Ok(existing);
            }
        }
    }

    let mut report = MigrationReport {
        migrated_at: now_millis(),
        ..Default::default()
    };

    let target_db_canon = fs::canonicalize(store.data_dir().join("syncboard.db")).ok();

    let has_any_source = !sources.sqlite_dbs.is_empty()
        || !sources.offline_caches.is_empty()
        || sources.config_json.is_some();
    if !has_any_source {
        report.final_pinned_count = store.count_pinned().unwrap_or(0);
        return Ok(report);
    }

    // 1. Backup prévio de segurança (cópia somente-leitura das fontes + dump JSON dos fixos)
    let backup_dir = store
        .data_dir()
        .join("migration-backups")
        .join(format!("{}", report.migrated_at));
    let _ = fs::create_dir_all(&backup_dir);
    report.backup_dir = Some(backup_dir.display().to_string());

    let mut all_pinned_ids: HashSet<String> = HashSet::new();
    let mut all_history_ids: HashSet<String> = HashSet::new();
    let mut pinned_backup_items: Vec<ClipItem> = Vec::new();

    // 2. Migrar bancos SQLite legados (lendo WAL completamente)
    for (idx, db_path) in sources.sqlite_dbs.iter().enumerate() {
        report.sources_checked.push(db_path.display().to_string());

        // Evita migrar o próprio banco alvo sobre si mesmo
        if let (Some(ref target), Ok(src_canon)) = (&target_db_canon, fs::canonicalize(db_path)) {
            if target == &src_canon {
                continue;
            }
        }

        // Copia backup bruto (.db + -wal + -shm se existirem)
        if let Some(fname) = db_path.file_name().and_then(|s| s.to_str()) {
            let _ = fs::copy(db_path, backup_dir.join(format!("legacy-{idx}-{fname}")));
            for suffix in ["-wal", "-shm"] {
                let sidecar = PathBuf::from(format!("{}{suffix}", db_path.display()));
                if sidecar.exists() {
                    let _ = fs::copy(&sidecar, backup_dir.join(format!("legacy-{idx}-{fname}{suffix}")));
                }
            }
        }

        match read_items_from_sqlite(db_path) {
            Ok(items) => {
                let blobs_src = db_path.parent().map(|p| p.join("blobs"));
                for item in items {
                    if item.item_type != ItemType::Text {
                        if let Some(ref bsrc) = blobs_src {
                            if copy_blob_if_exists(bsrc, store.blobs_dir(), &item.id) {
                                report.blobs_copied += 1;
                            }
                        }
                    }
                    if item.pinned {
                        if all_pinned_ids.insert(item.id.clone()) {
                            pinned_backup_items.push(item.clone());
                        }
                    } else {
                        all_history_ids.insert(item.id.clone());
                    }
                    if let Err(e) = store.upsert_preserving_pinned(&item) {
                        report
                            .warnings
                            .push(format!("Erro ao importar item {}: {e}", item.id));
                    }
                }
                report.sources_imported.push(db_path.display().to_string());
            }
            Err(e) => report.warnings.push(e),
        }
    }

    // 3. Migrar offline-cache.json (garantia adicional para itens fixados / offline)
    for (idx, cache_path) in sources.offline_caches.iter().enumerate() {
        report.sources_checked.push(cache_path.display().to_string());
        let _ = fs::copy(
            cache_path,
            backup_dir.join(format!("legacy-{idx}-offline-cache.json")),
        );

        match fs::read_to_string(cache_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<OfflineCacheFile>(&s).map_err(|e| e.to_string()))
        {
            Ok(cache) => {
                let blobs_src = cache_path.parent().map(|p| p.join("offline-blobs"));
                for raw in cache.pinned.into_iter().chain(cache.history.into_iter()) {
                    let item = raw.into_clip_item();
                    if item.item_type != ItemType::Text {
                        if let Some(ref bsrc) = blobs_src {
                            if copy_blob_if_exists(bsrc, store.blobs_dir(), &item.id) {
                                report.blobs_copied += 1;
                            }
                        }
                    }
                    if item.pinned {
                        if all_pinned_ids.insert(item.id.clone()) {
                            pinned_backup_items.push(item.clone());
                        }
                    } else {
                        all_history_ids.insert(item.id.clone());
                    }
                    if let Err(e) = store.upsert_preserving_pinned(&item) {
                        report
                            .warnings
                            .push(format!("Erro ao importar item offline {}: {e}", item.id));
                    }
                }
                report.sources_imported.push(cache_path.display().to_string());
            }
            Err(e) => report.warnings.push(format!(
                "Falha ao ler {}: {e}",
                cache_path.display()
            )),
        }
    }

    // Salva backup legível JSON de TODOS os itens fixados descobertos
    if !pinned_backup_items.is_empty() {
        if let Ok(json) = serde_json::to_string_pretty(&pinned_backup_items) {
            let _ = fs::write(backup_dir.join("pinned-backup.json"), json);
        }
    }

    // Mantém histórico dentro do limite (nunca toca em pinned = 1!)
    let _ = store.trim_history(MAX_HISTORY_ITEMS);

    // 4. Migrar config.json do electron-store
    if let Some(ref src_cfg) = sources.config_json {
        report.sources_checked.push(src_cfg.display().to_string());
        let _ = fs::copy(src_cfg, backup_dir.join("legacy-config.json"));
        if !config_target_path.exists() {
            if let Ok(raw) = fs::read_to_string(src_cfg) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let mut cfg = DesktopConfig::default();
                    if let Some(v) = val.get("serverUrl").and_then(|x| x.as_str()) {
                        cfg.server_url = v.to_string();
                    }
                    if let Some(v) = val.get("runLocalServer").and_then(|x| x.as_bool()) {
                        cfg.run_local_server = v;
                    }
                    if let Some(v) = val.get("deviceName").and_then(|x| x.as_str()) {
                        cfg.device_name = v.to_string();
                    }
                    if let Some(v) = val.get("autoSync").and_then(|x| x.as_bool()) {
                        cfg.auto_sync = v;
                    }
                    if let Some(v) = val.get("launchAtLogin").and_then(|x| x.as_bool()) {
                        cfg.launch_at_login = v;
                    }
                    if let Some(v) = val.get("autoUpdate").and_then(|x| x.as_bool()) {
                        cfg.auto_update = v;
                    }
                    if let Some(v) = val.get("port").and_then(|x| x.as_u64()) {
                        if (1024..=65535).contains(&v) {
                            cfg.port = v as u16;
                        }
                    }
                    if let Some(v) = val.get("hotkey").and_then(|x| x.as_str()) {
                        if !v.trim().is_empty() {
                            cfg.hotkey = v.to_string();
                        }
                    }
                    if let Some(parent) = config_target_path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if let Ok(pretty) = serde_json::to_string_pretty(&cfg) {
                        if fs::write(config_target_path, pretty).is_ok() {
                            report.config_migrated = true;
                            report.sources_imported.push(src_cfg.display().to_string());
                        }
                    }
                }
            }
        }
    }

    report.pinned_imported = all_pinned_ids.len();
    report.history_imported = all_history_ids.len();
    report.final_pinned_count = store.count_pinned().unwrap_or(0);

    if report.final_pinned_count < all_pinned_ids.len() {
        return Err(format!(
            "Verificação pós-migração falhou: esperado pelo menos {} fixados, encontrado {}",
            all_pinned_ids.len(),
            report.final_pinned_count
        ));
    }

    if let Ok(pretty) = serde_json::to_string_pretty(&report) {
        let _ = fs::write(&marker_path, pretty);
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn migrates_wal_sqlite_pinned_and_offline_cache_and_config() {
        let legacy_dir = tempdir().unwrap();
        let target_dir = tempdir().unwrap();

        // 1. Cria DB legado em modo WAL com 2 itens fixados e 1 imagem + blob
        let legacy_server = legacy_dir.path().join("server_data");
        fs::create_dir_all(legacy_server.join("blobs")).unwrap();
        let legacy_db = legacy_server.join("syncboard.db");
        {
            let conn = Connection::open(&legacy_db).unwrap();
            conn.pragma_update(None, "journal_mode", "WAL").unwrap();
            // Desabilita autocheckpoint para garantir que dados fiquem no arquivo -wal!
            conn.pragma_update(None, "wal_autocheckpoint", 0i64).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE items (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    content TEXT,
                    filename TEXT,
                    mime_type TEXT,
                    size INTEGER NOT NULL DEFAULT 0,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    label TEXT,
                    device_name TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO items VALUES ('pin-wal-1','text','conteudo-dcr',NULL,'text/plain',12,1,'DCR','Mac',100,200);
                INSERT INTO items VALUES ('pin-wal-2','image',NULL,'logo.png','image/png',4,1,'Logo','Mac',101,201);
                INSERT INTO items VALUES ('hist-1','text','oi',NULL,'text/plain',2,0,NULL,'Linux',102,202);
                "#,
            )
            .unwrap();
            fs::write(legacy_server.join("blobs").join("pin-wal-2"), b"PNG!").unwrap();

            // Mantém a conexão aberta enquanto migramos (simulando servidor Node rodando com WAL ativo!)
            let offline_dir = legacy_dir.path().join("offline");
            fs::create_dir_all(offline_dir.join("offline-blobs")).unwrap();
            let offline_json = offline_dir.join("offline-cache.json");
            fs::write(
                &offline_json,
                serde_json::json!({
                    "pinned": [
                        {
                            "id": "pin-offline-only",
                            "type": "text",
                            "content": "senha-extra",
                            "mimeType": "text/plain",
                            "size": 11,
                            "pinned": true,
                            "label": "Extra",
                            "deviceName": "Vostro",
                            "createdAt": 105,
                            "updatedAt": 205
                        }
                    ],
                    "history": []
                })
                .to_string(),
            )
            .unwrap();

            let legacy_cfg = legacy_dir.path().join("config.json");
            fs::write(
                &legacy_cfg,
                r#"{"serverUrl":"http://127.0.0.1:8787","runLocalServer":true,"deviceName":"MeuMac","autoSync":true,"launchAtLogin":true,"autoUpdate":true,"port":8787,"hotkey":"Alt+V"}"#,
            )
            .unwrap();

            let store = ClipStore::open(target_dir.path().join("data")).unwrap();
            let target_cfg = target_dir.path().join("config.json");
            let sources = LegacySources {
                sqlite_dbs: vec![legacy_db.clone()],
                offline_caches: vec![offline_json],
                config_json: Some(legacy_cfg),
            };

            let report = migrate_legacy_data(&store, &target_cfg, &sources, false).unwrap();
            assert_eq!(report.pinned_imported, 3);
            assert_eq!(report.final_pinned_count, 3);
            assert_eq!(report.blobs_copied, 1);
            assert!(report.config_migrated);

            // Verifica que os 3 fixados existem e blob foi copiado
            let pinned = store.list(true, 100).unwrap();
            assert_eq!(pinned.len(), 3);
            assert!(store.get_blob_path("pin-wal-2").is_some());

            // Verifica config migrada
            let cfg: DesktopConfig =
                serde_json::from_str(&fs::read_to_string(&target_cfg).unwrap()).unwrap();
            assert_eq!(cfg.device_name, "MeuMac");
            assert_eq!(cfg.hotkey, "Alt+V");

            // Idempotência: 2ª execução não duplica nem falha
            let report2 = migrate_legacy_data(&store, &target_cfg, &sources, false).unwrap();
            assert_eq!(report2.final_pinned_count, 3);
            assert_eq!(store.count_pinned().unwrap(), 3);
            drop(conn);
        }
    }
}
