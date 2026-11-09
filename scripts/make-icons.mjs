// Renders the Salonzoft app icons from one SVG design (the "sparkles" brand mark).
// Usage (sharp is not a project dependency):
//   npm i --no-save sharp@0.33 && node scripts/make-icons.mjs apps/web/public
// Writes favicon.ico/.svg, icons/* (any + maskable + apple-touch) and preview.png in the cwd.
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
const iconsDir = join(out, 'icons');
mkdirSync(iconsDir, { recursive: true });

const STAR = 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z';

/** @param {{ rounded: boolean, scale: number, simple?: boolean }} o */
function svg({ rounded, scale, simple = false }) {
  const r = rounded ? 112 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#84407a"/>
      <stop offset="1" stop-color="#4f1f45"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${r}" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${scale}) translate(-12 -12)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${STAR}" fill="#ffffff" stroke="#ffffff" stroke-width="1.5"/>
${simple ? '' : `<path d="M20 2v4M22 4h-4" stroke="#f1d2bf" stroke-width="1.75"/>
    <circle cx="4" cy="20" r="2" stroke="#f1d2bf" stroke-width="1.75"/>`}
  </g>
</svg>
`;
}

const standard = svg({ rounded: true, scale: 13 });   // glyph ≈ 60 % of the tile
const maskable = svg({ rounded: false, scale: 9.5 }); // inside the 80 % safe zone

writeFileSync(join(out, 'favicon.svg'), standard);
writeFileSync(join(iconsDir, 'icon.svg'), standard);
writeFileSync(join(iconsDir, 'maskable.svg'), maskable);

const png = (src, size) => sharp(Buffer.from(src), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const files = [
  ['icons/icon-192.png', standard, 192],
  ['icons/icon-512.png', standard, 512],
  ['icons/maskable-192.png', maskable, 192],
  ['icons/maskable-512.png', maskable, 512],
  // iOS masks the corners itself and needs an opaque square.
  ['icons/apple-touch-icon.png', svg({ rounded: false, scale: 11 }), 180],
];
for (const [name, src, size] of files) writeFileSync(join(out, name), await png(src, size));

// favicon.ico with PNG-encoded 16, 32 and 48 px images.
const sizes = [16, 32, 48];
// Tiny sizes: the star alone, larger, so it stays legible in a browser tab.
const tiny = svg({ rounded: true, scale: 17, simple: true });
const images = await Promise.all(sizes.map((s) => png(s < 48 ? tiny : standard, s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const dir = images.map((img, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i], 0);
  e.writeUInt8(sizes[i], 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.length;
  return e;
});
writeFileSync(join(out, 'favicon.ico'), Buffer.concat([header, ...dir, ...images]));

// Preview sheet for review (not shipped).
await sharp({ create: { width: 760, height: 220, channels: 4, background: '#faf8f6' } })
  .composite([
    { input: await png(standard, 192), left: 16, top: 14 },
    { input: await png(maskable, 192), left: 224, top: 14 },
    { input: await png(svg({ rounded: false, scale: 11 }), 180), left: 432, top: 20 },
    { input: await png(standard, 48), left: 640, top: 40 },
    { input: await png(tiny, 32), left: 640, top: 110 },
    { input: await png(tiny, 16), left: 690, top: 118 },
  ])
  .png()
  .toFile(join(process.cwd(), 'preview.png'));
console.log('ok');
