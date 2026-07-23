const dgram = require('dgram');

const PAIR_MULTICAST = '239.255.77.87';
const PAIR_UDP_PORT = 18787;

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

/**
 * Lista servidores SyncBoard anunciando na LAN (UDP multicast + beacons).
 * @param {number} [timeoutMs]
 * @returns {Promise<Array<{ serverUrl: string, code?: string, hostname?: string, urls?: string[] }>>}
 */
function discoverServers(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    /** @type {Map<string, { serverUrl: string, code?: string, hostname?: string, urls?: string[] }>} */
    const found = new Map();
    let closed = false;

    const ingest = (data) => {
      if (data?.type !== 'syncboard-pair' || !data.url) return;
      const serverUrl = String(data.url).replace(/\/$/, '');
      const prev = found.get(serverUrl);
      found.set(serverUrl, {
        serverUrl,
        code: data.code ? String(data.code).toUpperCase() : prev?.code,
        hostname: data.hostname ? String(data.hostname) : prev?.hostname,
        urls: Array.isArray(data.urls) ? data.urls.map((u) => String(u).replace(/\/$/, '')) : prev?.urls,
      });
    };

    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        /* ok */
      }
      resolve([...found.values()].sort((a, b) => a.serverUrl.localeCompare(b.serverUrl)));
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', () => {
      clearTimeout(timer);
      finish();
    });

    socket.on('message', (msg) => {
      try {
        ingest(JSON.parse(msg.toString('utf8')));
      } catch {
        /* ignore */
      }
    });

    const sendDiscover = () => {
      const query = Buffer.from(JSON.stringify({ type: 'syncboard-discover', v: 1 }), 'utf8');
      try {
        socket.send(query, PAIR_UDP_PORT, PAIR_MULTICAST);
        socket.send(query, PAIR_UDP_PORT, '255.255.255.255');
      } catch {
        /* ok */
      }
    };

    socket.bind(PAIR_UDP_PORT, () => {
      try {
        socket.setBroadcast(true);
        socket.addMembership(PAIR_MULTICAST);
      } catch {
        /* ok */
      }
      sendDiscover();
      // segundo ping — captura quem acaba de subir
      setTimeout(sendDiscover, 900);
    });
  });
}

module.exports = {
  discoverByCode,
  discoverServers,
  parseJoinPayload,
  PAIR_MULTICAST,
  PAIR_UDP_PORT,
};
