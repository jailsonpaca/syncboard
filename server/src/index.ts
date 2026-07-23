import http from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { ClipStore } from './store.js';
import { Hub } from './hub.js';
import { createRouter, getClientDistPath } from './routes.js';
import { PairService } from './pair.js';
import { getLocalVersion, startUpdatePolling } from './update.js';

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';

const store = new ClipStore();
const hub = new Hub();
const pair = new PairService(PORT);
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api', createRouter(store, hub, pair));

// Pacotes de instalação (Linux/Mac) — mesma porta do SyncBoard
const releaseDir =
  process.env.SYNCBOARD_RELEASE_DIR ||
  path.resolve(process.cwd(), '..', 'desktop', 'release');
if (fs.existsSync(releaseDir)) {
  app.use(
    '/downloads',
    express.static(releaseDir, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('.sh')) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
      },
    })
  );
  console.log(`  Downloads: ${releaseDir} → /downloads/`);
}

const clientDist = getClientDistPath();
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/downloads')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  hub.add(ws);

  ws.send(JSON.stringify({
    type: 'sync_request',
    items: {
      history: store.list(false, 100),
      pinned: store.list(true, 500),
    },
  }));
});

server.listen(PORT, HOST, () => {
  const info = pair.getInfo();
  pair.startBeacon();
  startUpdatePolling();

  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║           SyncBoard Server               ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Versão:  ${getLocalVersion()}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Rede:    ${info.url}`);
  console.log(`  Código:  ${info.code}`);
  console.log('');
  console.log('  Escaneie o QR ou digite o código nos outros dispositivos');
  console.log('');
});

function shutdown() {
  pair.stopBeacon();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
