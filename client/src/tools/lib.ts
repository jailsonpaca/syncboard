// Funções puras das ferramentas (sem React) — testáveis com vitest.

// ---------- JSON ----------
export function formatJson(input: string, indent = 2): string {
  return JSON.stringify(JSON.parse(input), null, indent);
}

export function minifyJson(input: string): string {
  return JSON.stringify(JSON.parse(input));
}

// ---------- Base64 (UTF-8 seguro) ----------
export function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64Decode(input: string): string {
  const clean = input.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ---------- URL / HTML ----------
export const urlEncode = (s: string) => encodeURIComponent(s);
export const urlDecode = (s: string) => decodeURIComponent(s);

const HTML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function htmlEncode(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}

export function htmlDecode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------- JWT ----------
export function decodeJwt(token: string): { header: unknown; payload: unknown; signature: string; expiresAt?: string } {
  const parts = token.trim().split('.');
  if (parts.length < 2) throw new Error('JWT inválido: esperado header.payload[.assinatura]');
  const header = JSON.parse(base64Decode(parts[0]));
  const payload = JSON.parse(base64Decode(parts[1]));
  const exp = (payload as { exp?: number }).exp;
  return {
    header,
    payload,
    signature: parts[2] ?? '',
    expiresAt: typeof exp === 'number' ? new Date(exp * 1000).toISOString() : undefined,
  };
}

// ---------- Hash ----------
export type HashAlgo = 'MD5' | 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashText(input: string, algo: HashAlgo): Promise<string> {
  const data = new TextEncoder().encode(input);
  if (algo === 'MD5') return toHex(md5(data));
  return toHex(await crypto.subtle.digest(algo, data));
}

// MD5 (RFC 1321) — a Web Crypto não oferece MD5.
export function md5(data: Uint8Array): Uint8Array {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = data.length;
  const padLen = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, (len << 3) >>> 0, true);
  dv.setUint32(padLen - 4, Math.floor(len / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x: number, c: number) => ((x << c) | (x >>> (32 - c))) >>> 0;
  for (let off = 0; off < padLen; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true); odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return out;
}

// ---------- Geradores ----------
export function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type PasswordOpts = { length: number; lower: boolean; upper: boolean; digits: boolean; symbols: boolean };

function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

export function generatePassword(o: PasswordOpts): string {
  const sets: string[] = [];
  if (o.lower) sets.push('abcdefghijklmnopqrstuvwxyz');
  if (o.upper) sets.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  if (o.digits) sets.push('0123456789');
  if (o.symbols) sets.push('!@#$%^&*()-_=+[]{};:,.?');
  if (sets.length === 0) throw new Error('Selecione ao menos um tipo de caractere');
  const length = Math.max(sets.length, Math.min(256, Math.floor(o.length)));
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]); // garante 1 de cada tipo
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const LOREM_WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(
    ' ',
  );

export function loremIpsum(paragraphs: number, sentencesPerParagraph = 5): string {
  const n = Math.max(1, Math.min(50, Math.floor(paragraphs)));
  const out: string[] = [];
  let w = 0;
  for (let p = 0; p < n; p++) {
    const sentences: string[] = [];
    for (let s = 0; s < sentencesPerParagraph; s++) {
      const count = 8 + ((p + s) % 7);
      const words: string[] = [];
      for (let i = 0; i < count; i++) words.push(LOREM_WORDS[w++ % LOREM_WORDS.length]);
      const text = words.join(' ');
      sentences.push(text[0].toUpperCase() + text.slice(1) + '.');
    }
    out.push(sentences.join(' '));
  }
  return out.join('\n\n');
}

// ---------- Timestamp ----------
export function timestampToDate(input: string): { iso: string; local: string; unit: 's' | 'ms' } {
  const n = Number(input.trim());
  if (!Number.isFinite(n)) throw new Error('Informe um número');
  const unit: 's' | 'ms' = Math.abs(n) >= 1e11 ? 'ms' : 's';
  const d = new Date(unit === 'ms' ? n : n * 1000);
  if (Number.isNaN(d.getTime())) throw new Error('Data fora do intervalo');
  return { iso: d.toISOString(), local: d.toLocaleString('pt-BR'), unit };
}

export function dateToTimestamp(input: string): { seconds: number; millis: number } {
  const d = new Date(input.trim());
  if (Number.isNaN(d.getTime())) throw new Error('Data inválida');
  return { seconds: Math.floor(d.getTime() / 1000), millis: d.getTime() };
}

// ---------- Base numérica ----------
export type NumBase = 2 | 8 | 10 | 16;

export function convertBase(input: string, from: NumBase): Record<NumBase, string> {
  const clean = input.trim().replace(/[\s_]/g, '').replace(/^0[xbo]/i, '');
  if (!clean) throw new Error('Informe um número');
  const digits = '0123456789abcdef'.slice(0, from);
  if (![...clean.toLowerCase()].every((c) => digits.includes(c))) {
    throw new Error(`Dígitos inválidos para base ${from}`);
  }
  let value = 0n;
  for (const c of clean.toLowerCase()) value = value * BigInt(from) + BigInt(digits.indexOf(c));
  return {
    2: value.toString(2),
    8: value.toString(8),
    10: value.toString(10),
    16: value.toString(16).toUpperCase(),
  };
}

// ---------- Cores ----------
export type Rgb = { r: number; g: number; b: number };

export function parseColor(input: string): Rgb {
  const s = input.trim().toLowerCase();
  let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = /^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/.exec(s);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (r > 255 || g > 255 || b > 255) throw new Error('RGB fora de 0–255');
    return { r, g, b };
  }
  m = /^hsl\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})%?\s*[, ]\s*(\d{1,3})%?\s*\)$/.exec(s);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  throw new Error('Cor inválida. Use #RRGGBB, rgb(r,g,b) ou hsl(h,s%,l%)');
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const S = s / 100, L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// ---------- Case converter ----------
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export const caseConverters: Record<string, (s: string) => string> = {
  MAIÚSCULAS: (s) => s.toUpperCase(),
  minúsculas: (s) => s.toLowerCase(),
  'Title Case': (s) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()),
  camelCase: (s) => words(s).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(''),
  PascalCase: (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(''),
  snake_case: (s) => words(s).map((w) => w.toLowerCase()).join('_'),
  'kebab-case': (s) => words(s).map((w) => w.toLowerCase()).join('-'),
  CONSTANT_CASE: (s) => words(s).map((w) => w.toUpperCase()).join('_'),
};

// ---------- Diff de texto (linha a linha, LCS) ----------
export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) throw new Error('Textos grandes demais para comparar');
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: A[i++] });
    else out.push({ type: 'add', text: B[j++] });
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

// ---------- Regex ----------
export type RegexMatch = { index: number; text: string; groups: string[] };

export function runRegex(pattern: string, flags: string, text: string): RegexMatch[] {
  if (!pattern) return [];
  const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
  const out: RegexMatch[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ index: m.index ?? 0, text: m[0], groups: m.slice(1).map((g) => g ?? '') });
    if (out.length >= 500) break;
  }
  return out;
}
