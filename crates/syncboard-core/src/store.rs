use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params_from_iter, types::Value, Connection, OptionalExtension, Row};
use thiserror::Error;

use crate::models::{now_millis, ClipItem, ItemType, ListFilter, ListOptions, ListResult, MAX_HISTORY_ITEMS};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone)]
pub struct CreateItemInput {
    pub id: String,
    pub item_type: ItemType,
    pub content: Option<String>,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: i64,
    pub pinned: bool,
    pub label: Option<String>,
    pub device_name: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateItemFields {
    pub label: Option<Option<String>>,
    pub pinned: Option<bool>,
    pub content: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct CreateResult {
    pub item: ClipItem,
    pub trimmed_ids: Vec<String>,
}

pub struct ClipStore {
    data_dir: PathBuf,
    blobs_dir: PathBuf,
    conn: Mutex<Connection>,
}

impl ClipStore {
    pub fn open(data_dir: impl AsRef<Path>) -> StoreResult<Self> {
        let data_dir = data_dir.as_ref().to_path_buf();
        let blobs_dir = data_dir.join("blobs");
        fs::create_dir_all(&blobs_dir)?;

        let db_path = data_dir.join("syncboard.db");
        let conn = Connection::open(&db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000i64)?;

        let store = Self {
            data_dir,
            blobs_dir,
            conn: Mutex::new(conn),
        };
        store.init()?;
        let _ = store.trim_history(MAX_HISTORY_ITEMS);
        Ok(store)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn blobs_dir(&self) -> &Path {
        &self.blobs_dir
    }

    fn init(&self) -> StoreResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK(type IN ('text', 'image', 'file')),
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
            CREATE INDEX IF NOT EXISTS idx_items_pinned ON items(pinned, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC);
            "#,
        )?;
        Ok(())
    }

    fn row_to_item(row: &Row<'_>) -> rusqlite::Result<ClipItem> {
        let item_type_str: String = row.get("type")?;
        let pinned_int: i64 = row.get("pinned")?;
        Ok(ClipItem {
            id: row.get("id")?,
            item_type: ItemType::from_db(&item_type_str),
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
    }

    pub fn list(&self, pinned_only: bool, limit: usize) -> StoreResult<Vec<ClipItem>> {
        let cap = if pinned_only { limit.max(1) } else { limit.clamp(1, MAX_HISTORY_ITEMS) };
        let res = self.list_page_unbounded(
            ListOptions {
                pinned_only,
                limit: Some(cap),
                offset: Some(0),
                ..Default::default()
            },
            pinned_only,
        )?;
        Ok(res.items)
    }

    pub fn list_page(&self, opts: ListOptions) -> StoreResult<ListResult> {
        self.list_page_unbounded(opts, false)
    }

    fn list_page_unbounded(&self, opts: ListOptions, allow_large_pinned: bool) -> StoreResult<ListResult> {
        let pinned_only = opts.pinned_only;
        let max_limit = if allow_large_pinned { 1000 } else { MAX_HISTORY_ITEMS };
        let limit = opts.limit.unwrap_or(20).clamp(1, max_limit);
        let offset = opts.offset.unwrap_or(0);

        let mut where_parts: Vec<String> = vec![if pinned_only {
            "pinned = 1".to_string()
        } else {
            "pinned = 0".to_string()
        }];
        let mut params: Vec<Value> = Vec::new();

        match opts.filter {
            ListFilter::Text => where_parts.push("type = 'text'".to_string()),
            ListFilter::Image => where_parts.push("type = 'image'".to_string()),
            ListFilter::Video => {
                where_parts.push("type = 'file' AND mime_type LIKE 'video/%'".to_string())
            }
            ListFilter::File => where_parts.push(
                "type = 'file' AND (mime_type IS NULL OR mime_type NOT LIKE 'video/%')".to_string(),
            ),
            ListFilter::All => {}
        }

        if let Some(q) = opts.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            where_parts.push(
                "(IFNULL(content, '') LIKE ? OR IFNULL(filename, '') LIKE ? OR IFNULL(label, '') LIKE ? OR IFNULL(device_name, '') LIKE ?)".to_string(),
            );
            let like = format!("%{q}%");
            for _ in 0..4 {
                params.push(Value::Text(like.clone()));
            }
        }

        if let Some(dev) = opts
            .device_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            where_parts.push("IFNULL(device_name, '') = ?".to_string());
            params.push(Value::Text(dev.to_string()));
        }

        let where_sql = where_parts.join(" AND ");
        let order_sql = if pinned_only {
            "ORDER BY label COLLATE NOCASE ASC, updated_at DESC"
        } else {
            "ORDER BY updated_at DESC"
        };

        let conn = self.conn.lock().unwrap();
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM items WHERE {where_sql}"),
            params_from_iter(params.iter()),
            |row| row.get(0),
        )?;

        let mut page_params = params;
        page_params.push(Value::Integer(limit as i64));
        page_params.push(Value::Integer(offset as i64));

        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM items WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?"
        ))?;
        let rows = stmt.query_map(params_from_iter(page_params.iter()), Self::row_to_item)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r?);
        }

        Ok(ListResult {
            items,
            total: total.max(0) as usize,
            limit,
            offset,
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<ClipItem>> {
        let conn = self.conn.lock().unwrap();
        let item = conn
            .query_row("SELECT * FROM items WHERE id = ?", [id], Self::row_to_item)
            .optional()?;
        Ok(item)
    }

    pub fn create(&self, input: CreateItemInput) -> StoreResult<CreateResult> {
        let now = now_millis();
        let created_at = input.created_at.unwrap_or(now);
        let updated_at = input.updated_at.unwrap_or(now);

        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                r#"
                INSERT INTO items (id, type, content, filename, mime_type, size, pinned, label, device_name, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                "#,
                rusqlite::params![
                    input.id,
                    input.item_type.as_str(),
                    input.content,
                    input.filename,
                    input.mime_type,
                    input.size,
                    if input.pinned { 1 } else { 0 },
                    input.label,
                    input.device_name,
                    created_at,
                    updated_at,
                ],
            )?;
        }

        let trimmed_ids = if input.pinned {
            Vec::new()
        } else {
            self.trim_history(MAX_HISTORY_ITEMS)?
        };
        let item = self.get(&input.id)?.expect("inserted item must exist");
        Ok(CreateResult { item, trimmed_ids })
    }

    /// Upsert usado na migração ou sincronização de snapshots (preserva `pinned = 1` se qualquer lado estiver fixado).
    pub fn upsert_preserving_pinned(&self, item: &ClipItem) -> StoreResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO items (id, type, content, filename, mime_type, size, pinned, label, device_name, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
                content = COALESCE(excluded.content, items.content),
                filename = COALESCE(excluded.filename, items.filename),
                mime_type = COALESCE(excluded.mime_type, items.mime_type),
                size = CASE WHEN excluded.size > 0 THEN excluded.size ELSE items.size END,
                pinned = CASE WHEN items.pinned = 1 OR excluded.pinned = 1 THEN 1 ELSE 0 END,
                label = COALESCE(excluded.label, items.label),
                device_name = COALESCE(excluded.device_name, items.device_name),
                created_at = MIN(items.created_at, excluded.created_at),
                updated_at = MAX(items.updated_at, excluded.updated_at)
            "#,
            rusqlite::params![
                item.id,
                item.item_type.as_str(),
                item.content,
                item.filename,
                item.mime_type,
                item.size,
                if item.pinned { 1 } else { 0 },
                item.label,
                item.device_name,
                item.created_at,
                item.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update(&self, id: &str, fields: UpdateItemFields) -> StoreResult<Option<ClipItem>> {
        let Some(existing) = self.get(id)? else {
            return Ok(None);
        };
        let label = fields.label.unwrap_or(existing.label);
        let pinned = fields.pinned.unwrap_or(existing.pinned);
        let content = fields.content.unwrap_or(existing.content);
        let updated_at = now_millis();

        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE items SET label = ?1, pinned = ?2, content = ?3, updated_at = ?4 WHERE id = ?5",
                rusqlite::params![label, if pinned { 1 } else { 0 }, content, updated_at, id],
            )?;
        }

        self.get(id)
    }

    pub fn touch(&self, id: &str) -> StoreResult<Option<ClipItem>> {
        if self.get(id)?.is_none() {
            return Ok(None);
        }
        let updated_at = now_millis();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE items SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![updated_at, id],
            )?;
        }
        self.get(id)
    }

    pub fn delete(&self, id: &str) -> StoreResult<Option<ClipItem>> {
        let Some(item) = self.get(id)? else {
            return Ok(None);
        };
        {
            let conn = self.conn.lock().unwrap();
            conn.execute("DELETE FROM items WHERE id = ?1", [id])?;
        }
        self.remove_blob(id, item.item_type);
        Ok(Some(item))
    }

    pub fn save_blob(&self, id: &str, bytes: &[u8]) -> StoreResult<PathBuf> {
        let p = self.blobs_dir.join(id);
        fs::write(&p, bytes)?;
        Ok(p)
    }

    pub fn blob_path(&self, id: &str) -> PathBuf {
        self.blobs_dir.join(id)
    }

    pub fn get_blob_path(&self, id: &str) -> Option<PathBuf> {
        let p = self.blobs_dir.join(id);
        p.exists().then_some(p)
    }

    fn remove_blob(&self, id: &str, item_type: ItemType) {
        if item_type == ItemType::Text {
            return;
        }
        let p = self.blobs_dir.join(id);
        let _ = fs::remove_file(p);
    }

    pub fn list_device_names(&self) -> StoreResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT DISTINCT device_name AS name FROM items
            WHERE device_name IS NOT NULL AND TRIM(device_name) != ''
            ORDER BY device_name COLLATE NOCASE ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut names = Vec::new();
        for r in rows {
            names.push(r?);
        }
        Ok(names)
    }

    pub fn trim_history(&self, max_items: usize) -> StoreResult<Vec<String>> {
        let stale: Vec<(String, ItemType)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                r#"
                SELECT id, type FROM items WHERE pinned = 0 AND id NOT IN (
                    SELECT id FROM items WHERE pinned = 0 ORDER BY updated_at DESC LIMIT ?1
                )
                "#,
            )?;
            let rows = stmt.query_map([max_items as i64], |row| {
                let id: String = row.get(0)?;
                let ty: String = row.get(1)?;
                Ok((id, ItemType::from_db(&ty)))
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            out
        };

        if stale.is_empty() {
            return Ok(Vec::new());
        }

        let mut removed = Vec::with_capacity(stale.len());
        {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction()?;
            {
                let mut del = tx.prepare("DELETE FROM items WHERE id = ?1")?;
                for (id, ty) in &stale {
                    del.execute([id])?;
                    self.remove_blob(id, *ty);
                    removed.push(id.clone());
                }
            }
            tx.commit()?;
        }

        Ok(removed)
    }

    pub fn count_pinned(&self) -> StoreResult<usize> {
        let conn = self.conn.lock().unwrap();
        let c: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE pinned = 1", [], |r| r.get(0))?;
        Ok(c.max(0) as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn crud_trim_and_pinned_preservation() {
        let dir = tempdir().unwrap();
        let store = ClipStore::open(dir.path()).unwrap();

        // Create pinned item
        let pinned = store
            .create(CreateItemInput {
                id: "pin-1".into(),
                item_type: ItemType::Text,
                content: Some("segredo".into()),
                filename: None,
                mime_type: Some("text/plain".into()),
                size: 7,
                pinned: true,
                label: Some("Senha".into()),
                device_name: Some("Mac".into()),
                created_at: Some(100),
                updated_at: Some(100),
            })
            .unwrap();
        assert!(pinned.item.pinned);

        // Create 105 history items — trim should keep 100 and never touch pinned
        for i in 0..105 {
            store
                .create(CreateItemInput {
                    id: format!("h-{i}"),
                    item_type: ItemType::Text,
                    content: Some(format!("texto {i}")),
                    filename: None,
                    mime_type: Some("text/plain".into()),
                    size: 10,
                    pinned: false,
                    label: None,
                    device_name: Some("Mac".into()),
                    created_at: Some(1000 + i),
                    updated_at: Some(1000 + i),
                })
                .unwrap();
        }

        let hist = store.list_page(ListOptions { pinned_only: false, limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(hist.total, 100);

        let pins = store.list_page(ListOptions { pinned_only: true, limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(pins.total, 1);
        assert_eq!(pins.items[0].id, "pin-1");
    }
}
