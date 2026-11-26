// End-to-end UI check against the real app: needs network (inspects and downloads a 5 s clip).
const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

(async () => {
  const artifacts = path.resolve(__dirname, '../artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: path.join(artifacts, name) });
  const app = await _electron.launch({
    args: [path.resolve(__dirname, '..')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SIMPLETUBE_NO_CLIPBOARD: '1', SIMPLETUBE_TEST_PROFILE: path.join(artifacts, 'test-profile') },
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('14px Montserrat')), true);

    // Empty screen: headline, no clip controls, Download disabled, glow follows the cursor.
    assert.equal(await page.locator('#headline').innerText(), 'Download for Yourself');
    assert.equal(await page.locator('#download').isDisabled(), true);
    assert.equal(await page.locator('#start').isVisible(), false);
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, height: innerHeight }));
    assert.ok(size.scroll <= size.height, JSON.stringify(size));
    await page.mouse.move(330, 420, { steps: 12 });
    await page.waitForTimeout(1800);
    await shot(page, '01-empty.png');
    console.log('refraction active:', await page.locator('#panel').evaluate(p => p.classList.contains('refract')));

    // Error goes to the reserved slot.
    await page.locator('#url').fill('https://example.com/video');
    await page.locator('#url').press('Enter');
    await page.waitForFunction(() => document.querySelector('#error').textContent.length > 0);
    console.log('error shown:', await page.locator('#error').innerText());

    // Load a real video.
    await page.locator('#url').fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await page.locator('#url').press('Enter');
    await page.waitForFunction(() => !document.querySelector('#download').disabled, {}, { timeout: 100000 });
    await page.waitForTimeout(1500);
    await shot(page, '02-ready.png');
    assert.match(await page.locator('#rangeSummary').innerText(), /^Full video · 00:19$/);
    assert.equal(await page.locator('#error').innerText(), '');

    // Clip range via inputs; invalid ranges block Download.
    await page.locator('#end').fill('00:00:01');
    await page.locator('#start').fill('00:00:03');
    assert.equal(await page.locator('#download').isDisabled(), true);
    await page.locator('#end').fill('00:00:08');
    assert.match(await page.locator('#rangeSummary').innerText(), /^Clip · 00:05 of 00:19$/);
    assert.equal(await page.locator('#resetRange').isVisible(), true);
    // Grabbed thumb at the very start must not be clipped by the panel section.
    await page.locator('#resetRange').click();
    const thumb = await page.locator('#thumbStart').boundingBox();
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(artifacts, '06-drag.png'), clip: { x: 0, y: thumb.y - 40, width: 200, height: 90 } });
    await page.mouse.up();
    await page.locator('#start').fill('00:00:03');
    await page.locator('#end').fill('00:00:08');

    // Real download.
    const folder = path.join(artifacts, 'ui-downloads');
    await fs.rm(folder, { recursive: true, force: true });
    await fs.mkdir(folder, { recursive: true });
    await page.locator('#folder').fill(folder);
    await page.locator('#download').click();
    await page.waitForFunction(() => document.querySelector('#download').innerText === 'Open in folder', {}, { timeout: 120000 });
    await page.waitForTimeout(600);
    await shot(page, '04-complete.png');
    assert.equal((await fs.readdir(folder)).length, 1);
    await page.locator('[data-mode="audio"]').click();
    assert.equal(await page.locator('#download').innerText(), 'Download');
    assert.equal(await page.locator('#ring').isVisible(), false);

    // Deterministic progress state, then cancel.
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      let finish;
      ipcMain.removeHandler('download'); ipcMain.removeHandler('cancel');
      ipcMain.handle('download', () => new Promise(resolve => {
        finish = resolve;
        BrowserWindow.getAllWindows()[0].webContents.send('progress', { stage: 'downloading', percent: 66 });
      }));
      ipcMain.handle('cancel', () => { finish?.({ ok: false, error: 'Cancelled' }); return { ok: true }; });
    });
    await page.locator('[data-mode="full"]').click();
    await page.locator('#download').click();
    await page.waitForFunction(() => document.querySelector('#percent').textContent === '66%');
    await page.mouse.move(10, 10);
    await page.waitForTimeout(600);
    await shot(page, '05-progress.png');
    assert.equal(await page.locator('#url').isDisabled(), true);
    await page.locator('#cancel').click();
    await page.waitForFunction(() => !document.querySelector('#download').disabled);
    assert.equal(await page.locator('#ring').isVisible(), false);
    assert.equal(await page.locator('#error').innerText(), '');

    // Hover state of the primary button.
    await page.locator('#download').hover();
    await page.waitForTimeout(500);
    await shot(page, '03-hover.png');

    assert.deepEqual(errors, []);
    console.log('UI, range validation, real download, progress and cancel: OK');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
