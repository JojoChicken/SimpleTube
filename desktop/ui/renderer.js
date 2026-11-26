'use strict';
const $ = id => document.getElementById(id);
const api = window.tube;
const CANCELLED = 'Cancelled';
const shell = $('shell');

/**
 * phase: 'empty'       — no video loaded
 *        'inspecting'  — fetching title / cover / duration
 *        'ready'       — video loaded, waiting for Download
 *        'downloading' — download in progress
 *        'done'        — file saved; Download turns into "Open in folder"
 */
const state = { phase: 'empty', info: null, mode: 'full', revision: 0, lastAutoLink: null };

// ---------- helpers ----------
async function call(method, ...args) {
  const result = await api[method](...args);
  if (!result.ok) throw Error(result.error);
  return result.value;
}
const pad = n => String(n).padStart(2, '0');
const fmt = s => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s) % 60].map(pad).join(':');
const shortTime = s => (s >= 3600 ? fmt(s) : fmt(s).slice(3));
function parseTime(text) {
  text = text.trim();
  if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) throw Error('Use HH:MM:SS, for example 00:02:30.');
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some(v => v > 59)) throw Error('Minutes and seconds go from 00 to 59.');
  return parts.reduce((sum, v) => sum * 60 + v, 0);
}
const looksLikeYouTube = text => /^\s*(https?:\/\/)?([\w-]+\.)*(youtube\.com|youtu\.be)\/\S+\s*$/i.test(text || '');

function showError(message) {
  $('error').textContent = message || '';
  $('errorSlot').classList.toggle('shown', Boolean(message));
}
const busy = () => state.phase === 'downloading';

// ---------- rendering ----------
function render() {
  const { phase } = state, hasVideo = Boolean(state.info);
  shell.classList.toggle('has-video', hasVideo);
  shell.classList.toggle('downloading', phase === 'downloading');
  for (const id of ['url', 'folder', 'paste', 'chooseFolder', 'start', 'end', 'resetRange']) $(id).disabled = busy();
  for (const thumb of [$('thumbStart'), $('thumbEnd')]) thumb.disabled = busy();
  document.querySelectorAll('.mode').forEach(b => { b.disabled = busy(); });
  $('cancel').disabled = !(phase === 'inspecting' || phase === 'downloading');

  const download = $('download');
  download.classList.toggle('working', phase === 'downloading');
  download.querySelector('span').textContent = phase === 'downloading' ? 'Downloading' : phase === 'done' ? 'Open in folder' : 'Download';
  download.querySelector('use').setAttribute('href', phase === 'done' ? '#i-folder' : '#i-download');
  download.disabled = phase === 'empty' || phase === 'inspecting' || phase === 'downloading' || (phase === 'ready' && !rangeOrNull());

  $('ring').hidden = !(phase === 'downloading' || phase === 'done');
  $('ring').classList.toggle('done', phase === 'done');
}

function setProgress(percent) {
  const p = Math.max(0, Math.min(100, percent));
  $('ring').style.setProperty('--p', p);
  $('ring').setAttribute('aria-valuenow', Math.floor(p));
  $('percent').textContent = Math.floor(p) + '%';
}

// Any change to what will be downloaded resets a finished download back to "ready".
function invalidateDone() {
  if (state.phase === 'done') { state.phase = 'ready'; render(); }
}

// ---------- video ----------
function clearVideo() {
  state.info = null;
  $('coverImage').removeAttribute('src');
  $('videoTitle').textContent = '';
  $('videoTitle').title = '';
  if (state.phase !== 'inspecting') state.phase = 'empty';
}

function showVideo(info) {
  state.info = info;
  if (info.thumbnail) $('coverImage').src = info.thumbnail;
  $('videoTitle').textContent = info.title;
  $('videoTitle').title = info.title;
  $('start').value = fmt(0);
  $('end').value = fmt(Math.ceil(info.duration));
  state.phase = 'ready';
  updateRange();
}

async function inspectLink() {
  clearTimeout(inspectLink.timer);
  const url = $('url').value.trim();
  if (!url || busy()) return;
  const token = ++state.revision;
  clearVideo();
  state.phase = 'inspecting';
  showError('');
  render();
  try {
    const info = await call('inspect', url);
    if (token !== state.revision) return;
    showVideo(info);
  } catch (error) {
    if (token !== state.revision) return;
    state.phase = 'empty';
    showError(error.message === CANCELLED ? '' : error.message);
  }
  render();
}

function setLink(text) {
  $('url').value = text.trim();
  $('url').title = $('url').value;
  inspectLink();
}

// ---------- clip range ----------
function rangeOrNull() {
  try { return readRange(); } catch { return null; }
}
function readRange() {
  const { info } = state;
  if (!info) throw Error('Paste a YouTube link first.');
  const start = parseTime($('start').value), end = parseTime($('end').value);
  if (end <= start) throw Error('The end must be after the start.');
  if (end > Math.ceil(info.duration)) throw Error('The clip goes past the end of the video.');
  return { start, end: Math.min(end, info.duration), partial: start > 0 || end < info.duration - 0.1 };
}

function placeThumbs(start, end) {
  const total = Math.ceil(state.info.duration);
  const a = Math.max(0, Math.min(100, (start / total) * 100)), b = Math.max(0, Math.min(100, (end / total) * 100));
  $('range').style.setProperty('--a', a + '%');
  $('range').style.setProperty('--b', b + '%');
  $('thumbStart').setAttribute('aria-valuetext', shortTime(start));
  $('thumbEnd').setAttribute('aria-valuetext', shortTime(end));
}

function updateRange() {
  invalidateDone();
  const startField = $('start').parentElement, endField = $('end').parentElement;
  startField.classList.remove('invalid');
  endField.classList.remove('invalid');
  try {
    const r = readRange();
    placeThumbs(r.start, r.end);
    const total = shortTime(state.info.duration);
    $('rangeSummary').textContent = r.partial ? `Clip · ${shortTime(r.end - r.start)} of ${total}` : `Full video · ${total}`;
    $('resetRange').hidden = !r.partial;
    showError('');
  } catch (error) {
    (/end|past/i.test(error.message) ? endField : document.activeElement === $('start') ? startField : endField).classList.add('invalid');
    showError(error.message);
  }
  render();
}

for (const id of ['start', 'end']) {
  $(id).addEventListener('input', updateRange);
  $(id).addEventListener('blur', () => { try { $(id).value = fmt(parseTime($(id).value)); } catch {} });
}
$('resetRange').onclick = () => {
  if (!state.info) return;
  $('start').value = fmt(0);
  $('end').value = fmt(Math.ceil(state.info.duration));
  updateRange();
};

// Two-thumb slider: drag either thumb, or click the track to move the nearest one.
(function setupSlider() {
  const track = $('range');
  let active = null;
  const secondsAt = clientX => {
    const box = track.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * Math.ceil(state.info.duration));
  };
  const current = () => ({ start: parseTime($('start').value), end: parseTime($('end').value) });
  function move(thumb, seconds) {
    const { start, end } = current();
    if (thumb === $('thumbStart')) $('start').value = fmt(Math.min(seconds, end - 1));
    else $('end').value = fmt(Math.max(seconds, start + 1));
    updateRange();
  }
  track.addEventListener('pointerdown', event => {
    if (busy() || !state.info || !rangeOrNull()) return;
    const seconds = secondsAt(event.clientX), { start, end } = current();
    active = event.target.classList.contains('range-thumb') ? event.target
      : Math.abs(seconds - start) <= Math.abs(seconds - end) ? $('thumbStart') : $('thumbEnd');
    active.classList.add('dragging');
    active.focus();
    track.setPointerCapture(event.pointerId);
    move(active, seconds);
  });
  track.addEventListener('pointermove', event => { if (active) move(active, secondsAt(event.clientX)); });
  const stop = () => { active?.classList.remove('dragging'); active = null; };
  track.addEventListener('pointerup', stop);
  track.addEventListener('pointercancel', stop);
  for (const thumb of [$('thumbStart'), $('thumbEnd')]) {
    thumb.addEventListener('keydown', event => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[event.key];
      if (!step || !rangeOrNull()) return;
      event.preventDefault();
      const value = thumb === $('thumbStart') ? current().start : current().end;
      move(thumb, Math.max(0, Math.min(Math.ceil(state.info.duration), value + step * (event.shiftKey ? 10 : 1))));
    });
  }
})();

// ---------- link + folder ----------
$('url').addEventListener('input', () => {
  ++state.revision;
  call('invalidate').catch(() => {});
  clearVideo();
  state.phase = 'empty';
  showError('');
  render();
  clearTimeout(inspectLink.timer);
  if ($('url').value.trim()) inspectLink.timer = setTimeout(inspectLink, 700);
});
$('url').addEventListener('keydown', event => { if (event.key === 'Enter') inspectLink(); });
$('paste').onclick = async () => {
  try { setLink(await call('paste')); } catch (error) { showError(error.message); }
};
$('chooseFolder').onclick = async () => {
  try {
    const folder = await call('folder');
    if (folder) { $('folder').value = folder; $('folder').title = folder; invalidateDone(); }
  } catch (error) { showError(error.message); }
};
$('folder').addEventListener('input', () => { $('folder').title = $('folder').value; invalidateDone(); });

// Picks up a freshly copied YouTube link whenever the window gains focus.
async function pickUpClipboard() {
  if (busy() || state.phase === 'inspecting') return;
  try {
    const text = (await call('paste')).trim();
    if (!looksLikeYouTube(text) || text === state.lastAutoLink || text === $('url').value.trim()) return;
    state.lastAutoLink = text;
    setLink(text);
  } catch {}
}
window.addEventListener('focus', pickUpClipboard);

// Drag a link from the browser straight onto the window.
shell.addEventListener('dragover', event => {
  if (busy()) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  shell.classList.add('dropping');
});
shell.addEventListener('dragleave', event => { if (!shell.contains(event.relatedTarget)) shell.classList.remove('dropping'); });
shell.addEventListener('drop', event => {
  event.preventDefault();
  shell.classList.remove('dropping');
  if (busy()) return;
  const text = event.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#'))
    || event.dataTransfer.getData('text/plain');
  if (text) setLink(text);
});

// ---------- modes ----------
function selectMode(button) {
  if (busy()) return;
  state.mode = button.dataset.mode;
  document.querySelectorAll('.mode').forEach(item => {
    const selected = item === button;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-checked', selected);
    item.tabIndex = selected ? 0 : -1;
  });
  invalidateDone();
}
document.querySelectorAll('.mode').forEach((button, index, all) => {
  button.onclick = () => selectMode(button);
  button.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next = all[(index + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    selectMode(next);
    next.focus();
  };
});

// ---------- download ----------
$('download').onclick = async () => {
  if (state.phase === 'done') {
    try { await call('reveal'); } catch (error) { showError(error.message); }
    return;
  }
  let range;
  try { range = readRange(); } catch (error) { showError(error.message); return; }
  state.phase = 'downloading';
  showError('');
  setProgress(0);
  render();
  try {
    await call('download', { url: $('url').value, folder: $('folder').value, mode: state.mode, start: range.start, end: range.end });
    setProgress(100);
    state.phase = 'done';
  } catch (error) {
    state.phase = state.info ? 'ready' : 'empty';
    showError(error.message === CANCELLED ? '' : error.message);
  }
  render();
};
api.onProgress(data => { if (busy()) setProgress(Math.min(99, Number(data.percent) || 0)); });

$('cancel').onclick = async () => {
  if (state.phase === 'inspecting') {
    ++state.revision;
    state.phase = 'empty';
    render();
  }
  $('cancel').disabled = true;
  try { await call('cancel'); } catch (error) { showError(error.message); }
};

$('minimize').onclick = () => call('minimize');
$('close').onclick = () => call('close');

// ---------- cursor glow (empty screen only) ----------
(function setupGlow() {
  const glow = $('glow');
  const target = { x: 228, y: 190 }, pos = { ...target };
  let frame = 0;
  const tick = () => {
    // Low easing factor = the light lags behind the cursor like a soft trail.
    pos.x += (target.x - pos.x) * 0.06;
    pos.y += (target.y - pos.y) * 0.06;
    glow.style.setProperty('--x', pos.x + 'px');
    glow.style.setProperty('--y', pos.y + 'px');
    frame = Math.abs(target.x - pos.x) + Math.abs(target.y - pos.y) > 0.5 ? requestAnimationFrame(tick) : 0;
  };
  shell.addEventListener('pointermove', event => {
    if (state.info) return;
    const box = shell.getBoundingClientRect();
    target.x = event.clientX - box.left;
    target.y = event.clientY - box.top;
    glow.style.setProperty('--glow-opacity', 1);
    if (!frame) frame = requestAnimationFrame(tick);
  });
  shell.addEventListener('pointerleave', () => glow.style.setProperty('--glow-opacity', 0));
})();

// ---------- liquid glass refraction ----------
// Builds a displacement map that bends the backdrop along the panel's rounded edge, like a glass bezel.
(function setupRefraction() {
  const panel = $('panel');
  if (!CSS.supports('backdrop-filter', 'url(#refract) blur(1px)')) return;
  const filter = $('refract'), map = $('refractMap');
  const BEZEL = 26, canvas = document.createElement('canvas');
  let pending = 0;
  function build() {
    pending = 0;
    const w = Math.round(panel.offsetWidth), h = Math.round(panel.offsetHeight);
    if (!w || !h) return;
    const radius = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(w, h), data = image.data;
    const hw = w / 2, hh = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5 - hw, py = y + 0.5 - hh;
        const qx = Math.abs(px) - hw + radius, qy = Math.abs(py) - hh + radius;
        // Signed distance to the rounded rectangle (negative inside) and its outward normal.
        let nx, ny, dist;
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy) || 1;
          dist = len - radius; nx = qx / len * Math.sign(px); ny = qy / len * Math.sign(py);
        } else if (qx > qy) { dist = qx - radius; nx = Math.sign(px); ny = 0; }
        else { dist = qy - radius; nx = 0; ny = Math.sign(py); }
        const depth = -dist, i = (y * w + x) * 4;
        let dx = 0, dy = 0;
        if (depth < BEZEL) {
          const t = 1 - Math.max(0, depth) / BEZEL, strength = t * t;
          dx = -nx * strength; dy = -ny * strength;
        }
        data[i] = 128 + dx * 127; data[i + 1] = 128 + dy * 127; data[i + 2] = 128; data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    for (const el of [filter, map]) { el.setAttribute('width', w); el.setAttribute('height', h); }
    filter.setAttribute('x', 0); filter.setAttribute('y', 0);
    map.setAttribute('href', canvas.toDataURL());
    panel.classList.add('refract');
  }
  new ResizeObserver(() => { if (!pending) pending = requestAnimationFrame(build); }).observe(panel);
})();

// ---------- start ----------
call('settings')
  .then(settings => { $('folder').value = settings.folder; $('folder').title = settings.folder; })
  .catch(error => showError(error.message));
render();
if (document.hasFocus()) pickUpClipboard();
