#!/usr/bin/env node
/**
 * Sincroniza a versão em todos os package.json do monorepo.
 * Uso: node scripts/bump-version.js 1.2.0
 *      node scripts/bump-version.js --sync   (propaga a versão da raiz)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGES = [
  'package.json',
  'client/package.json',
  'server/package.json',
  'desktop/package.json',
  'daemon/package.json',
];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function writeJson(rel, data) {
  fs.writeFileSync(path.join(ROOT, rel), `${JSON.stringify(data, null, 2)}\n`);
}

const arg = process.argv[2];
if (!arg) {
  console.error('Uso: node scripts/bump-version.js <versão> | --sync');
  process.exit(1);
}

let version;
if (arg === '--sync') {
  version = readJson('package.json').version;
} else {
  version = arg.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error('Versão inválida:', version);
    process.exit(1);
  }
}

for (const rel of PACKAGES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const pkg = readJson(rel);
  pkg.version = version;
  writeJson(rel, pkg);
  console.log(`✓ ${rel} → ${version}`);
}

console.log(`Versão sincronizada: ${version}`);
