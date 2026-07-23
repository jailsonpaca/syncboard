#!/usr/bin/env node
/**
 * Gera desktop/release/latest.json a partir dos artefatos e release.config.json.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'desktop', 'release');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'release.config.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const owner = process.env.SYNCBOARD_GH_OWNER || cfg.owner;
const repo = process.env.SYNCBOARD_GH_REPO || cfg.repo;
const downloadPage = process.env.SYNCBOARD_DOWNLOAD_URL || cfg.downloadUrl;
const base = `https://github.com/${owner}/${repo}/releases/download/v${version}`;

function findAsset(patterns) {
  if (!fs.existsSync(RELEASE_DIR)) return null;
  const files = fs.readdirSync(RELEASE_DIR);
  for (const pattern of patterns) {
    const hit = files.find((f) =>
      typeof pattern === 'string' ? f === pattern : pattern.test(f)
    );
    if (hit) return hit;
  }
  return null;
}

const macDmg = findAsset([/^SyncBoard-.*\.dmg$/, /^SyncBoard.*\.dmg$/]);
const macZip = findAsset([/^SyncBoard-.*-mac\.zip$/, /^SyncBoard.*\.zip$/]);
const linuxAppImage = findAsset([/^SyncBoard-.*\.AppImage$/, /SyncBoard.*\.AppImage$/]);
const linuxTar = findAsset([
  'SyncBoard-linux-x64.tar.gz',
  /^SyncBoard-.*-x64\.tar\.gz$/,
  /^SyncBoard-.*\.tar\.gz$/,
]);

const latest = {
  version,
  publishedAt: new Date().toISOString(),
  downloadPage,
  github: { owner, repo, tag: `v${version}` },
  assets: {
    macDmg: macDmg ? `${base}/${macDmg}` : null,
    macZip: macZip ? `${base}/${macZip}` : null,
    linuxAppImage: linuxAppImage ? `${base}/${linuxAppImage}` : null,
    linuxTar: linuxTar ? `${base}/${linuxTar}` : null,
  },
  files: {
    macDmg,
    macZip,
    linuxAppImage,
    linuxTar,
  },
};

fs.mkdirSync(RELEASE_DIR, { recursive: true });
const out = path.join(RELEASE_DIR, 'latest.json');
fs.writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`✓ ${out}`);
console.log(JSON.stringify(latest, null, 2));
