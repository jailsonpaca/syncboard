import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ClipItem, ItemType } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SYNCBOARD_DATA || path.join(__dirname, '..', 'data');
const BLOBS_DIR = path.join(DATA_DIR, 'blobs');

/** Limite máximo de itens no histórico (não fixos). */
export const MAX_HISTORY_ITEMS = 100;

export type ListFilter = 'all' | 'text' | 'image' | 'video' | 'file';

export interface ListOptions {
  pinnedOnly?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
  filter?: ListFilter;
}

export interface ListResult {
  items: ClipItem[];
  total: number;
  limit: number;
  offset: number;
}

export function ensureDataDirs(): void {
  fs.mkdirSync(BLOBS_DIR, { recursive: true });
}

export function getBlobsDir(): string {
  return BLOBS_DIR;
}

interface Row {
  id: string;
  type: ItemType;
  content: string | null;
  filename: string | null;
  mime_type: string | null;
  size: number;
  pinned: number;
  label: string | null;
  device_name: string | null;
  created_at: number;
  updated_at: number;
}

function rowToItem(row: Row): ClipItem {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    pinned: row.pinned === 1,
    label: row.label,
    deviceName: row.device_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildFilterClause(filter: ListFilter | undefined, pinnedOnly: boolean): { sql: string; params: unknown[] } {
  const parts: string[] = [pinnedOnly ? 'pinned = 1' : 'pinned = 0'];
  const params: unknown[] = [];

  switch (filter) {
    case 'text':
      parts.push(`type = 'text'`);
      break;
    case 'image':
      parts.push(`type = 'image'`);
      break;
    case 'video':
      parts.push(`type = 'file' AND mime_type LIKE 'video/%'`);
      break;
    case 'file':
      parts.push(`type = 'file' AND (mime_type IS NULL OR mime_type NOT LIKE 'video/%')`);
      break;
    default:
      break;
  }

  return { sql: parts.join(' AND '), params };
}

export class ClipStore {
  private db: Database.Database;

  constructor() {
    ensureDataDirs();
    this.db = new Database(path.join(DATA_DIR, 'syncboard.db'));
    this.db.pragma('journal_mode = WAL');
    this.init();
    // Limpa histórico antigo ao iniciar (migração do limite 200 → 100)
    this.trimHistory(MAX_HISTORY_ITEMS);
  }

  private init(): void {
    this.db.exec(`
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
    `);
  }

  list(pinnedOnly = false, limit = MAX_HISTORY_ITEMS): ClipItem[] {
    return this.listPage({ pinnedOnly, limit, offset: 0 }).items;
  }

  listPage(opts: ListOptions = {}): ListResult {
    const pinnedOnly = Boolean(opts.pinnedOnly);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_HISTORY_ITEMS);
    const offset = Math.max(opts.offset ?? 0, 0);
    const filter = opts.filter ?? 'all';
    const query = opts.query?.trim();

    const { sql: whereBase, params: baseParams } = buildFilterClause(filter, pinnedOnly);
    const whereParts = [whereBase];
    const params: unknown[] = [...baseParams];

    if (query) {
      whereParts.push(`(
        IFNULL(content, '') LIKE ? OR
        IFNULL(filename, '') LIKE ? OR
        IFNULL(label, '') LIKE ? OR
        IFNULL(device_name, '') LIKE ?
      )`);
      const like = `%${query}%`;
      params.push(like, like, like, like);
    }

    const where = whereParts.join(' AND ');
    const order = pinnedOnly
      ? `ORDER BY label COLLATE NOCASE ASC, updated_at DESC`
      : `ORDER BY updated_at DESC`;

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM items WHERE ${where}`).get(...params) as { c: number }
    ).c;

    const rows = this.db
      .prepare(`SELECT * FROM items WHERE ${where} ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];

    return {
      items: rows.map(rowToItem),
      total,
      limit,
      offset,
    };
  }

  get(id: string): ClipItem | null {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToItem(row) : null;
  }

  create(item: Omit<ClipItem, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): {
    item: ClipItem;
    trimmedIds: string[];
  } {
    const now = Date.now();
    const createdAt = item.createdAt ?? now;
    const updatedAt = item.updatedAt ?? now;

    this.db.prepare(`
      INSERT INTO items (id, type, content, filename, mime_type, size, pinned, label, device_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.type,
      item.content,
      item.filename,
      item.mimeType,
      item.size,
      item.pinned ? 1 : 0,
      item.label,
      item.deviceName,
      createdAt,
      updatedAt
    );

    const trimmedIds = item.pinned ? [] : this.trimHistory(MAX_HISTORY_ITEMS);
    return { item: this.get(item.id)!, trimmedIds };
  }

  update(id: string, fields: Partial<Pick<ClipItem, 'label' | 'pinned' | 'content'>>): ClipItem | null {
    const existing = this.get(id);
    if (!existing) return null;

    const label = fields.label !== undefined ? fields.label : existing.label;
    const pinned = fields.pinned !== undefined ? fields.pinned : existing.pinned;
    const content = fields.content !== undefined ? fields.content : existing.content;
    const updatedAt = Date.now();

    this.db.prepare(`
      UPDATE items SET label = ?, pinned = ?, content = ?, updated_at = ? WHERE id = ?
    `).run(label, pinned ? 1 : 0, content, updatedAt, id);

    return this.get(id);
  }

  /** Move o item para o topo do histórico (updated_at = agora). */
  touch(id: string): ClipItem | null {
    const existing = this.get(id);
    if (!existing) return null;

    const updatedAt = Date.now();
    this.db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(updatedAt, id);
    return this.get(id);
  }

  delete(id: string): ClipItem | null {
    const item = this.get(id);
    if (!item) return null;

    this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
    this.removeBlob(id, item.type);

    return item;
  }

  saveBlob(id: string, buffer: Buffer): string {
    const blobPath = path.join(BLOBS_DIR, id);
    fs.writeFileSync(blobPath, buffer);
    return blobPath;
  }

  getBlobPath(id: string): string | null {
    const blobPath = path.join(BLOBS_DIR, id);
    return fs.existsSync(blobPath) ? blobPath : null;
  }

  private removeBlob(id: string, type: ItemType): void {
    if (type === 'text') return;
    const blobPath = path.join(BLOBS_DIR, id);
    if (fs.existsSync(blobPath)) {
      fs.unlinkSync(blobPath);
    }
  }

  /** Remove itens de histórico além do limite; retorna IDs removidos. */
  trimHistory(maxItems = MAX_HISTORY_ITEMS): string[] {
    const stale = this.db
      .prepare(
        `
      SELECT id, type FROM items WHERE pinned = 0 AND id NOT IN (
        SELECT id FROM items WHERE pinned = 0 ORDER BY updated_at DESC LIMIT ?
      )
    `
      )
      .all(maxItems) as { id: string; type: ItemType }[];

    if (!stale.length) return [];

    const del = this.db.prepare('DELETE FROM items WHERE id = ?');
    const removed: string[] = [];
    const tx = this.db.transaction(() => {
      for (const row of stale) {
        del.run(row.id);
        this.removeBlob(row.id, row.type);
        removed.push(row.id);
      }
    });
    tx();
    return removed;
  }
}
