// Real downloads through the packaged exe (needs network and a Firefox YouTube sign-in for the 18+ case).
const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');

const exe = path.resolve(__dirname, '../../release-v2/SimpleTube-win32-x64/SimpleTube.exe');
const ffprobe = path.resolve(__dirname, '../../release-v2/SimpleTube-win32-x64/resources/tools/ffprobe.exe');
const cases = [
  { name: 'whole video, video+audio', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'full' },
  { name: 'whole 3.5 min video, video+audio', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mode: 'full' },
  { name: 'whole video, audio only', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'audio' },
  { name: '4K AV1 clip, video+audio', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', mode: 'full', start: '00:00:10', end: '00:00:13' },
  { name: '4K AV1 clip, video only', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', mode: 'video', start: '00:00:20', end: '00:00:23' },
  { name: 'music clip, audio only', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mode: 'audio', start: '00:00:30', end: '00:00:45' },
  { name: 'music clip, video+audio', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mode: 'full', start: '00:00:30', end: '00:00:45' },
  { name: '18+ clip, video+audio', url: 'https://www.youtube.com/watch?v=6kLq3WMV1nU', mode: 'full', start: '00:00:05', end: '00:00:08' },
];

(async () => {
  const folder = path.resolve(__dirname, '../artifacts/packaged-downloads');
  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  const app = await _electron.launch({ executablePath: exe, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  let failed = 0;
  try {
    const page = await app.firstWindow();
    await page.locator('#folder').fill(folder);
    for (const c of cases) {
      const before = new Set(await fs.readdir(folder));
      await page.locator('#url').fill(c.url);
      await page.locator('#url').press('Enter');
      await page.waitForFunction(() => !document.querySelector('#download').disabled || document.querySelector('#error').textContent, {}, { timeout: 120000 });
      // Type like a user: instant fill() races the unfolding clip section.
      const typeInto = async (id, text) => { await page.locator(id).click(); await page.keyboard.press('Control+A'); await page.keyboard.type(text); };
      if (c.start) { await typeInto('#start', c.start); await typeInto('#end', c.end); }
      await page.locator(`[data-mode="${c.mode}"]`).click();
      await page.locator('#download').click({ timeout: 10000 });
      // Sample the ring every 500 ms: it must move from the start and never go backwards.
      const ring = [];
      while (!(await page.evaluate(() => document.querySelector('#download').innerText === 'Open in folder' || document.querySelector('#error').textContent))) {
        ring.push(parseInt(await page.locator('#percent').innerText(), 10));
        if (ring.length > 800) break;
        await page.waitForTimeout(500);
      }
      const ringOk = ring.every((p, i) => i === 0 || p >= ring[i - 1]) && ring.slice(2).every(p => p > 0);
      const error = await page.locator('#error').innerText();
      const file = (await fs.readdir(folder)).find(f => !before.has(f));
      if (error || !file) { failed++; console.log(`FAIL  ${c.name}: ${error || 'no file'}`); continue; }
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(folder, file)]));
      const streams = probe.streams.map(s => `${s.codec_type}:${s.codec_name}${s.height ? ' ' + s.height + 'p' : ''}${s.sample_rate ? ' ' + s.sample_rate / 1000 + 'kHz' : ''}`).join(', ');
      const kbps = Math.round(Number(probe.format.bit_rate) / 1000);
      if (!ringOk) failed++;
      console.log(`${ringOk ? 'OK  ' : 'FAIL'}  ${c.name}: ${file} — ${Number(probe.format.duration).toFixed(1)}s — ${streams} — ${kbps} kbps total`);
      console.log(`      ring every 0.5 s: ${ring.join(' ')}`);
    }
  } finally { await app.close(); }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
