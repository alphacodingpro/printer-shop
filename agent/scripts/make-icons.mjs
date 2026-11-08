// Generates the tray icons (printer + coloured status dot) and the app icon. No dependencies.
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'assets');
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, rgba) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Draw on a 4x supersampled canvas in a 0..1 coordinate space, then average down.
function render(size, draw) {
  const S = 4, N = size * S;
  const buf = new Float32Array(N * N * 4);
  const put = (x, y, [r, g, b, a]) => {
    const i = (y * N + x) * 4, ia = buf[i + 3], oa = a + ia * (1 - a);
    if (oa === 0) return;
    for (let k = 0; k < 3; k++) buf[i + k] = ([r, g, b][k] * a + buf[i + k] * ia * (1 - a)) / oa;
    buf[i + 3] = oa;
  };
  const shape = (inside, color) => { for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inside((x + 0.5) / N, (y + 0.5) / N)) put(x, y, color); };
  draw({
    rrect: (x0, y0, x1, y1, r, color) => shape((x, y) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) return false;
      const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    }, color),
    circle: (cx, cy, r, color) => shape((x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r, color),
  });
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) { const i = ((y * S + sy) * N + x * S + sx) * 4; a += buf[i + 3]; r += buf[i] * buf[i + 3]; g += buf[i + 1] * buf[i + 3]; b += buf[i + 2] * buf[i + 3]; }
    const o = (y * size + x) * 4;
    if (a > 0) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
    px[o + 3] = Math.round((a / (S * S)) * 255);
  }
  return png(size, size, px);
}

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const INK = hex('#2b3340'), PAPER = hex('#ffffff'), EDGE = hex('#ffffff');
const STATUS = { green: '#1fa84f', amber: '#f2b705', red: '#d93025', grey: '#8a94a3' };

function printerGlyph(d, bodyColor, paperColor) {
  d.rrect(0.22, 0.04, 0.78, 0.46, 0.04, bodyColor);       // paper outline, so it also shows on light taskbars
  d.rrect(0.275, 0.1, 0.725, 0.46, 0.02, paperColor);     // paper coming out
  d.rrect(0.08, 0.34, 0.92, 0.74, 0.1, bodyColor);        // body
  d.rrect(0.18, 0.54, 0.82, 0.94, 0.04, bodyColor);       // tray outline
  d.rrect(0.235, 0.6, 0.765, 0.9, 0.02, paperColor);      // paper tray
}

for (const [name, color] of Object.entries(STATUS)) {
  for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
    fs.writeFileSync(path.join(out, `tray-${name}${suffix}.png`), render(size, (d) => {
      d.rrect(0.04, 0.04, 0.96, 0.96, 0.0, [0, 0, 0, 0]);
      printerGlyph(d, INK, PAPER);
      d.circle(0.76, 0.76, 0.27, EDGE);
      d.circle(0.76, 0.76, 0.2, hex(color));
    }));
  }
}
fs.writeFileSync(path.join(out, 'icon.png'), render(512, (d) => {
  d.rrect(0.04, 0.04, 0.96, 0.96, 0.2, hex('#0a78a6'));
  d.rrect(0.26, 0.15, 0.74, 0.46, 0.03, PAPER);
  d.rrect(0.14, 0.38, 0.86, 0.72, 0.08, hex('#14181f'));
  d.rrect(0.24, 0.6, 0.76, 0.86, 0.03, PAPER);
  d.circle(0.74, 0.5, 0.035, hex('#1fa84f'));
}));
console.log('icons written to', out);
