const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

const CANCELLED = 'Cancelled';

/** Accepts any single-video YouTube link and returns its canonical watch URL. */
function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('Paste a YouTube video link.');
  const text = value.trim();
  let url;
  try { url = new URL(text.includes('://') ? text : 'https://' + text); }
  catch { throw Error('Paste a YouTube video link.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw Error('This is not a YouTube link.');
  const host = url.hostname.toLowerCase();
  if (!(host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'))) throw Error('Only YouTube links are supported.');
  const id = host === 'youtu.be' ? url.pathname.slice(1)
    : url.pathname === '/watch' ? url.searchParams.get('v')
    : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1];
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id || '')) throw Error('Paste a link to a single video, not a channel or playlist.');
  return `https://www.youtube.com/watch?v=${id}`;
}

/** "MM:SS" or "HH:MM:SS" (hours up to 3 digits) → seconds. Numbers pass through. */
function parseTime(text) {
  if (typeof text === 'number') {
    if (Number.isFinite(text) && text >= 0) return text;
    throw Error('Invalid time.');
  }
  if (typeof text !== 'string' || !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text.trim())) throw Error('Use HH:MM:SS or MM:SS.');
  const parts = text.trim().split(':').map(Number);
  if (parts.slice(1).some(p => p > 59)) throw Error('Minutes and seconds go from 00 to 59.');
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

function rangeFor(start, end, duration) {
  start = parseTime(start); end = parseTime(end);
  if (!Number.isFinite(duration) || duration <= 0) throw Error('This video has no fixed length.');
  if (end <= start) throw Error('The end must be after the start.');
  if (end > Math.ceil(duration)) throw Error('The clip goes past the end of the video.');
  end = Math.min(end, duration);
  return { start, end, partial: start > 0 || end < duration - 0.1 };
}

// ---------- Sign-in for age-restricted videos ----------
// Videos are fetched anonymously. Only when YouTube demands a sign-in (18+ or a bot check)
// do we retry with the user's Firefox cookies; yt-dlp reads them locally and sends them to YouTube only.
const SIGN_IN_REQUIRED = /Sign in to confirm (your age|you.re not a bot)|age.restricted|inappropriate for some users/i;
const AGE_GATE = /confirm your age|age.restricted|inappropriate for some users/i;
const FIREFOX_MISSING = /firefox|cookies? database|could not find|no such file/i;

const MESSAGES = {
  age: 'This video is 18+. Sign in to YouTube in Firefox and confirm your age. SimpleTube works with Firefox only.',
  ageNoFirefox: 'This video is 18+ and needs a Firefox sign-in. Install Firefox, sign in to YouTube and confirm your age.',
  bot: 'YouTube wants to check you’re not a bot. Sign in to YouTube in Firefox and try again.',
};

/** Turns the error of a signed-in retry into a message the user can act on. */
function signInError(firstError, retryError) {
  const age = AGE_GATE.test(firstError.message);
  if (retryError.message === CANCELLED) return retryError;
  if (!SIGN_IN_REQUIRED.test(retryError.message) && FIREFOX_MISSING.test(retryError.message)) return Error(age ? MESSAGES.ageNoFirefox : MESSAGES.bot);
  return Error(age ? MESSAGES.age : MESSAGES.bot);
}

/** Runs `attempt(auth)` anonymously, then once more with Firefox sign-in if YouTube asked for it. */
async function withSignIn(attempt, auth = false) {
  try { return await attempt(auth); }
  catch (error) {
    if (auth || !SIGN_IN_REQUIRED.test(error.message)) throw error;
    try { return await attempt(true); }
    catch (retryError) { throw signInError(error, retryError); }
  }
}

// yt-dlp needs a JavaScript runtime to solve YouTube's player challenges. Instead of shipping a separate
// node.exe we hand it our own executable: Electron runs as plain Node when ELECTRON_RUN_AS_NODE=1
// (set for every child in run()), and under plain Node process.execPath already is node.
const JS_RUNTIME = process.execPath;

function commonArgs(tools, auth = false) {
  return ['--ignore-config', '--no-playlist', '--no-color', '--encoding', 'utf-8', '--socket-timeout', '20', '--retries', '2',
    '--ffmpeg-location', tools, '--js-runtimes', 'node:' + JS_RUNTIME,
    ...(auth ? ['--cookies-from-browser', 'firefox'] : [])];
}

function downloadArgs(tools, request) {
  const { url, folder, mode, range, auth } = request;
  const formats = { full: 'bv+ba/b', video: 'bv', audio: 'ba' };
  if (!formats[mode]) throw Error('Choose what to download.');
  const suffix = range.partial ? `.${range.start}-${range.end}` : '';
  const args = [...commonArgs(tools, auth), '--newline', '--no-simulate', '--windows-filenames', '--trim-filenames', '140', '--no-overwrites',
    '-f', formats[mode], '-P', folder, '-o', `%(title)s [%(id)s].${mode}${suffix}.%(ext)s`,
    // --print implies --quiet, which silently turns progress off; --progress turns it back on.
    '--progress', '--progress-template', 'download:PROGRESS:%(progress)j',
    '--print', 'before_dl:PLAN:%(requested_formats)j',
    '--print', 'after_move:FILE:%(filepath)s'];
  // --remux-video also covers the "b" fallback, where no merge happens.
  if (mode === 'full') args.push('--merge-output-format', 'mkv', '--remux-video', 'mkv');
  if (mode === 'audio') args.push('-x', '--audio-format', 'best');
  if (range.partial) {
    args.push('--download-sections', `*${range.start}-${range.end}`, '--force-keyframes-at-cuts');
    // Exact cuts need re-encoding the section. Video: x264 at visually lossless CRF 18.
    // Audio: Opus at 192 kbps — above YouTube's own ~130–160 kbps, so the cut sounds like the original.
    // (Copying audio isn't exact here: yt-dlp seeks before the input, so a copied stream starts early.)
    const video = mode === 'audio' ? '' : '-c:v libx264 -preset fast -crf 18 ';
    // yt-dlp runs ffmpeg with -loglevel quiet; -progress still reports "out_time=HH:MM:SS" lines on stderr,
    // which onLine() turns into clip progress.
    args.push('--downloader-args', `ffmpeg_o:${video}-c:a libopus -b:a 192k -progress pipe:2`);
  }
  return [...args, '--', normalizeUrl(url)];
}

/** Spawns a tool, streams its lines, and supports abort + timeout (kills the whole process tree on Windows). */
function run(exe, args, { onLine, signal, timeout = 0, maxOutput = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error(CANCELLED));
    const child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let output = '', errors = '', pendingOut = '', pendingErr = '';
    let aborted = false, timedOut = false, tooLarge = false;

    const kill = () => {
      aborted = true;
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .on('error', () => child.kill())
          .on('close', code => { if (code && child.exitCode === null) child.kill(); });
      } else child.kill('SIGKILL');
    };
    const timer = timeout ? setTimeout(() => { timedOut = true; kill(); }, timeout) : null;
    signal?.addEventListener('abort', kill, { once: true });

    const consume = (chunk, stderr) => {
      if (stderr) errors = (errors + chunk).slice(-18000);
      else if (!onLine) {
        output += chunk;
        if (output.length > maxOutput) { tooLarge = true; kill(); }
      }
      const lines = ((stderr ? pendingErr : pendingOut) + chunk).split(/[\r\n]+/);
      if (stderr) pendingErr = lines.pop(); else pendingOut = lines.pop();
      for (const line of lines) if (line) onLine?.(line);
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => consume(c, false));
    child.stderr.on('data', c => consume(c, true));

    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (pendingOut) onLine?.(pendingOut);
      if (pendingErr) onLine?.(pendingErr);
      if (timedOut) reject(Error('The server is taking too long. Try again.'));
      else if (tooLarge) reject(Error('The server response is too large.'));
      else if (aborted) reject(Error(CANCELLED));
      else if (code !== 0) reject(Error(errors.match(/ERROR:([^\r\n]+)/)?.[1]?.trim() || errors.slice(-1000) || `Process exited with code ${code}`));
      else resolve(output);
    });
  });
}

class Engine {
  constructor(tools) { this.tools = tools; }

  /** Returns video info; `auth: true` means it only opened with the Firefox sign-in, and the download must use it too. */
  async inspect(url, signal) {
    const { info, auth } = await withSignIn(async auth => {
      const raw = await run(path.join(this.tools, 'yt-dlp.exe'),
        [...commonArgs(this.tools, auth), '--skip-download', '-J', '--', normalizeUrl(url)], { signal, timeout: 90000 });
      return { info: JSON.parse(raw), auth };
    });
    if (info.is_live) throw Error('Wait until the live stream ends.');
    if (!info.duration) throw Error('This video has no fixed length.');
    return { url: normalizeUrl(url), title: info.title, duration: info.duration, id: info.id, thumbnail: info.thumbnail, uploader: info.uploader, auth };
  }

  async download(request, onEvent, signal) {
    let finalFile = null, tracks = 1, lastPercent = 0;
    const files = new Map();
    onEvent({ stage: 'preparing', percent: 0 });
    const onLine = line => {
      if (line.startsWith('PLAN:')) { try { tracks = JSON.parse(line.slice(5))?.length || 1; } catch {} }
      else if (line.startsWith('FILE:')) finalFile = line.slice(5);
      else if (line.startsWith('PROGRESS:')) {
        try {
          const p = JSON.parse(line.slice(9));
          const total = p.total_bytes || p.total_bytes_estimate;
          const progress = p.status === 'finished' ? 1 : total ? Math.min(1, p.downloaded_bytes / total) : 0;
          files.set(p.filename || 'download', progress);
          // Tracks download one after another: average them, keep the last 5% for merging and checks.
          const percent = Math.min(95, 95 * [...files.values()].reduce((a, b) => a + b, 0) / tracks);
          lastPercent = Math.max(lastPercent, percent);
          onEvent({ stage: 'downloading', percent: lastPercent });
        } catch {}
      } else if (/\[(Merger|VideoRemuxer|ExtractAudio)\]/.test(line)) {
        onEvent({ stage: 'processing', percent: Math.max(95, lastPercent) });
      } else if (request.range.partial) {
        // Clips are fetched by ffmpeg, which reports encoded time instead of bytes.
        const match = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line);
        if (!match) return;
        const seconds = +match[1] * 3600 + +match[2] * 60 + +match[3];
        lastPercent = Math.max(lastPercent, Math.min(94, 94 * seconds / (request.range.end - request.range.start)));
        onEvent({ stage: 'downloading', percent: lastPercent });
      }
    };
    await withSignIn(auth => run(path.join(this.tools, 'yt-dlp.exe'), downloadArgs(this.tools, { ...request, auth }), { onLine, signal }), Boolean(request.auth));
    if (!finalFile || !(await fs.stat(finalFile)).size) throw Error('The finished file was not found.');

    onEvent({ stage: 'processing', percent: 98 });
    const probe = JSON.parse(await run(path.join(this.tools, 'ffprobe.exe'),
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', finalFile], { signal, timeout: 30000 }));
    const kinds = new Set(probe.streams.map(s => s.codec_type));
    const wantVideo = request.mode !== 'audio', wantAudio = request.mode !== 'video';
    if (kinds.has('video') !== wantVideo || kinds.has('audio') !== wantAudio) throw Error('The file tracks do not match the chosen mode.');
    if (request.range.partial && Math.abs(Number(probe.format.duration) - (request.range.end - request.range.start)) > 2) {
      throw Error('The clip length differs from the selected range. Check the file.');
    }
    return { file: finalFile, duration: Number(probe.format.duration) };
  }
}

module.exports = { Engine, CANCELLED, MESSAGES, withSignIn, normalizeUrl, parseTime, rangeFor, commonArgs, downloadArgs, run };
