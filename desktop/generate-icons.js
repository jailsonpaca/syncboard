const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function writePng(filePath, size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = ihdr[11] = ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(filePath, png);
}

function drawClipboard(x, y, s, color) {
  const [r, g, b] = color;
  const m = s / 16;
  const bx = Math.floor(3 * m);
  const by = Math.floor(3 * m);
  const bw = Math.floor(10 * m);
  const bh = Math.floor(11 * m);
  const t = Math.max(1, Math.floor(1.2 * m));

  const inRect = (px, py, rx, ry, rw, rh) =>
    px >= rx && px < rx + rw && py >= ry && py < ry + rh;

  const onBorder = (px, py) => {
    if (inRect(px, py, bx, by, bw, bh) && !inRect(px, py, bx + t, by + t, bw - 2 * t, bh - 2 * t))
      return true;
    const tabW = Math.floor(4 * m);
    const tabH = Math.floor(2 * m);
    const tabX = bx + Math.floor(3 * m);
    if (inRect(px, py, tabX, by - tabH, tabW, tabH)) return true;
    return false;
  };

  const onLine = (px, py, ly) => {
    const lx = bx + t + 1;
    const lw = bw - 2 * t - 2;
    return py === ly && px >= lx && px < lx + lw;
  };

  if (onBorder(x, y)) return [r, g, b, 255];
  if (onLine(x, y, by + Math.floor(4 * m))) return [r, g, b, 180];
  if (onLine(x, y, by + Math.floor(7 * m))) return [r, g, b, 140];
  if (onLine(x, y, by + Math.floor(10 * m))) return [r, g, b, 100];
  return [0, 0, 0, 0];
}

function generateTo(iconsDir) {
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const size of [16, 22, 32, 512]) {
    const color = [108, 92, 231];
    writePng(path.join(iconsDir, `tray-${size}.png`), size, (x, y, s) =>
      drawClipboard(x, y, s, color)
    );
    if (size <= 32) {
      writePng(path.join(iconsDir, `tray-template-${size}.png`), size, (x, y, s) =>
        drawClipboard(x, y, s, [0, 0, 0])
      );
    }
  }

  writePng(path.join(iconsDir, 'icon.png'), 512, (x, y, s) =>
    drawClipboard(x, y, s, [108, 92, 231])
  );

  return iconsDir;
}

function main() {
  const iconsDir = generateTo(path.join(__dirname, 'icons'));
  console.log('Ícones gerados em', iconsDir);
}

if (require.main === module) {
  main();
}

module.exports = { main, generateTo };
