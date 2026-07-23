/**
 * Hub local (HTTP + WebSocket) para uso offline.
 * Serve a UI empacotada e a mesma API /api do servidor remoto.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');
const cache = require('./offline-cache');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const sep = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(sep) + sep.length;
  while (start < buffer.length) {
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break; // --
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    const next = buffer.indexOf(sep, start);
    const end = next === -1 ? buffer.length : next;
    let part = buffer.subarray(start, end);
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const body = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]+)"/.exec(headers);
      const fileMatch = /filename="([^"]*)"/.exec(headers);
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
      if (nameMatch) {
        parts.push({
          name: nameMatch[1],
          filename: fileMatch ? fileMatch[1] : null,
          mimeType: typeMatch ? typeMatch[1].trim() : null,
          data: body,
        });
      }
    }
    start = next === -1 ? buffer.length : next + sep.length;
  }
  return parts;
}

function createOfflineHub({ root, clientDist, port = 8790, deviceName = 'Local' }) {
  let data = cache.load(root);
  const clients = new Set();

  function broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  function reload() {
    data = cache.load(root);
    return data;
  }

  function snapshot() {
    reload();
    return {
      history: data.history.slice(0, 100),
      pinned: data.pinned.slice(0, 500),
    };
  }

  async function handleApi(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const pathname = url.pathname;

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'syncboard-offline', offline: true });
      return;
    }

    if (pathname === '/api/items' && req.method === 'GET') {
      reload();
      const pinned = url.searchParams.get('pinned') === 'true';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
      const q = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || 'all';
      const flat = url.searchParams.get('flat') === 'true';
      const page = cache.listPage(data, { pinned, limit, offset, q, type });
      sendJson(res, 200, flat ? page.items : page);
      return;
    }

    const blobMatch = pathname.match(/^\/api\/items\/([^/]+)\/blob$/);
    if (blobMatch && req.method === 'GET') {
      const id = decodeURIComponent(blobMatch[1]);
      reload();
      const item =
        data.history.find((i) => i.id === id) || data.pinned.find((i) => i.id === id);
      const buf = cache.readBlob(root, id);
      if (!item || !buf) {
        sendJson(res, 404, { error: 'Arquivo não encontrado' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': item.mimeType || 'application/octet-stream',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(buf);
      return;
    }

    const touchMatch = pathname.match(/^\/api\/items\/([^/]+)\/touch$/);
    if (touchMatch && req.method === 'POST') {
      const id = decodeURIComponent(touchMatch[1]);
      const updated = cache.touchItem(root, reload(), id);
      if (!updated) {
        sendJson(res, 404, { error: 'Item não encontrado' });
        return;
      }
      broadcast({ type: 'item_updated', item: updated });
      sendJson(res, 200, updated);
      return;
    }

    const itemMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      if (req.method === 'GET') {
        reload();
        const item =
          data.history.find((i) => i.id === id) || data.pinned.find((i) => i.id === id);
        if (!item) {
          sendJson(res, 404, { error: 'Item não encontrado' });
          return;
        }
        sendJson(res, 200, item);
        return;
      }
      if (req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const updated = cache.updateItem(root, reload(), id, body);
        if (!updated) {
          sendJson(res, 404, { error: 'Item não encontrado' });
          return;
        }
        broadcast({ type: 'item_updated', item: updated });
        sendJson(res, 200, updated);
        return;
      }
      if (req.method === 'DELETE') {
        const deleted = cache.deleteItem(root, reload(), id);
        if (!deleted) {
          sendJson(res, 404, { error: 'Item não encontrado' });
          return;
        }
        broadcast({ type: 'item_deleted', id });
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (pathname === '/api/items/text' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (typeof body.content !== 'string' || !body.content.trim()) {
        sendJson(res, 400, { error: 'Conteúdo de texto obrigatório' });
        return;
      }
      const item = cache.createText(root, reload(), {
        content: body.content,
        pinned: body.pinned,
        label: body.label,
        deviceName: body.deviceName || deviceName,
      });
      broadcast({ type: 'item_created', item });
      sendJson(res, 200, item);
      return;
    }

    if (pathname === '/api/items/upload-base64' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.data) {
        sendJson(res, 400, { error: 'data obrigatório' });
        return;
      }
      const buffer = Buffer.from(body.data, 'base64');
      const mime = body.mimeType || 'image/png';
      const type = mime.startsWith('image/') ? 'image' : 'file';
      const item = cache.createBinary(root, reload(), {
        buffer,
        type,
        mimeType: mime,
        filename: body.filename || 'clipboard.png',
        pinned: body.pinned,
        label: body.label,
        deviceName: body.deviceName || deviceName,
      });
      broadcast({ type: 'item_created', item });
      sendJson(res, 200, item);
      return;
    }

    if (pathname === '/api/items/upload' && req.method === 'POST') {
      const body = await readBody(req);
      const ct = req.headers['content-type'] || '';
      const boundaryMatch = /boundary=(.+)$/i.exec(ct);
      if (!boundaryMatch) {
        sendJson(res, 400, { error: 'multipart inválido' });
        return;
      }
      const parts = parseMultipart(body, boundaryMatch[1].trim());
      const filePart = parts.find((p) => p.name === 'file');
      if (!filePart) {
        sendJson(res, 400, { error: 'arquivo obrigatório' });
        return;
      }
      const field = (name) => {
        const p = parts.find((x) => x.name === name);
        return p ? p.data.toString('utf8') : '';
      };
      const mime = filePart.mimeType || 'application/octet-stream';
      const type = mime.startsWith('image/') ? 'image' : 'file';
      const item = cache.createBinary(root, reload(), {
        buffer: filePart.data,
        type,
        mimeType: mime,
        filename: filePart.filename || field('filename') || 'file',
        pinned: field('pinned') === 'true',
        label: field('label') || null,
        deviceName: field('deviceName') || deviceName,
      });
      broadcast({ type: 'item_created', item });
      sendJson(res, 200, item);
      return;
    }

    sendJson(res, 404, { error: 'Não encontrado' });
  }

  function serveStatic(req, res, url) {
    if (!clientDist || !fs.existsSync(clientDist)) {
      sendJson(res, 503, { error: 'UI local não encontrada' });
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(clientDist, rel));
    if (!filePath.startsWith(path.normalize(clientDist))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const tryPaths = [filePath];
    if (!path.extname(filePath)) {
      tryPaths.push(`${filePath}.html`, path.join(clientDist, 'index.html'));
    } else if (!fs.existsSync(filePath)) {
      tryPaths.push(path.join(clientDist, 'index.html'));
    }

    for (const candidate of tryPaths) {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const ext = path.extname(candidate).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(candidate).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      console.error('[offline-hub]', err);
      sendJson(res, 500, { error: err.message || 'Erro interno' });
    }
  });

  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    const snap = snapshot();
    ws.send(
      JSON.stringify({
        type: 'sync_request',
        items: snap,
      })
    );
    ws.on('close', () => clients.delete(ws));
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        console.log(`[offline-hub] http://127.0.0.1:${port} (modo local)`);
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          /* ok */
        }
      }
      clients.clear();
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  }

  return {
    start,
    stop,
    port,
    reload,
    snapshot,
    getData: () => reload(),
    broadcast,
    root,
  };
}

module.exports = { createOfflineHub };
