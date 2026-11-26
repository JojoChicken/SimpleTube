const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, parseTime, rangeFor, commonArgs, downloadArgs, withSignIn, MESSAGES, run, CANCELLED } = require('../engine');

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

test('Firefox sign-in is used only when YouTube asks for it, with clear messages', async () => {
  assert.ok(!commonArgs('t').includes('--cookies-from-browser'));
  const authArgs = commonArgs('t', true);
  assert.equal(authArgs[authArgs.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.ok(downloadArgs('t', { url: 'youtu.be/jNQXAC9IVRw', folder: 'C:\\x', mode: 'full', range: rangeFor(0, 20, 20), auth: true }).includes('--cookies-from-browser'));

  // Anonymous success: no retry.
  const calls = [];
  assert.equal(await withSignIn(async auth => { calls.push(auth); return 'ok'; }), 'ok');
  assert.deepEqual(calls, [false]);
  // Age gate: retried once with sign-in.
  const tries = [];
  const value = await withSignIn(async auth => { tries.push(auth); if (!auth) throw Error('Sign in to confirm your age. This video may be inappropriate'); return 'signed'; });
  assert.deepEqual([value, tries], ['signed', [false, true]]);
  // Still gated after sign-in → friendly 18+ message; Firefox missing → its own message.
  const ageGate = Error('Sign in to confirm your age.');
  await assert.rejects(withSignIn(async () => { throw ageGate; }), { message: MESSAGES.age });
  await assert.rejects(withSignIn(async auth => { throw auth ? Error('could not find firefox cookies database') : ageGate; }), { message: MESSAGES.ageNoFirefox });
  // Unrelated errors are not retried.
  const plain = [];
  await assert.rejects(withSignIn(async auth => { plain.push(auth); throw Error('Video unavailable'); }), /unavailable/);
  assert.deepEqual(plain, [false]);
});

test('Cancelled child jobs cannot report success', async () => {
  const controller = new AbortController();
  const promise = run(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, new RegExp(CANCELLED));
});
