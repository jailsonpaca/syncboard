import type { ClipItem, ItemsPage, TypeFilter, WsMessage } from './types';
import {
  cacheMergePage,
  cacheRemoveItem,
  cacheSnapshot,
  cacheUpsertItem,
  getCachedPage,
  hasCachedItems,
  localCreateText,
  localDeleteItem,
  localTouchItem,
  localUpdateItem,
} from './localStore';

const DEVICE_KEY = 'syncboard_device';
const SERVER_KEY = 'syncboard_server';

/** true quando a última operação usou cache local (servidor inacessível). */
let usingLocalFallback = false;

export function isUsingLocalFallback(): boolean {
  return usingLocalFallback;
}

export function getDeviceName(): string {
  const saved = localStorage.getItem(DEVICE_KEY);
  if (saved) return saved;
  const name = `${navigator.platform.split(' ')[0] || 'Device'}-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem(DEVICE_KEY, name);
  return name;
}

export function setDeviceName(name: string): void {
  localStorage.setItem(DEVICE_KEY, name);
}

export function getServerUrl(): string {
  const saved = localStorage.getItem(SERVER_KEY);
  if (saved) return saved.replace(/\/$/, '');
  return window.location.origin;
}

export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_KEY, url.replace(/\/$/, ''));
}

function apiBase(): string {
  return `${getServerUrl()}/api`;
}

function wsUrl(): string {
  const base = getServerUrl();
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

export interface FetchItemsOpts {
  pinned: boolean;
  limit?: number;
  offset?: number;
  q?: string;
  type?: TypeFilter;
  device?: string;
}

export type DeviceInfo = { name: string; online: boolean };

export async function fetchDevices(): Promise<DeviceInfo[]> {
  try {
    const res = await fetch(`${apiBase()}/devices`);
    if (!res.ok) throw new Error('devices');
    const data = await res.json();
    return Array.isArray(data.devices) ? data.devices : [];
  } catch {
    return [];
  }
}

export async function fetchItemsPage(opts: FetchItemsOpts): Promise<ItemsPage> {
  const params = new URLSearchParams({
    pinned: String(opts.pinned),
    limit: String(opts.limit ?? 20),
    offset: String(opts.offset ?? 0),
  });
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  if (opts.type && opts.type !== 'all') params.set('type', opts.type);
  if (opts.device?.trim()) params.set('device', opts.device.trim());

  try {
    const res = await fetch(`${apiBase()}/items?${params}`);
    if (!res.ok) throw new Error('Falha ao carregar itens');
    const page: ItemsPage = await res.json();
    usingLocalFallback = false;
    cacheMergePage(opts.pinned, page.items, opts.offset ?? 0);
    return page;
  } catch (err) {
    if (hasCachedItems()) {
      usingLocalFallback = true;
      return getCachedPage(opts);
    }
    throw err;
  }
}

/** Carrega todos os itens (até o limite do servidor) — útil para sync inicial. */
export async function fetchItems(pinned: boolean, limit = 100): Promise<ClipItem[]> {
  const page = await fetchItemsPage({ pinned, limit, offset: 0 });
  return page.items;
}

export async function createText(content: string, opts?: { pinned?: boolean; label?: string }): Promise<ClipItem> {
  try {
    const res = await fetch(`${apiBase()}/items/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        pinned: opts?.pinned ?? false,
        label: opts?.label,
        deviceName: getDeviceName(),
      }),
    });
    if (!res.ok) throw new Error('Falha ao enviar texto');
    const item: ClipItem = await res.json();
    usingLocalFallback = false;
    cacheUpsertItem(item);
    return item;
  } catch {
    usingLocalFallback = true;
    const item = localCreateText(content, {
      pinned: opts?.pinned,
      label: opts?.label,
      deviceName: getDeviceName(),
    });
    return item;
  }
}

export async function uploadFile(file: File | Blob, opts?: { pinned?: boolean; label?: string; filename?: string }): Promise<ClipItem> {
  const form = new FormData();
  const blob = file instanceof File ? file : file;
  const name = opts?.filename || (file instanceof File ? file.name : 'upload.bin');
  form.append('file', blob, name);
  form.append('pinned', String(opts?.pinned ?? false));
  if (opts?.label) form.append('label', opts.label);
  form.append('deviceName', getDeviceName());

  const res = await fetch(`${apiBase()}/items/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Falha ao enviar arquivo');
  return res.json();
}

export async function updateItem(id: string, fields: { label?: string; pinned?: boolean; content?: string }): Promise<ClipItem> {
  try {
    const res = await fetch(`${apiBase()}/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error('Falha ao atualizar');
    const item: ClipItem = await res.json();
    usingLocalFallback = false;
    cacheUpsertItem(item);
    return item;
  } catch {
    const item = localUpdateItem(id, fields);
    if (!item) throw new Error('Falha ao atualizar');
    usingLocalFallback = true;
    return item;
  }
}

/** Move o item para a posição mais recente no histórico. */
export async function touchItem(id: string): Promise<ClipItem> {
  try {
    const res = await fetch(`${apiBase()}/items/${id}/touch`, { method: 'POST' });
    if (!res.ok) throw new Error('Falha ao atualizar posição');
    const item: ClipItem = await res.json();
    usingLocalFallback = false;
    cacheUpsertItem(item);
    return item;
  } catch {
    const item = localTouchItem(id);
    if (!item) throw new Error('Falha ao atualizar posição');
    usingLocalFallback = true;
    return item;
  }
}

export async function deleteItem(id: string): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/items/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Falha ao excluir');
    usingLocalFallback = false;
    cacheRemoveItem(id);
  } catch {
    if (!localDeleteItem(id)) throw new Error('Falha ao excluir');
    usingLocalFallback = true;
  }
}

export function blobUrl(item: ClipItem): string {
  return `${apiBase()}/items/${item.id}/blob`;
}

export function connectWebSocket(handlers: {
  onSync: (history: ClipItem[], pinned: ClipItem[]) => void;
  onCreated: (item: ClipItem) => void;
  onUpdated: (item: ClipItem) => void;
  onDeleted: (id: string) => void;
  onConnectionChange: (connected: boolean) => void;
}): () => void {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect() {
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      handlers.onConnectionChange(true);
      try {
        ws?.send(JSON.stringify({ type: 'hello', deviceName: getDeviceName() }));
      } catch {
        /* ok */
      }
    };

    ws.onclose = () => {
      handlers.onConnectionChange(false);
      if (!closed) {
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => ws?.close();

    ws.onmessage = (ev) => {
      const msg: WsMessage = JSON.parse(ev.data);
      switch (msg.type) {
        case 'sync_request':
          if (msg.items) {
            usingLocalFallback = false;
            cacheSnapshot(msg.items.history, msg.items.pinned);
            handlers.onSync(msg.items.history, msg.items.pinned);
          }
          break;
        case 'item_created':
          if (msg.item) {
            cacheUpsertItem(msg.item);
            handlers.onCreated(msg.item);
          }
          break;
        case 'item_updated':
          if (msg.item) {
            cacheUpsertItem(msg.item);
            handlers.onUpdated(msg.item);
          }
          break;
        case 'item_deleted':
          if (msg.id) {
            cacheRemoveItem(msg.id);
            handlers.onDeleted(msg.id);
          }
          break;
      }
    };
  }

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

export async function copyItemToClipboard(item: ClipItem): Promise<void> {
  if (item.type === 'text' && item.content) {
    await navigator.clipboard.writeText(item.content);
    return;
  }

  try {
    const res = await fetch(blobUrl(item));
    if (!res.ok) throw new Error('Falha ao baixar arquivo');

    const blob = await res.blob();
    const typedBlob = new Blob([blob], { type: item.mimeType || blob.type });

    if (item.type === 'image' && typeof ClipboardItem !== 'undefined') {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ [typedBlob.type]: typedBlob }),
        ]);
        return;
      } catch {
        // fallback: download
      }
    }

    if (item.type === 'text' || item.mimeType?.startsWith('text/')) {
      const text = await typedBlob.text();
      await navigator.clipboard.writeText(text);
      return;
    }

    const url = URL.createObjectURL(typedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.filename || 'download';
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // Offline: ainda permite copiar texto/label se existir no cache
    if (item.content) {
      await navigator.clipboard.writeText(item.content);
      return;
    }
    throw new Error('Arquivo indisponível offline');
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'agora';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} h`;
  return new Date(ts).toLocaleDateString('pt-BR');
}

export function itemKindLabel(item: ClipItem): string {
  if (item.type === 'text') return 'Texto';
  if (item.type === 'image') return 'Imagem';
  if (item.mimeType?.startsWith('video/')) return 'Vídeo';
  return 'Arquivo';
}

export function itemDisplayKind(item: ClipItem): 'text' | 'image' | 'video' | 'file' {
  if (item.type === 'text') return 'text';
  if (item.type === 'image') return 'image';
  if (item.mimeType?.startsWith('video/')) return 'video';
  return 'file';
}

export type PairInfo = {
  code: string;
  url: string;
  urls: string[];
  token: string;
  qrPayload: string;
  joinUrl: string;
  hostname?: string;
};

export type UpdateStatus = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadPage: string | null;
  assets: {
    macDmg?: string | null;
    macZip?: string | null;
    linuxAppImage?: string | null;
    linuxTar?: string | null;
    winSetup?: string | null;
    winZip?: string | null;
    androidApk?: string | null;
  } | null;
};

export async function fetchPairInfo(): Promise<PairInfo> {
  const res = await fetch(`${apiBase()}/pair`);
  if (!res.ok) throw new Error('Pareamento indisponível');
  return res.json();
}

export async function regeneratePairCode(): Promise<PairInfo> {
  const res = await fetch(`${apiBase()}/pair/regenerate`, { method: 'POST' });
  if (!res.ok) throw new Error('Falha ao regenerar código');
  return res.json();
}

export async function fetchUpdateStatus(force = false): Promise<UpdateStatus> {
  const res = await fetch(`${apiBase()}/update?force=${force ? 'true' : 'false'}`);
  if (!res.ok) throw new Error('Falha ao checar update');
  return res.json();
}

export type DiscoveredServer = {
  serverUrl: string;
  code?: string;
  hostname?: string;
  urls?: string[];
};

/** Busca servidores SyncBoard na LAN (UDP no Electron; HTTP no browser). */
export async function discoverLanServers(): Promise<DiscoveredServer[]> {
  if (window.syncboard?.discoverServers) {
    const result = await window.syncboard.discoverServers();
    if (!result?.ok) throw new Error(result?.error || 'Falha na busca na rede');
    return result.servers || [];
  }

  const hosts = guessLanHosts();
  const found = new Map<string, DiscoveredServer>();
  const batchSize = 32;

  for (let i = 0; i < hosts.length; i += batchSize) {
    const batch = hosts.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (host) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 350);
        try {
          const res = await fetch(`http://${host}/api/pair`, { signal: ctrl.signal });
          if (!res.ok) return;
          const data = await res.json();
          const serverUrl = String(data.url || `http://${host}`).replace(/\/$/, '');
          found.set(serverUrl, {
            serverUrl,
            code: data.code ? String(data.code).toUpperCase() : undefined,
            hostname: data.hostname ? String(data.hostname) : undefined,
            urls: Array.isArray(data.urls)
              ? data.urls.map((u: string) => String(u).replace(/\/$/, ''))
              : undefined,
          });
        } catch {
          /* offline host */
        } finally {
          clearTimeout(t);
        }
      })
    );
    // Se já achou algo na varredura leve, pode parar cedo após o 1º bloco (~gateway/vizinhos)
    if (i === 0 && found.size > 0 && hosts.length > 40) {
      // continua só mais um pouco para pegar outros hosts
    }
  }

  return [...found.values()].sort((a, b) => a.serverUrl.localeCompare(b.serverUrl));
}

function guessLanHosts(port = 8787): string[] {
  const host = window.location.hostname;
  const hosts = new Set<string>();
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    hosts.add(`${host}:${port}`);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const base = `${m[1]}.${m[2]}.${m[3]}`;
    // gateway + alguns vizinhos comuns primeiro
    for (const last of [1, 2, 10, 20, 50, 100, 101, 150, 200, Number(m[4])]) {
      if (last >= 1 && last <= 254) hosts.add(`${base}.${last}:${port}`);
    }
    // varredura leve do /24
    for (let i = 1; i <= 254; i++) hosts.add(`${base}.${i}:${port}`);
  }
  return [...hosts];
}

export async function joinWithCodeWeb(code: string): Promise<{ serverUrl: string }> {
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length < 4) throw new Error('Código inválido');

  // Electron: discovery UDP nativo
  if (window.syncboard?.joinWithCode) {
    const result = await window.syncboard.joinWithCode(normalized);
    if (!result?.ok || !result.serverUrl) throw new Error(result?.error || 'Falha ao parear');
    setServerUrl(result.serverUrl);
    return { serverUrl: result.serverUrl };
  }

  // Já estamos num servidor? tenta join direto
  try {
    const res = await fetch(`${apiBase()}/pair/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalized }),
    });
    if (res.ok) {
      const data = await res.json();
      setServerUrl(data.serverUrl);
      return { serverUrl: data.serverUrl };
    }
  } catch {
    /* probe */
  }

  const hosts = guessLanHosts();
  const batchSize = 24;
  for (let i = 0; i < hosts.length; i += batchSize) {
    const batch = hosts.slice(i, i + batchSize);
    const found = await Promise.any(
      batch.map(async (host) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 400);
        try {
          const res = await fetch(`http://${host}/api/pair/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: normalized }),
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error('no');
          const data = await res.json();
          return String(data.serverUrl).replace(/\/$/, '');
        } finally {
          clearTimeout(t);
        }
      })
    ).catch(() => null);
    if (found) {
      setServerUrl(found);
      return { serverUrl: found };
    }
  }

  throw new Error('Nenhum servidor com este código na rede local');
}
