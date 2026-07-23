const dgram = require('dgram');
const os = require('os');

const PAIR_MULTICAST = '239.255.77.87';
const PAIR_UDP_PORT = 18787;
const DEFAULT_HTTP_PORT = 8787;

/**
 * Descobre o servidor SyncBoard na LAN pelo código de pareamento (UDP).
 * @param {string} code
 * @param {number} [timeoutMs]
 * @returns {Promise<{ serverUrl: string, token?: string, urls?: string[] }>}
 */
function discoverByCode(code, timeoutMs = 5000) {
  const normalized = String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (!normalized || normalized.length < 4) {
    return Promise.reject(new Error('Código inválido'));
  }

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;

    const finish = (err, result) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        /* ok */
      }
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(new Error('Nenhum servidor encontrado com este código na rede local'));
    }, timeoutMs);

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        if (data?.type !== 'syncboard-pair') return;
        if (String(data.code || '').toUpperCase() !== normalized) return;
        if (!data.url) return;
        clearTimeout(timer);
        finish(null, {
          serverUrl: String(data.url).replace(/\/$/, ''),
          token: data.token,
          urls: data.urls,
        });
      } catch {
        /* ignore */
      }
    });

    socket.bind(PAIR_UDP_PORT, () => {
      try {
        socket.setBroadcast(true);
        socket.addMembership(PAIR_MULTICAST);
      } catch {
        /* ok */
      }

      // Pedido ativo (além de ouvir beacons)
      const query = Buffer.from(
        JSON.stringify({ type: 'syncboard-pair-query', code: normalized }),
        'utf8'
      );
      try {
        socket.send(query, PAIR_UDP_PORT, PAIR_MULTICAST);
        socket.send(query, PAIR_UDP_PORT, '255.255.255.255');
      } catch {
        /* ok */
      }
    });
  });
}

/**
 * Parseia payload de QR: syncboard://join?url=...&code=... ou http://ip:port/?join=CODE
 */
function parseJoinPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    if (text.startsWith('syncboard://')) {
      const u = new URL(text.replace('syncboard://', 'http://'));
      const url = u.searchParams.get('url');
      const code = u.searchParams.get('code');
      if (url) {
        return { serverUrl: url.replace(/\/$/, ''), code: code || undefined };
      }
    }
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text);
      const join = u.searchParams.get('join');
      return {
        serverUrl: `${u.protocol}//${u.host}`,
        code: join || undefined,
      };
    }
  } catch {
    /* fallthrough */
  }

  // Só código
  if (/^[A-Za-z0-9]{4,8}$/.test(text)) {
    return { code: text.toUpperCase() };
  }
  return null;
}

function mergeServer(map, data) {
  if (!data?.url && !data?.serverUrl) return;
  const serverUrl = String(data.url || data.serverUrl).replace(/\/$/, '');
  if (!serverUrl) return;
  const prev = map.get(serverUrl);
  map.set(serverUrl, {
    serverUrl,
    code: data.code ? String(data.code).toUpperCase() : prev?.code,
    hostname: data.hostname ? String(data.hostname) : prev?.hostname,
    urls: Array.isArray(data.urls)
      ? data.urls.map((u) => String(u).replace(/\/$/, ''))
      : prev?.urls,
  });
}

function lanHttpTargets(httpPort = DEFAULT_HTTP_PORT) {
  const hosts = new Set(['127.0.0.1', 'localhost']);
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      const family = String(net.family);
      if ((family !== 'IPv4' && family !== '4') || net.internal) continue;
      hosts.add(net.address);
      const parts = net.address.split('.').map(Number);
      if (parts.length !== 4) continue;
      // vizinhos comuns + varredura leve do /24
      for (const last of [1, 2, 10, 20, 50, 100, 101, 150, 200, parts[3]]) {
        if (last >= 1 && last <= 254) hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.${last}`);
      }
      for (let i = 1; i <= 254; i++) {
        hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`);
      }
    }
  }
  return [...hosts].map((h) => `http://${h}:${httpPort}`);
}

async function discoverServersHttp(timeoutMs = 4000) {
  /** @type {Map<string, { serverUrl: string, code?: string, hostname?: string, urls?: string[] }>} */
  const found = new Map();
  const targets = lanHttpTargets();
  const batchSize = 40;
  const started = Date.now();

  for (let i = 0; i < targets.length; i += batchSize) {
    if (Date.now() - started > timeoutMs) break;
    const batch = targets.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (base) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 280);
        try {
          const res = await fetch(`${base}/api/pair`, { signal: ctrl.signal });
          if (!res.ok) return;
          const data = await res.json();
          mergeServer(found, { ...data, url: data.url || base });
        } catch {
          /* offline */
        } finally {
          clearTimeout(t);
        }
      })
    );
    // após achar na 1ª leva (localhost + IPs locais + vizinhos), ainda varre um pouco mais
    if (found.size > 0 && i >= batchSize * 2) break;
  }

  return found;
}

/**
 * Lista servidores SyncBoard na LAN (UDP + fallback HTTP).
 * @param {number} [timeoutMs]
 * @returns {Promise<Array<{ serverUrl: string, code?: string, hostname?: string, urls?: string[] }>>}
 */
async function discoverServers(timeoutMs = 3500) {
  /** @type {Map<string, { serverUrl: string, code?: string, hostname?: string, urls?: string[] }>} */
  const found = new Map();

  const udpPromise = new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        /* ok */
      }
      resolve();
    };

    const timer = setTimeout(finish, Math.min(timeoutMs, 2800));

    socket.on('error', () => {
      clearTimeout(timer);
      finish();
    });

    socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        if (data?.type === 'syncboard-pair') mergeServer(found, data);
      } catch {
        /* ignore */
      }
    });

    const sendDiscover = () => {
      const query = Buffer.from(JSON.stringify({ type: 'syncboard-discover', v: 1 }), 'utf8');
      const destinations = [PAIR_MULTICAST, '255.255.255.255', '127.0.0.1'];
      for (const entries of Object.values(os.networkInterfaces())) {
        for (const net of entries || []) {
          const family = String(net.family);
          if ((family === 'IPv4' || family === '4') && !net.internal) {
            destinations.push(net.address);
          }
        }
      }
      for (const host of new Set(destinations)) {
        try {
          socket.send(query, PAIR_UDP_PORT, host);
        } catch {
          /* ok */
        }
      }
    };

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ok */
      }
      sendDiscover();
      setTimeout(sendDiscover, 800);
    });
  });

  const httpPromise = discoverServersHttp(timeoutMs).then((httpFound) => {
    for (const v of httpFound.values()) mergeServer(found, v);
  });

  await Promise.all([udpPromise, httpPromise]);
  return [...found.values()].sort((a, b) => a.serverUrl.localeCompare(b.serverUrl));
}

module.exports = {
  discoverByCode,
  discoverServers,
  parseJoinPayload,
  PAIR_MULTICAST,
  PAIR_UDP_PORT,
};
