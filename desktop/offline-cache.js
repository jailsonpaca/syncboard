const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 100;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cacheFile(root) {
  return path.join(root, 'offline-cache.json');
}

function blobsDir(root) {
  return path.join(root, 'offline-blobs');
}

function newId() {
  return crypto.randomUUID();
}

function load(root) {
  ensureDir(root);
  ensureDir(blobsDir(root));
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8'));
    return {
      pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
      history: Array.isArray(raw.history) ? raw.history : [],
      savedAt: raw.savedAt || 0,
    };
  } catch {
    return { pinned: [], history: [], savedAt: 0 };
  }
}

function save(root, data) {
  ensureDir(root);
  const payload = {
    pinned: data.pinned || [],
    history: (data.history || []).slice(0, MAX_HISTORY),
    savedAt: Date.now(),
  };
  fs.writeFileSync(cacheFile(root), JSON.stringify(payload));
  return payload;
}

function blobPath(root, id) {
  return path.join(blobsDir(root), id);
}

function saveBlob(root, id, buffer) {
  ensureDir(blobsDir(root));
  fs.writeFileSync(blobPath(root, id), buffer);
}

function readBlob(root, id) {
  const p = blobPath(root, id);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function hasBlob(root, id) {
  return fs.existsSync(blobPath(root, id));
}

function removeBlob(root, id) {
  const p = blobPath(root, id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function upsertItem(list, item) {
  return [item, ...list.filter((i) => i.id !== item.id)];
}

function matchesQuery(item, q, type) {
  if (type && type !== 'all') {
    if (type === 'text' && item.type !== 'text') return false;
    if (type === 'image' && item.type !== 'image') return false;
    if (type === 'video' && !(item.type === 'file' && item.mimeType?.startsWith('video/'))) return false;
    if (type === 'file' && !(item.type === 'file' && !item.mimeType?.startsWith('video/'))) return false;
  }
  const query = (q || '').trim().toLowerCase();
  if (!query) return true;
  const hay = [item.content, item.filename, item.label, item.deviceName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

function listPage(data, { pinned, limit = 20, offset = 0, q = '', type = 'all' }) {
  const source = pinned ? data.pinned : data.history;
  const filtered = source.filter((item) => matchesQuery(item, q, type));
  if (pinned) {
    filtered.sort((a, b) => {
      const la = (a.label || '').toLowerCase();
      const lb = (b.label || '').toLowerCase();
      if (la !== lb) return la.localeCompare(lb);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  } else {
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);
  return { items, total, limit, offset };
}

function createText(root, data, { content, pinned = false, label = null, deviceName = null, id }) {
  const now = Date.now();
  const item = {
    id: id || newId(),
    type: 'text',
    content,
    filename: null,
    mimeType: 'text/plain',
    size: Buffer.byteLength(content, 'utf8'),
    pinned: Boolean(pinned),
    label: label || null,
    deviceName: deviceName || null,
    createdAt: now,
    updatedAt: now,
    localOnly: true,
  };

  if (item.pinned) {
    data.pinned = upsertItem(data.pinned, item);
    data.history = data.history.filter((i) => i.id !== item.id);
  } else {
    data.history = upsertItem(data.history, item).slice(0, MAX_HISTORY);
    data.pinned = data.pinned.filter((i) => i.id !== item.id);
  }
  save(root, data);
  return item;
}

function createBinary(
  root,
  data,
  { buffer, type, mimeType, filename, pinned = false, label = null, deviceName = null, id }
) {
  const now = Date.now();
  const item = {
    id: id || newId(),
    type,
    content: null,
    filename: filename || (type === 'image' ? 'clipboard.png' : 'file'),
    mimeType: mimeType || 'application/octet-stream',
    size: buffer.length,
    pinned: Boolean(pinned),
    label: label || null,
    deviceName: deviceName || null,
    createdAt: now,
    updatedAt: now,
    localOnly: true,
  };

  saveBlob(root, item.id, buffer);

  if (item.pinned) {
    data.pinned = upsertItem(data.pinned, item);
    data.history = data.history.filter((i) => i.id !== item.id);
  } else {
    data.history = upsertItem(data.history, item).slice(0, MAX_HISTORY);
    data.pinned = data.pinned.filter((i) => i.id !== item.id);
  }
  save(root, data);
  return item;
}

function updateItem(root, data, id, fields) {
  const all = [...data.pinned, ...data.history];
  const existing = all.find((i) => i.id === id);
  if (!existing) return null;

  const updated = {
    ...existing,
    label: fields.label !== undefined ? fields.label : existing.label,
    pinned: fields.pinned !== undefined ? Boolean(fields.pinned) : existing.pinned,
    content: fields.content !== undefined ? fields.content : existing.content,
    updatedAt: Date.now(),
  };

  if (updated.pinned) {
    data.pinned = upsertItem(data.pinned, updated);
    data.history = data.history.filter((i) => i.id !== id);
  } else {
    data.history = upsertItem(data.history, updated).slice(0, MAX_HISTORY);
    data.pinned = data.pinned.filter((i) => i.id !== id);
  }
  save(root, data);
  return updated;
}

function touchItem(root, data, id) {
  const existing = data.history.find((i) => i.id === id) || data.pinned.find((i) => i.id === id);
  if (!existing || existing.pinned) return existing || null;
  const updated = { ...existing, updatedAt: Date.now() };
  data.history = upsertItem(data.history, updated).slice(0, MAX_HISTORY);
  save(root, data);
  return updated;
}

function deleteItem(root, data, id) {
  const existing =
    data.history.find((i) => i.id === id) || data.pinned.find((i) => i.id === id) || null;
  data.history = data.history.filter((i) => i.id !== id);
  data.pinned = data.pinned.filter((i) => i.id !== id);
  if (existing && existing.type !== 'text') removeBlob(root, id);
  save(root, data);
  return existing;
}

/** Mescla snapshot do servidor remoto no cache local (preserva localOnly). */
function mergeFromRemote(root, data, { pinned = [], history = [] }) {
  const localOnlyPinned = data.pinned.filter((i) => i.localOnly);
  const localOnlyHistory = data.history.filter((i) => i.localOnly);

  const remotePinned = pinned.map((i) => ({ ...i, localOnly: false }));
  const remoteHistory = history.map((i) => ({ ...i, localOnly: false }));

  const pinnedIds = new Set(remotePinned.map((i) => i.id));
  const historyIds = new Set(remoteHistory.map((i) => i.id));

  data.pinned = [
    ...remotePinned,
    ...localOnlyPinned.filter((i) => !pinnedIds.has(i.id)),
  ];
  data.history = [
    ...remoteHistory,
    ...localOnlyHistory.filter((i) => !historyIds.has(i.id)),
  ].slice(0, MAX_HISTORY);

  save(root, data);
  return data;
}

module.exports = {
  MAX_HISTORY,
  load,
  save,
  saveBlob,
  readBlob,
  hasBlob,
  removeBlob,
  blobPath,
  listPage,
  createText,
  createBinary,
  updateItem,
  touchItem,
  deleteItem,
  mergeFromRemote,
  upsertItem,
  newId,
};
