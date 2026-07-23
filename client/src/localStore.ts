import type { ClipItem, ItemsPage, TypeFilter } from './types';

const CACHE_KEY = 'syncboard_items_cache_v1';
const MAX_HISTORY = 100;

type CacheData = {
  history: ClipItem[];
  pinned: ClipItem[];
  savedAt: number;
};

function load(): CacheData {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '');
    return {
      history: Array.isArray(raw.history) ? raw.history : [],
      pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
      savedAt: raw.savedAt || 0,
    };
  } catch {
    return { history: [], pinned: [], savedAt: 0 };
  }
}

function save(data: CacheData): void {
  const payload: CacheData = {
    history: data.history.slice(0, MAX_HISTORY),
    pinned: data.pinned,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Quota — tenta só textos/fixados
    const slim: CacheData = {
      history: payload.history
        .filter((i) => i.type === 'text')
        .slice(0, 40),
      pinned: payload.pinned.filter((i) => i.type === 'text' || Boolean(i.content)),
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(slim));
    } catch {
      /* ignore */
    }
  }
}

function upsert(list: ClipItem[], item: ClipItem): ClipItem[] {
  return [item, ...list.filter((i) => i.id !== item.id)];
}

function matches(item: ClipItem, q: string, type: TypeFilter, device?: string): boolean {
  if (type !== 'all') {
    if (type === 'text' && item.type !== 'text') return false;
    if (type === 'image' && item.type !== 'image') return false;
    if (type === 'video' && !(item.type === 'file' && item.mimeType?.startsWith('video/'))) return false;
    if (type === 'file' && !(item.type === 'file' && !item.mimeType?.startsWith('video/'))) return false;
  }
  if (device?.trim() && (item.deviceName || '') !== device.trim()) return false;
  const query = q.trim().toLowerCase();
  if (!query) return true;
  const hay = [item.content, item.filename, item.label, item.deviceName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

function isLocalOnly(item: ClipItem): boolean {
  return Boolean((item as ClipItem & { localOnly?: boolean }).localOnly);
}

export function cacheSnapshot(history: ClipItem[], pinned: ClipItem[]): void {
  const prev = load();
  const localHistory = prev.history.filter(isLocalOnly);
  const localPinned = prev.pinned.filter(isLocalOnly);
  save({
    history: [
      ...history,
      ...localHistory.filter((i) => !history.some((h) => h.id === i.id)),
    ].slice(0, MAX_HISTORY),
    pinned: [
      ...pinned,
      ...localPinned.filter((i) => !pinned.some((p) => p.id === i.id)),
    ],
    savedAt: Date.now(),
  });
}

/** Mescla uma página da API no cache sem apagar o outro lado. */
export function cacheMergePage(pinned: boolean, items: ClipItem[], offset = 0): void {
  const data = load();
  if (offset === 0) {
    const prev = pinned ? data.pinned : data.history;
    const localOnly = prev.filter(isLocalOnly);
    const remoteIds = new Set(items.map((i) => i.id));
    const merged = [...items, ...localOnly.filter((i) => !remoteIds.has(i.id))];
    if (pinned) data.pinned = merged;
    else data.history = merged.slice(0, MAX_HISTORY);
  } else {
    for (const item of items) {
      if (pinned) data.pinned = upsert(data.pinned, item);
      else data.history = upsert(data.history, item).slice(0, MAX_HISTORY);
    }
  }
  save(data);
}

export function getCachedPage(opts: {
  pinned: boolean;
  limit?: number;
  offset?: number;
  q?: string;
  type?: TypeFilter;
  device?: string;
}): ItemsPage {
  const data = load();
  const source = opts.pinned ? data.pinned : data.history;
  const type = opts.type || 'all';
  const q = opts.q || '';
  const filtered = source.filter((i) => matches(i, q, type, opts.device));
  if (opts.pinned) {
    filtered.sort((a, b) => {
      const la = (a.label || '').toLowerCase();
      const lb = (b.label || '').toLowerCase();
      if (la !== lb) return la.localeCompare(lb);
      return b.updatedAt - a.updatedAt;
    });
  } else {
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}

export function hasCachedItems(): boolean {
  const data = load();
  return data.history.length > 0 || data.pinned.length > 0;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function localCreateText(
  content: string,
  opts?: { pinned?: boolean; label?: string; deviceName?: string }
): ClipItem {
  const data = load();
  const now = Date.now();
  const item: ClipItem & { localOnly?: boolean } = {
    id: newId(),
    type: 'text',
    content,
    filename: null,
    mimeType: 'text/plain',
    size: new Blob([content]).size,
    pinned: Boolean(opts?.pinned),
    label: opts?.label || null,
    deviceName: opts?.deviceName || null,
    createdAt: now,
    updatedAt: now,
    localOnly: true,
  };

  if (item.pinned) {
    data.pinned = upsert(data.pinned, item);
    data.history = data.history.filter((i) => i.id !== item.id);
  } else {
    data.history = upsert(data.history, item).slice(0, MAX_HISTORY);
    data.pinned = data.pinned.filter((i) => i.id !== item.id);
  }
  save(data);
  return item;
}

export function localUpdateItem(
  id: string,
  fields: { label?: string; pinned?: boolean; content?: string }
): ClipItem | null {
  const data = load();
  const existing =
    data.history.find((i) => i.id === id) || data.pinned.find((i) => i.id === id);
  if (!existing) return null;

  const updated: ClipItem = {
    ...existing,
    label: fields.label !== undefined ? fields.label : existing.label,
    pinned: fields.pinned !== undefined ? fields.pinned : existing.pinned,
    content: fields.content !== undefined ? fields.content : existing.content,
    updatedAt: Date.now(),
  };

  if (updated.pinned) {
    data.pinned = upsert(data.pinned, updated);
    data.history = data.history.filter((i) => i.id !== id);
  } else {
    data.history = upsert(data.history, updated).slice(0, MAX_HISTORY);
    data.pinned = data.pinned.filter((i) => i.id !== id);
  }
  save(data);
  return updated;
}

export function localTouchItem(id: string): ClipItem | null {
  const data = load();
  const existing = data.history.find((i) => i.id === id);
  if (!existing || existing.pinned) {
    return data.pinned.find((i) => i.id === id) || existing || null;
  }
  const updated = { ...existing, updatedAt: Date.now() };
  data.history = upsert(data.history, updated).slice(0, MAX_HISTORY);
  save(data);
  return updated;
}

export function localDeleteItem(id: string): boolean {
  const data = load();
  const before = data.history.length + data.pinned.length;
  data.history = data.history.filter((i) => i.id !== id);
  data.pinned = data.pinned.filter((i) => i.id !== id);
  save(data);
  return data.history.length + data.pinned.length < before;
}

export function cacheUpsertItem(item: ClipItem): void {
  const data = load();
  if (item.pinned) {
    data.pinned = upsert(data.pinned, item);
    data.history = data.history.filter((i) => i.id !== item.id);
  } else {
    data.history = upsert(data.history, item).slice(0, MAX_HISTORY);
    data.pinned = data.pinned.filter((i) => i.id !== item.id);
  }
  save(data);
}

export function cacheRemoveItem(id: string): void {
  localDeleteItem(id);
}
