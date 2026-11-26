// Real downloads through the packaged exe (needs network and a Firefox YouTube sign-in for the 18+ case).
const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');

const exe = path.resolve(__dirname, '../../release-v2/SimpleTube-win32-x64/SimpleTube.exe');
const ffprobe = path.resolve(__dirname, '../../release-v2/SimpleTube-win32-x64/resources/tools/ffprobe.exe');
const cases = [
  { name: 'whole video, video+audio', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'full' },
  { name: 'whole video, audio only', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'audio' },
  { name: '4K AV1 clip, video+audio', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', mode: 'full', start: '00:00:10', end: '00:00:13' },
  { name: '4K AV1 clip, video only', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', mode: 'video', start: '00:00:20', end: '00:00:23' },
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
      await page.waitForFunction(() => document.querySelector('#download').innerText === 'Open in folder' || document.querySelector('#error').textContent, {}, { timeout: 400000 });
      const error = await page.locator('#error').innerText();
      const file = (await fs.readdir(folder)).find(f => !before.has(f));
      if (error || !file) { failed++; console.log(`FAIL  ${c.name}: ${error || 'no file'}`); continue; }
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(folder, file)]));
      const streams = probe.streams.map(s => `${s.codec_type}:${s.codec_name}${s.height ? ' ' + s.height + 'p' : ''}`).join(', ');
      console.log(`OK    ${c.name}: ${file} — ${Number(probe.format.duration).toFixed(1)}s — ${streams}`);
    }
  } finally { await app.close(); }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
