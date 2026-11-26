const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, session, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Engine, CANCELLED, normalizeUrl, rangeFor } = require('./engine');

let win, engine, metadata, inspectController, downloadController, finalFile, settings = {}, generation = 0;
const uiFile = path.join(__dirname, 'ui', 'index.html');
if (!app.isPackaged && process.env.SIMPLETUBE_TEST_PROFILE) app.setPath('userData', path.resolve(process.env.SIMPLETUBE_TEST_PROFILE));
function register(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('Unauthorized');
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
const cancelAll = () => { inspectController?.abort(); downloadController?.abort(); };

app.whenReady().then(async () => {
  const configFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch {}
  const tools = app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.resolve(__dirname, '..', 'tools');
  engine = new Engine(tools);
  const work = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({ width: 480, height: Math.min(660, work.height), frame: false, transparent: true,
    resizable: false, maximizable: false, fullscreenable: false, show: false, title: 'SimpleTube',
    backgroundColor: '#00000000', autoHideMenuBar: true, icon: path.join(__dirname, 'ui', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('closed', () => { cancelAll(); app.quit(); });
  win.once('ready-to-show', () => win.show());
  register('settings', () => ({ folder: settings.folder || app.getPath('downloads') }));
  // Tests set SIMPLETUBE_NO_CLIPBOARD so the developer's real clipboard never leaks into a run.
  register('paste', () => (!app.isPackaged && process.env.SIMPLETUBE_NO_CLIPBOARD ? '' : clipboard.readText()));
  register('folder', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Save to', defaultPath: settings.folder || app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  register('inspect', async url => {
    if (downloadController) throw Error('Wait for the download to finish.');
    const normalized = normalizeUrl(url);
    inspectController?.abort(); metadata = null; finalFile = null;
    const current = ++generation, controller = new AbortController(); inspectController = controller;
    try {
      const info = await engine.inspect(normalized, controller.signal);
      if (current !== generation) throw Error(CANCELLED);
      metadata = info;
      // Only image data is passed to the UI; no page HTML from YouTube is executed.
      let thumbnail = null;
      try {
        const imageUrl = new URL(info.thumbnail);
        if (imageUrl.protocol === 'https:' && /(^|\.)ytimg\.com$/.test(imageUrl.hostname)) {
          const response = await fetch(imageUrl, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
          const type = response.headers.get('content-type')?.split(';')[0].trim();
          if (response.ok && /^image\/(jpeg|png|webp)$/.test(type)) {
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length < 5e6) thumbnail = `data:${type};base64,` + bytes.toString('base64');
          }
        }
      } catch {}
      if (current !== generation) throw Error(CANCELLED);
      return { ...info, thumbnail };
    } finally { if (inspectController === controller) inspectController = null; }
  });
  register('invalidate', () => { if (!downloadController) { ++generation; inspectController?.abort(); metadata = null; finalFile = null; } });
  register('download', async request => {
    if (downloadController) throw Error('A download is already running.');
    if (!metadata || normalizeUrl(request.url) !== metadata.url) throw Error('Paste a YouTube link first.');
    const range = rangeFor(request.start, request.end, metadata.duration);
    if (!['full','video','audio'].includes(request.mode)) throw Error('Choose what to download.');
    if (typeof request.folder !== 'string' || !request.folder.trim() || !path.isAbsolute(request.folder)) throw Error('Choose a folder to save to.');
    const folder = path.resolve(request.folder);
    const stat = await fs.stat(folder).catch(() => null);
    if (!stat?.isDirectory()) throw Error('Folder not found. Choose an existing folder.');
    const testFile = path.join(folder, '.simpletube-write-' + require('node:crypto').randomUUID());
    const handle = await fs.open(testFile, 'wx'); await handle.close(); await fs.unlink(testFile);
    settings.folder = folder;
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify(settings));
    const controller = new AbortController(); downloadController = controller; finalFile = null;
    try {
      const result = await engine.download({ ...request, folder, range, url: metadata.url, auth: Boolean(metadata.auth) },data => { if (!win.isDestroyed()) win.webContents.send('progress', data); }, controller.signal);
      finalFile = result.file;
      return result;
    } finally { if (downloadController === controller) downloadController = null; }
  });
  register('cancel', () => { cancelAll(); });
  register('reveal', async () => { if (finalFile) { await fs.access(finalFile); shell.showItemInFolder(finalFile); } });
  register('minimize', () => win.minimize());
  register('close', () => win.close());
  await win.loadFile(uiFile);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', cancelAll);
