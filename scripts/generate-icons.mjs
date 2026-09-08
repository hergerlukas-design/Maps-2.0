/**
 * Generates the PWA icons as PNGs.
 *
 * Written by hand rather than pulled from a library because the container has no
 * image tooling, and a canvas dependency for three static files is not worth it.
 * Node's zlib provides the only non-trivial part of the PNG format.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../public/icons');

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encodes an RGBA pixel buffer (width × height × 4) as a PNG. */
function encodePng(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function createCanvas(size) {
  return { size, pixels: Buffer.alloc(size * size * 4) };
}

function setPixel(canvas, x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size || alpha <= 0) return;
  const offset = (y * canvas.size + x) * 4;
  const existing = canvas.pixels[offset + 3] / 255;
  const a = Math.min(1, alpha);
  // Source-over compositing, so the bolt blends onto the plate rather than
  // punching a hole in it.
  const outAlpha = a + existing * (1 - a);
  if (outAlpha === 0) return;
  for (let i = 0; i < 3; i++) {
    const src = [r, g, b][i];
    const dst = canvas.pixels[offset + i];
    canvas.pixels[offset + i] = Math.round((src * a + dst * existing * (1 - a)) / outAlpha);
  }
  canvas.pixels[offset + 3] = Math.round(outAlpha * 255);
}

/** 3×3 supersampling, so the rounded corners and the bolt are not jagged. */
const SAMPLES = [1 / 6, 3 / 6, 5 / 6];

function fill(canvas, colour, inside) {
  for (let y = 0; y < canvas.size; y++) {
    for (let x = 0; x < canvas.size; x++) {
      let hits = 0;
      for (const dy of SAMPLES) {
        for (const dx of SAMPLES) {
          if (inside(x + dx, y + dy)) hits++;
        }
      }
      if (hits > 0) setPixel(canvas, x, y, colour, hits / 9);
    }
  }
}

function roundedRect(size, radius, inset = 0) {
  const min = inset;
  const max = size - inset;
  return (x, y) => {
    if (x < min || y < min || x > max || y > max) return false;
    // Only the corner quadrants need the circular test.
    const cx = x < min + radius ? min + radius : x > max - radius ? max - radius : x;
    const cy = y < min + radius ? min + radius : y > max - radius ? max - radius : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
}

/** Even-odd scanline test for an arbitrary polygon. */
function polygon(points) {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
}

const INK = [11, 17, 32];
const CYAN = [34, 211, 238];

/** The bolt, described on a 64×64 grid and scaled to the icon size. */
const BOLT_64 = [
  [34, 6],
  [19, 34],
  [29, 34],
  [25, 58],
  [45, 27],
  [34, 27],
];

function drawIcon(size, { maskable }) {
  const canvas = createCanvas(size);
  // A maskable icon must survive being cropped to a circle, so the plate covers
  // the full square and the bolt sits inside the 80 % safe zone.
  const plateRadius = maskable ? size / 2 : size * 0.22;
  fill(canvas, INK, roundedRect(size, plateRadius));

  const scale = (maskable ? size * 0.62 : size * 0.82) / 64;
  const offset = (size - 64 * scale) / 2;
  fill(
    canvas,
    CYAN,
    polygon(BOLT_64.map(([x, y]) => [offset + x * scale, offset + y * scale])),
  );

  return encodePng(canvas.pixels, size, size);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const target of targets) {
  const png = drawIcon(target.size, { maskable: target.maskable });
  writeFileSync(resolve(OUT_DIR, target.file), png);
  console.log(`${target.file}: ${target.size}×${target.size}, ${png.length} B`);
}
