// Builds ui/icon.png and a multi-size ui/icon.ico from one square PNG (256×256 or larger).
// Usage: node scripts/make-icon.js "C:\path\to\icon.png"
// Each size is resampled by the bundled ffmpeg (Lanczos) and stored as PNG inside the .ico,
// which Windows supports since Vista; that keeps small sizes crisp and the file small.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const source = process.argv[2];
if (!source || !fs.existsSync(source)) throw Error('Pass the path to a square PNG.');
const ffmpeg = path.resolve(__dirname, '../../tools/ffmpeg.exe');
const ui = path.resolve(__dirname, '../ui');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'simpletube-icon-'));

const images = SIZES.map(size => {
  const out = path.join(temp, `${size}.png`);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', source, '-vf', `scale=${size}:${size}:flags=lanczos,format=rgba`, '-frames:v', '1', out]);
  return { size, data: fs.readFileSync(out) };
});

// ICO = 6-byte header + 16-byte entry per image + image data.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);   // 0 means 256
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt16LE(1, 4);                      // colour planes
  entry.writeUInt16LE(32, 6);                     // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  return entry;
});
fs.writeFileSync(path.join(ui, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map(i => i.data)]));
fs.copyFileSync(images.at(-1) && path.join(temp, '256.png'), path.join(ui, 'icon.png'));
fs.rmSync(temp, { recursive: true, force: true });
console.log(`icon.ico: ${SIZES.join(', ')} px; icon.png: 256 px`);
