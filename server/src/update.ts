import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type LatestManifest = {
  version: string;
  publishedAt?: string;
  downloadPage?: string;
  github?: { owner: string; repo: string; tag?: string };
  assets?: {
    macDmg?: string | null;
    macZip?: string | null;
    linuxAppImage?: string | null;
    linuxTar?: string | null;
  };
};

function readReleaseConfig(): { owner: string; repo: string; downloadUrl: string } {
  const candidates = [
    process.env.SYNCBOARD_RELEASE_CONFIG,
    path.join(__dirname, '..', '..', 'release.config.json'),
    path.join(__dirname, '..', 'release.config.json'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      /* next */
    }
  }
  return { owner: 'jailsonpaca', repo: 'syncboard', downloadUrl: '' };
}

export function getLocalVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8')).version || '0.0.0';
      }
    } catch {
      /* next */
    }
  }
  return '0.0.0';
}

export function parseVersion(v: string): number[] {
  return String(v || '0')
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n.replace(/\D.*/, ''), 10) || 0);
}

export function isNewer(remote: string, local: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

let cache: { checkedAt: number; manifest: LatestManifest | null; error?: string } = {
  checkedAt: 0,
  manifest: null,
};

const CACHE_MS = 30 * 60 * 1000;

export async function fetchLatestManifest(force = false): Promise<LatestManifest | null> {
  if (!force && cache.manifest && Date.now() - cache.checkedAt < CACHE_MS) {
    return cache.manifest;
  }

  const cfg = readReleaseConfig();
  const owner = process.env.SYNCBOARD_GH_OWNER || cfg.owner;
  const repo = process.env.SYNCBOARD_GH_REPO || cfg.repo;

  const urls = [
    `https://github.com/${owner}/${repo}/releases/latest/download/latest.json`,
    `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SyncBoard-Server',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, unknown>;

      if (typeof data.version === 'string' && data.assets && !Array.isArray(data.assets)) {
        const manifest = data as unknown as LatestManifest;
        if (!manifest.downloadPage) manifest.downloadPage = cfg.downloadUrl;
        cache = { checkedAt: Date.now(), manifest };
        return manifest;
      }

      // GitHub API release object → normaliza
      if (typeof data.tag_name === 'string') {
        const version = String(data.tag_name).replace(/^v/, '');
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const find = (re: RegExp) => {
          const hit = assets.find(
            (a) => a && typeof a === 'object' && re.test(String((a as { name?: string }).name || ''))
          ) as { browser_download_url?: string } | undefined;
          return hit?.browser_download_url || null;
        };
        const manifest: LatestManifest = {
          version,
          publishedAt: String(data.published_at || ''),
          downloadPage: cfg.downloadUrl,
          github: { owner, repo, tag: String(data.tag_name) },
          assets: {
            macDmg: find(/\.dmg$/i),
            macZip: find(/\.zip$/i),
            linuxAppImage: find(/\.AppImage$/i),
            linuxTar: find(/\.tar\.gz$/i),
          },
        };
        cache = { checkedAt: Date.now(), manifest };
        return manifest;
      }
    } catch (err) {
      cache.error = (err as Error).message;
    }
  }

  cache.checkedAt = Date.now();
  return cache.manifest;
}

export async function getUpdateStatus(force = false) {
  const current = getLocalVersion();
  const latest = await fetchLatestManifest(force);
  const updateAvailable = Boolean(latest && isNewer(latest.version, current));
  return {
    current,
    latest: latest?.version || null,
    updateAvailable,
    downloadPage: latest?.downloadPage || readReleaseConfig().downloadUrl || null,
    assets: latest?.assets || null,
    publishedAt: latest?.publishedAt || null,
    checkedAt: cache.checkedAt,
    error: cache.error || null,
  };
}

export function startUpdatePolling(intervalMs = 6 * 60 * 60 * 1000): void {
  void getUpdateStatus(true);
  setInterval(() => {
    void getUpdateStatus(true);
  }, intervalMs);
}
