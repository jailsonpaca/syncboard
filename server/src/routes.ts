import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { ClipStore, ListFilter } from './store.js';
import { MAX_HISTORY_ITEMS } from './store.js';
import type { Hub } from './hub.js';
import type { ItemType } from './types.js';
import type { PairService } from './pair.js';
import { getLocalVersion, getUpdateStatus } from './update.js';
import { dedupeDevices } from './devices.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

function parseFilter(raw: unknown): ListFilter {
  const v = String(raw || 'all');
  if (v === 'text' || v === 'image' || v === 'video' || v === 'file' || v === 'all') return v;
  return 'all';
}

function notifyTrimmed(hub: Hub, ids: string[]): void {
  for (const id of ids) hub.notifyItemDeleted(id);
}

export function createRouter(store: ClipStore, hub: Hub, pair?: PairService): express.Router {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'syncboard', version: getLocalVersion() });
  });

  router.get('/version', (_req, res) => {
    res.json({ version: getLocalVersion() });
  });

  router.get('/update', async (req, res) => {
    const force = req.query.force === 'true';
    try {
      const status = await getUpdateStatus(force);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/pair', (_req, res) => {
    if (!pair) {
      res.status(503).json({ error: 'Pareamento indisponível' });
      return;
    }
    res.json(pair.getInfo());
  });

  router.post('/pair/regenerate', (_req, res) => {
    if (!pair) {
      res.status(503).json({ error: 'Pareamento indisponível' });
      return;
    }
    res.json(pair.regenerate());
  });

  router.post('/pair/join', express.json(), (req, res) => {
    if (!pair) {
      res.status(503).json({ error: 'Pareamento indisponível' });
      return;
    }
    const result = pair.join(String(req.body?.code || ''));
    if (!result) {
      res.status(404).json({ error: 'Código inválido ou expirado' });
      return;
    }
    res.json(result);
  });

  router.get('/devices', (_req, res) => {
    const known = store.listDeviceNames();
    const online = new Set(hub.onlineDeviceNames());
    const names = new Set([...known, ...online]);
    const devices = dedupeDevices(
      [...names].map((name) => ({ name, online: online.has(name) }))
    );
    res.json({ devices });
  });

  router.get('/items', (req, res) => {
    const pinned = req.query.pinned === 'true';
    const limit = Math.min(
      parseInt(String(req.query.limit || (pinned ? '100' : '20')), 10) || 20,
      MAX_HISTORY_ITEMS
    );
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const filter = parseFilter(req.query.type);
    const deviceName = typeof req.query.device === 'string' ? req.query.device : '';
    const flat = req.query.flat === 'true';

    const result = store.listPage({
      pinnedOnly: pinned,
      limit,
      offset,
      query,
      filter,
      deviceName: deviceName || undefined,
    });

    // Compatibilidade: desktop/tray ainda esperam array puro
    if (flat) {
      res.json(result.items);
      return;
    }

    res.json(result);
  });

  router.get('/items/:id', (req, res) => {
    const item = store.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }
    res.json(item);
  });

  router.get('/items/:id/blob', (req, res) => {
    const item = store.get(req.params.id);
    if (!item || item.type === 'text') {
      res.status(404).json({ error: 'Blob não encontrado' });
      return;
    }

    const blobPath = store.getBlobPath(item.id);
    if (!blobPath) {
      res.status(404).json({ error: 'Arquivo não encontrado no disco' });
      return;
    }

    res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
    if (item.filename) {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(item.filename)}"`);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    fs.createReadStream(blobPath).pipe(res);
  });

  router.post('/items/text', express.json({ limit: '10mb' }), (req, res) => {
    const { content, pinned, label, deviceName } = req.body;
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Conteúdo de texto obrigatório' });
      return;
    }

    const { item, trimmedIds } = store.create({
      id: uuidv4(),
      type: 'text',
      content,
      filename: null,
      mimeType: 'text/plain',
      size: Buffer.byteLength(content, 'utf8'),
      pinned: Boolean(pinned),
      label: label || null,
      deviceName: deviceName || null,
    });

    notifyTrimmed(hub, trimmedIds);
    hub.notifyItemCreated(item);
    res.status(201).json(item);
  });

  router.post('/items/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Arquivo obrigatório' });
      return;
    }

    const pinned = req.body.pinned === 'true' || req.body.pinned === true;
    const label = req.body.label || null;
    const deviceName = req.body.deviceName || null;
    const id = uuidv4();
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const isImage = mimeType.startsWith('image/');
    const type: ItemType = isImage ? 'image' : 'file';

    store.saveBlob(id, req.file.buffer);

    const { item, trimmedIds } = store.create({
      id,
      type,
      content: null,
      filename: req.file.originalname || (isImage ? 'image.png' : 'file'),
      mimeType,
      size: req.file.size,
      pinned,
      label,
      deviceName,
    });

    notifyTrimmed(hub, trimmedIds);
    hub.notifyItemCreated(item);
    res.status(201).json(item);
  });

  router.post('/items/upload-base64', express.json({ limit: '50mb' }), (req, res) => {
    const { data, mimeType, filename, pinned, label, deviceName } = req.body;
    if (typeof data !== 'string') {
      res.status(400).json({ error: 'data base64 obrigatório' });
      return;
    }

    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) {
      res.status(400).json({ error: 'Dados vazios' });
      return;
    }

    const resolvedMime = mimeType || 'application/octet-stream';
    const isImage = resolvedMime.startsWith('image/');
    const type: ItemType = isImage ? 'image' : 'file';
    const id = uuidv4();

    store.saveBlob(id, buffer);

    const { item, trimmedIds } = store.create({
      id,
      type,
      content: null,
      filename: filename || (isImage ? 'clipboard.png' : 'file'),
      mimeType: resolvedMime,
      size: buffer.length,
      pinned: Boolean(pinned),
      label: label || null,
      deviceName: deviceName || null,
    });

    notifyTrimmed(hub, trimmedIds);
    hub.notifyItemCreated(item);
    res.status(201).json(item);
  });

  router.post('/items/:id/touch', (req, res) => {
    const item = store.touch(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }
    hub.notifyItemUpdated(item);
    res.json(item);
  });

  router.patch('/items/:id', express.json(), (req, res) => {
    const { label, pinned, content, bump } = req.body;

    if (bump === true && label === undefined && pinned === undefined && content === undefined) {
      const item = store.touch(req.params.id);
      if (!item) {
        res.status(404).json({ error: 'Item não encontrado' });
        return;
      }
      hub.notifyItemUpdated(item);
      res.json(item);
      return;
    }

    const item = store.update(req.params.id, {
      ...(label !== undefined && { label }),
      ...(pinned !== undefined && { pinned: Boolean(pinned) }),
      ...(content !== undefined && { content }),
    });

    if (!item) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }

    if (bump === true) {
      store.touch(item.id);
    }

    const fresh = store.get(item.id)!;
    hub.notifyItemUpdated(fresh);
    res.json(fresh);
  });

  router.delete('/items/:id', (req, res) => {
    const item = store.delete(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }

    hub.notifyItemDeleted(item.id);
    res.json({ ok: true });
  });

  return router;
}

export function getClientDistPath(): string {
  if (process.env.SYNCBOARD_CLIENT_DIST) {
    return process.env.SYNCBOARD_CLIENT_DIST;
  }
  return path.join(process.cwd(), '..', 'client', 'dist');
}
