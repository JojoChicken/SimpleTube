const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, parseTime, rangeFor, downloadArgs, run, CANCELLED } = require('../engine');

test('YouTube links normalize to one video; spoofed hosts and playlists rejected', () => {
  for (const link of ['youtu.be/jNQXAC9IVRw', 'https://www.youtube.com/shorts/jNQXAC9IVRw', 'https://youtube.com/watch?v=jNQXAC9IVRw&list=playlist'])
    assert.equal(normalizeUrl(link), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  for (const link of ['https://youtube.com.evil.com/watch?v=jNQXAC9IVRw', 'file:///a', 'https://youtube.com/playlist?list=a', 'https://u:p@youtube.com/watch?v=jNQXAC9IVRw', 'hello'])
    assert.throws(() => normalizeUrl(link));
});

test('Minute and hour timing are unambiguous; invalid and reversed ranges rejected', () => {
  assert.equal(parseTime('02:30'), 150);
  assert.equal(parseTime('02:30:00'), 9000);
  assert.deepEqual(rangeFor('00:02:30', '00:02:45', 14400), { start: 150, end: 165, partial: true });
  assert.equal(rangeFor(0, 20, 19.6).partial, false);
  for (const args of [[0, 0, 20], [10, 5, 20], [0, 22, 20], [-1, 5, 20], ['00:70', 80, 100]]) assert.throws(() => rangeFor(...args));
});

test('Partial commands preserve mode, contain timestamps and exact-cut encoder; full copy unchanged', () => {
  const request = { url: 'https://youtu.be/jNQXAC9IVRw', folder: 'C:\\Folder with spaces', mode: 'full', range: rangeFor(2, 5, 20) };
  const args = downloadArgs('C:\\tools', request);
  assert.equal(args[args.indexOf('--download-sections') + 1], '*2-5');
  assert.ok(args.includes('--force-keyframes-at-cuts'));
  assert.ok(args.includes('ffmpeg_o:-c:v libx264 -preset fast -crf 18'));
  assert.ok(args.includes('C:\\Folder with spaces'));
  assert.equal(args.at(-2), '--');
  const full = downloadArgs('tools', { ...request, range: rangeFor(0, 20, 20) });
  assert.ok(!full.includes('--download-sections'));
  for (const [mode, format] of [['audio', 'ba'], ['video', 'bv']]) {
    const cmd = downloadArgs('tools', { ...request, mode });
    assert.equal(cmd[cmd.indexOf('-f') + 1], format);
  }
});

test('Cancelled child jobs cannot report success', async () => {
  const controller = new AbortController();
  const promise = run(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, new RegExp(CANCELLED));
});
