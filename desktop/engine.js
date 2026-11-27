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
  // yt-dlp saves an intermediate "….source.<ext>" file; makeEditFriendly() turns it into the final .mp4 / .wav.
  const args = [...commonArgs(tools, auth), '--newline', '--no-simulate', '--windows-filenames', '--trim-filenames', '140', '--no-overwrites',
    '-f', formats[mode], '-P', folder, '-o', `%(title)s [%(id)s].${mode}${suffix}.source.%(ext)s`,
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
    // Audio: AAC 256 kbps next to video (goes straight into the MP4); for audio-only clips the WebM
    // intermediate only takes Opus, so Opus 192 kbps, later decoded to WAV. Both are above YouTube's own bitrate.
    // (Copying audio isn't exact here: yt-dlp seeks before the input, so a copied stream starts early.)
    const codecs = mode === 'audio' ? '-c:a libopus -b:a 192k' : '-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 256k';
    // yt-dlp runs ffmpeg with -loglevel quiet; -progress still reports "out_time=HH:MM:SS" lines on stderr,
    // which onLine() turns into clip progress.
    args.push('--downloader-args', `ffmpeg_o:${codecs} -progress pipe:2`);
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

// ---------- Editing-friendly output ----------
// YouTube's best streams are AV1/VP9 + Opus, which editors such as DaVinci Resolve can't open.
// Every download therefore ends as MP4 (H.264 + AAC) or WAV. H.264/AAC sources are copied as is;
// anything else is re-encoded at visually lossless quality, on the GPU when one is available
// (NVENC cq 23 measured equal to x264 CRF 18 on 4K: SSIM 0.9957 vs 0.9958, ~29 Mbit/s).
const OUTPUT = { full: 'mp4', video: 'mp4', audio: 'wav' };
const H264 = {
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-spatial-aq', '1'],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-qp_b', '24'],
  h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'slower', '-global_quality', '20'],
  libx264: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18'],
};

/** "name.full.source.mkv" → "name.full.mp4", adding " (2)", " (3)"… if that file already exists. */
async function finalPath(source, ext) {
  const base = source.replace(/\.source\.[^.\\/]+$/, '');
  for (let n = 1; ; n++) {
    const candidate = `${base}${n > 1 ? ` (${n})` : ''}.${ext}`;
    if (!(await fs.stat(candidate).catch(() => null))) return candidate;
  }
}

class Engine {
  constructor(tools) { this.tools = tools; }

  /** First hardware H.264 encoder that actually works on this machine, else libx264. Checked once. */
  h264Encoder() {
    this.encoder ??= (async () => {
      for (const name of ['h264_nvenc', 'h264_amf', 'h264_qsv']) {
        try {
          await run(path.join(this.tools, 'ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=1280x720:d=0.2',
            ...H264[name], '-f', 'null', '-'], { timeout: 15000 });
          return name;
        } catch {}
      }
      return 'libx264';
    })();
    return this.encoder;
  }

  async probe(file, signal) {
    return JSON.parse(await run(path.join(this.tools, 'ffprobe.exe'),
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeout: 30000 }));
  }

  /** Converts yt-dlp's intermediate file to MP4 (H.264 + AAC) or WAV; reports 0…1 through onFraction. */
  async makeEditFriendly(source, mode, onFraction, signal) {
    const info = await this.probe(source, signal);
    const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
    const duration = Number(info.format.duration) || 0;
    const target = await finalPath(source, OUTPUT[mode]);
    const audioArgs = mode === 'audio' ? ['-c:a', 'pcm_s16le']
      : audio?.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k'];
    const maps = mode === 'audio' ? ['-map', '0:a:0', '-vn'] : mode === 'video' ? ['-map', '0:v:0', '-an'] : ['-map', '0:v:0', '-map', '0:a:0'];

    const encode = async encoder => {
      const videoArgs = mode === 'audio' ? []
        : video?.codec_name === 'h264' ? ['-c:v', 'copy'] : [...H264[encoder], '-pix_fmt', 'yuv420p'];
      const args = ['-v', 'error', '-n', '-i', source, ...maps, ...videoArgs, ...(mode === 'video' ? [] : audioArgs),
        ...(OUTPUT[mode] === 'mp4' ? ['-movflags', '+faststart'] : []), '-progress', 'pipe:1', '-nostats', target];
      await run(path.join(this.tools, 'ffmpeg.exe'), args, {
        signal,
        onLine: line => {
          const us = /^out_time_us=(\d+)/.exec(line);
          if (us && duration) onFraction(Math.min(1, Number(us[1]) / 1e6 / duration));
        },
      });
    };
    const removeTarget = () => fs.rm(target, { force: true });
    try {
      const encoder = mode === 'audio' || video?.codec_name === 'h264' ? 'libx264' : await this.h264Encoder();
      try { await encode(encoder); }
      catch (error) {
        // A GPU encoder can still refuse a particular video (size, format): redo it on the CPU.
        if (error.message === CANCELLED || encoder === 'libx264') throw error;
        await removeTarget();
        await encode('libx264');
      }
    } catch (error) {
      await removeTarget();
      await fs.rm(source, { force: true });
      throw error;
    }
    await fs.rm(source, { force: true });
    return target;
  }

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
    // Share of the ring for the download itself; the rest is conversion. Whole videos may need a long
    // re-encode (AV1/VP9 → H.264), clips and audio convert quickly.
    const share = request.mode !== 'audio' && !request.range.partial ? 60 : 90;
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
          // Tracks download one after another: average them.
          const percent = Math.min(share, share * [...files.values()].reduce((a, b) => a + b, 0) / tracks);
          lastPercent = Math.max(lastPercent, percent);
          onEvent({ stage: 'downloading', percent: lastPercent });
        } catch {}
      } else if (/\[(Merger|VideoRemuxer|ExtractAudio)\]/.test(line)) {
        lastPercent = Math.max(share, lastPercent);
        onEvent({ stage: 'processing', percent: lastPercent });
      } else if (request.range.partial) {
        // Clips are fetched by ffmpeg, which reports encoded time instead of bytes.
        const match = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line);
        if (!match) return;
        const seconds = +match[1] * 3600 + +match[2] * 60 + +match[3];
        lastPercent = Math.max(lastPercent, Math.min(share, share * seconds / (request.range.end - request.range.start)));
        onEvent({ stage: 'downloading', percent: lastPercent });
      }
    };
    await withSignIn(auth => run(path.join(this.tools, 'yt-dlp.exe'), downloadArgs(this.tools, { ...request, auth }), { onLine, signal }), Boolean(request.auth));
    if (!finalFile || !(await fs.stat(finalFile)).size) throw Error('The finished file was not found.');

    onEvent({ stage: 'processing', percent: lastPercent });
    finalFile = await this.makeEditFriendly(finalFile, request.mode, fraction => {
      lastPercent = Math.max(lastPercent, share + (98 - share) * fraction);
      onEvent({ stage: 'processing', percent: lastPercent });
    }, signal);

    onEvent({ stage: 'processing', percent: 98 });
    const probe = await this.probe(finalFile, signal);
    const kinds = new Set(probe.streams.map(s => s.codec_type));
    const wantVideo = request.mode !== 'audio', wantAudio = request.mode !== 'video';
    if (kinds.has('video') !== wantVideo || kinds.has('audio') !== wantAudio) throw Error('The file tracks do not match the chosen mode.');
    const codecs = probe.streams.map(s => s.codec_name);
    if (codecs.some(c => !['h264', 'aac', 'pcm_s16le'].includes(c))) throw Error(`Unexpected codec in the finished file: ${codecs.join(', ')}`);
    if (request.range.partial && Math.abs(Number(probe.format.duration) - (request.range.end - request.range.start)) > 2) {
      throw Error('The clip length differs from the selected range. Check the file.');
    }
    return { file: finalFile, duration: Number(probe.format.duration) };
  }
}

module.exports = { Engine, CANCELLED, MESSAGES, withSignIn, normalizeUrl, parseTime, rangeFor, commonArgs, downloadArgs, run };
