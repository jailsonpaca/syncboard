import dgram from 'dgram';
import os from 'os';
import crypto from 'crypto';

export const PAIR_MULTICAST = '239.255.77.87';
export const PAIR_UDP_PORT = 18787;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 6): string {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export function getLanIPv4(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      const family = String(net.family);
      if ((family === 'IPv4' || family === '4') && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

export type PairInfo = {
  code: string;
  url: string;
  urls: string[];
  token: string;
  qrPayload: string;
  joinUrl: string;
  udpPort: number;
  hostname: string;
};

export class PairService {
  code = '';
  token = '';
  private readonly httpPort: number;
  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(httpPort: number) {
    this.httpPort = httpPort;
    this.regenerate();
  }

  regenerate(): PairInfo {
    this.code = randomCode(6);
    this.token = crypto.randomBytes(16).toString('hex');
    return this.getInfo();
  }

  lanUrls(): string[] {
    const ips = getLanIPv4();
    if (!ips.length) return [`http://127.0.0.1:${this.httpPort}`];
    return ips.map((ip) => `http://${ip}:${this.httpPort}`);
  }

  getInfo(): PairInfo {
    const urls = this.lanUrls();
    const url = urls[0]!;
    const qrPayload = `syncboard://join?url=${encodeURIComponent(url)}&code=${this.code}`;
    return {
      code: this.code,
      url,
      urls,
      token: this.token,
      qrPayload,
      joinUrl: `${url}/?join=${this.code}`,
      udpPort: PAIR_UDP_PORT,
      hostname: os.hostname(),
    };
  }

  join(code: string): { serverUrl: string; token: string; urls: string[] } | null {
    const normalized = String(code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!normalized || normalized !== this.code) return null;
    const urls = this.lanUrls();
    return { serverUrl: urls[0]!, token: this.token, urls };
  }

  private beaconPayload(): Buffer {
    const info = this.getInfo();
    return Buffer.from(
      JSON.stringify({
        type: 'syncboard-pair',
        v: 1,
        code: info.code,
        url: info.url,
        urls: info.urls,
        token: info.token,
        hostname: os.hostname(),
      }),
      'utf8'
    );
  }

  startBeacon(): void {
    if (this.socket) return;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      console.warn('[pair] udp:', err.message);
    });

    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        const type = String(data?.type || '');

        // Busca aberta na LAN (lista todos os servidores SyncBoard)
        if (type === 'syncboard-discover') {
          socket.send(this.beaconPayload(), rinfo.port, rinfo.address);
          return;
        }

        if (type === 'syncboard-pair-query' && data.code) {
          const hit = this.join(String(data.code));
          if (!hit) return;
          const reply = Buffer.from(
            JSON.stringify({
              type: 'syncboard-pair',
              v: 1,
              code: this.code,
              url: hit.serverUrl,
              urls: hit.urls,
              token: hit.token,
              hostname: os.hostname(),
            }),
            'utf8'
          );
          socket.send(reply, rinfo.port, rinfo.address);
        }
      } catch {
        /* ignore */
      }
    });

    socket.bind(PAIR_UDP_PORT, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
        socket.addMembership(PAIR_MULTICAST);
      } catch (err) {
        console.warn('[pair] multicast:', (err as Error).message);
      }
      console.log(`  Pair UDP: ${PAIR_MULTICAST}:${PAIR_UDP_PORT} (código ${this.code})`);
    });

    this.timer = setInterval(() => {
      if (!this.socket) return;
      const buf = this.beaconPayload();
      try {
        this.socket.send(buf, PAIR_UDP_PORT, PAIR_MULTICAST);
      } catch {
        /* ignore */
      }
    }, 2000);
  }

  stopBeacon(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ok */
      }
      this.socket = null;
    }
  }
}
