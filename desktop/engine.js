const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('Вставьте ссылку на видео YouTube.');
  let url;
  try { url = new URL(value.trim().includes('://') ? value.trim() : 'https://' + value.trim()); }
  catch { throw Error('Вставьте ссылку на видео YouTube.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw Error('Нужна ссылка на YouTube.');
  const host = url.hostname.toLowerCase();
  if (!(host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'))) throw Error('Поддерживаются ссылки YouTube.');
  const id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1];
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id || '')) throw Error('Нужна ссылка на одно видео, а не на канал или плейлист.');
  return `https://www.youtube.com/watch?v=${id}`;
}

function parseTime(text) {
  if (typeof text === 'number') { if (Number.isFinite(text) && text >= 0) return text; throw Error('Некорректное время.'); }
  if (typeof text !== 'string' || !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text.trim())) throw Error('Введите время в формате ЧЧ:ММ:СС или ММ:СС.');
  const parts = text.trim().split(':').map(Number);
  if (parts.slice(1).some(p => p > 59)) throw Error('Минуты и секунды должны быть от 00 до 59.');
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

function rangeFor(start, end, duration) {
  start = parseTime(start); end = parseTime(end);
  if (!Number.isFinite(duration) || duration <= 0) throw Error('У этого видео нет фиксированной длительности.');
  if (end <= start) throw Error('Конец фрагмента должен быть позже начала.');
  if (end > Math.ceil(duration)) throw Error('Конец фрагмента выходит за длительность видео.');
  end = Math.min(end, duration);
  return { start, end, partial: start > 0 || end < duration - 0.1 };
}

function commonArgs(tools) {
  return ['--ignore-config', '--no-playlist', '--no-color', '--encoding', 'utf-8', '--socket-timeout', '20', '--retries', '2',
    '--ffmpeg-location', tools, '--js-runtimes', 'node:' + path.join(tools, 'node.exe')];
}

function downloadArgs(tools, request) {
  const { url, folder, mode, range } = request;
  const formats = { full: 'bv+ba/b', video: 'bv', audio: 'ba' };
  if (!formats[mode]) throw Error('Выберите режим скачивания.');
  const suffix = range.partial ? `.${range.start}-${range.end}` : '';
  const args = [...commonArgs(tools), '--newline', '--no-simulate', '--windows-filenames', '--trim-filenames', '140', '--no-overwrites',
    '-f', formats[mode], '-P', folder, '-o', `%(title)s [%(id)s].${mode}${suffix}.%(ext)s`,
    '--progress-template', 'download:PROGRESS:%(progress)j', '--print', 'before_dl:PLAN:%(requested_formats)j', '--print', 'after_move:FILE:%(filepath)s'];
  if (mode === 'full') args.push('--merge-output-format', 'mkv', '--remux-video', 'mkv');
  if (mode === 'audio') args.push('-x', '--audio-format', 'best');
  if (range.partial) {
    args.push('--download-sections', `*${range.start}-${range.end}`, '--force-keyframes-at-cuts');
    // Exact video cuts: encode only the selected section, at visually high quality.
    if (mode !== 'audio') args.push('--downloader-args', 'ffmpeg_o:-c:v libx264 -preset fast -crf 18');
  }
  return [...args, '--', normalizeUrl(url)];
}

function run(exe, args, { onLine, signal, timeout = 0, maxOutput = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Отменено'));
    const child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', pendingOut = '', pendingErr = '', aborted = false, timedOut = false, tooLarge = false;
    const kill = () => {
      aborted = true;
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()).on('close', code => { if (code && child.exitCode === null) child.kill(); });
        else child.kill('SIGKILL');
      }
    };
    const timer = timeout ? setTimeout(() => { timedOut = true; kill(); }, timeout) : null;
    signal?.addEventListener('abort', kill, { once: true });
    const consume = (chunk, stderr) => {
      if (stderr) errors = (errors + chunk).slice(-18000);
      else if (!onLine) { output += chunk; if (output.length > maxOutput) { tooLarge = true; kill(); } }
      let text = (stderr ? pendingErr : pendingOut) + chunk;
      const lines = text.split(/[\r\n]+/);
      if (stderr) pendingErr = lines.pop(); else pendingOut = lines.pop();
      for (const line of lines) if (line) onLine?.(line);
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => consume(c, false)); child.stderr.on('data', c => consume(c, true));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (pendingOut) onLine?.(pendingOut); if (pendingErr) onLine?.(pendingErr);
      if (timedOut) reject(Error('Сервер долго не отвечает. Попробуйте ещё раз.'));
      else if (tooLarge) reject(Error('Ответ сервера слишком большой.'));
      else if (aborted) reject(Error('Отменено'));
      else if (code !== 0) reject(Error(errors.match(/ERROR:([^\r\n]+)/)?.[1]?.trim() || errors.slice(-1000) || `Процесс завершился с кодом ${code}`));
      else resolve(output);
    });
  });
}

function previewFormats(info) {
  const formats = (info.formats || []).filter(f => f.url?.startsWith('https://') && f.protocol === 'https' && !f.has_drm);
  const hasVideo = f => f.vcodec && f.vcodec !== 'none';
  const hasAudio = f => f.acodec && f.acodec !== 'none';
  const rank = f => (f.height <= 720 ? 10000 : 0) + (/^avc/.test(f.vcodec) ? 2000 : 0) + (f.height <= 480 ? 1000 : 0) + (f.height || 0);
  const combined = formats.filter(f => hasVideo(f) && hasAudio(f) && f.ext === 'mp4').sort((a,b) => rank(b)-rank(a))[0];
  if (combined) return { video: combined.url, audio: null };
  const video = formats.filter(f => hasVideo(f) && !hasAudio(f) && ['mp4', 'webm'].includes(f.ext)).sort((a,b) => rank(b)-rank(a))[0];
  const audio = formats.filter(f => hasAudio(f) && !hasVideo(f)).sort((a,b) => (b.ext === 'm4a') - (a.ext === 'm4a') || (b.abr || 0)-(a.abr || 0))[0];
  return { video: video?.url || null, audio: audio?.url || null };
}

class Engine {
  constructor(tools) { this.tools = tools; }
  async inspect(url, signal) {
    const raw = await run(path.join(this.tools, 'yt-dlp.exe'), [...commonArgs(this.tools), '--skip-download', '-J', '--', normalizeUrl(url)], { signal, timeout: 90000 });
    const info = JSON.parse(raw);
    if (info.is_live || !info.duration) throw Error('Дождитесь завершения прямого эфира.');
    return { url: normalizeUrl(url), title: info.title, duration: info.duration, id: info.id,
      thumbnail: info.thumbnail, uploader: info.uploader, preview: previewFormats(info) };
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
          const percent = Math.min(95, 95 * [...files.values()].reduce((a,b)=>a+b,0) / tracks);
          lastPercent = Math.max(lastPercent, percent);
          onEvent({ stage: 'downloading', percent: lastPercent, speed: p.speed || null, eta: p.eta || null });
        } catch {}
      } else if (/\[(Merger|VideoRemuxer|ExtractAudio)\]/.test(line)) onEvent({ stage: 'processing', percent: Math.max(95, lastPercent) });
      else if (request.range.partial && /time=\s*\d+:\d+:/.test(line)) {
        const match = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line);
        const seconds = +match[1]*3600 + +match[2]*60 + +match[3];
        lastPercent = Math.max(lastPercent, Math.min(94, 94*seconds/(request.range.end-request.range.start)));
        onEvent({ stage: 'downloading', percent: lastPercent });
      }
    };
    await run(path.join(this.tools, 'yt-dlp.exe'), downloadArgs(this.tools, request), { onLine, signal });
    if (!finalFile || !(await fs.stat(finalFile)).size) throw Error('Готовый файл не найден.');
    onEvent({ stage: 'processing', percent: 98 });
    const probe = JSON.parse(await run(path.join(this.tools, 'ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', finalFile], { signal, timeout: 30000 }));
    const kinds = new Set(probe.streams.map(s => s.codec_type));
    if ((request.mode !== 'audio' && !kinds.has('video')) || (request.mode !== 'video' && !kinds.has('audio')) || (request.mode === 'video' && kinds.has('audio')) || (request.mode === 'audio' && kinds.has('video'))) throw Error('Дорожки в файле не соответствуют выбранному режиму.');
    if (request.range.partial && Math.abs(Number(probe.format.duration) - (request.range.end-request.range.start)) > 2) throw Error('Длительность скачанного фрагмента отличается от выбранной. Проверьте файл.');
    return { file: finalFile, duration: Number(probe.format.duration) };
  }
}

module.exports = { Engine, normalizeUrl, parseTime, rangeFor, commonArgs, downloadArgs, previewFormats, run };
