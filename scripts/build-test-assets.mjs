/**
 * 生成测试素材：2x2 四色网格 PNG（纯 Node 实现，无第三方库）。
 * 输出 src/assets/vision-grid.png 与 src/assets/vision-grid.b64
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../src/assets');

const W = 256;
const H = 256;

// 四色块：左上红、右上蓝、左下绿、右下黄
const COLORS = [
  [220, 40, 40], // red
  [40, 90, 220], // blue
  [40, 170, 70], // green
  [235, 200, 40], // yellow
];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// 原始扫描行：每行 1 字节 filter + W*3 像素
const raw = Buffer.alloc(H * (1 + W * 3));
let p = 0;
for (let y = 0; y < H; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const left = x < W / 2;
    const top = y < H / 2;
    const idx = top ? (left ? 0 : 1) : left ? 2 : 3;
    const [r, g, b] = COLORS[idx];
    raw[p++] = r;
    raw[p++] = g;
    raw[p++] = b;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'vision-grid.png'), png);
writeFileSync(resolve(OUT_DIR, 'vision-grid.b64'), png.toString('base64'));
console.log(`vision-grid.png ${png.length} bytes -> ${OUT_DIR}`);
console.log(`base64 length ${png.toString('base64').length}`);
