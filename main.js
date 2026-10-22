const { app, BrowserWindow, globalShortcut, desktopCapturer, screen, session, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const ai = require('./ai');

const SELFTEST = process.argv.includes('--selftest');
const PROFILE_PATH = path.isAbsolute(cfg.profileFile) ? cfg.profileFile : path.join(__dirname, cfg.profileFile);
let win = null;

// separate cache dir: selftest must not clash with a running instance
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'aside-selftest'));

async function loadProfile() {
  try {
    ai.setProfile(await extractText(PROFILE_PATH));
  } catch {
    ai.setProfile(''); // no profile file yet
  }
}

async function extractText(file) {
  if (file.toLowerCase().endsWith('.pdf')) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(file) });
    try {
      const { text } = await parser.getText();
      return text.replace(/^-- \d+ of \d+ --$/gm, '').trim(); // drop pdf-parse page markers
    } finally {
      await parser.destroy();
    }
  }
  return fs.readFileSync(file, 'utf8');
}

// ---- screenshot: desktopCapturer thumbnail of the display the overlay is on (same method Cluely v2 uses) ----
async function captureScreenshot() {
  const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.bounds.width, height: display.bounds.height }
      });
      const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
      if (!src || src.thumbnail.isEmpty()) throw new Error('empty thumbnail');
      let img = src.thumbnail;
      if (img.getSize().width > cfg.screenshotMaxWidth) img = img.resize({ width: cfg.screenshotMaxWidth });
      return img.toPNG();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`screenshot failed: ${lastErr?.message}`);
}

// ---- wav: mono 16-bit PCM @ 16 kHz (what suggest() receives from the renderer) ----
function pcm16ToWav(pcm) {
  const rate = 16000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function setupIpc() {
  ipcMain.handle('get-config', () => ({
    intervalMs: cfg.intervalMs,
    hotkeyToggle: cfg.hotkeyToggle,
    hotkeyAsk: cfg.hotkeyAsk
  }));

  ipcMain.on('hide', () => win?.hide());

  ipcMain.handle('get-profile', async () => {
    if (!fs.existsSync(PROFILE_PATH)) return { text: '', file: PROFILE_PATH };
    try {
      return { text: await extractText(PROFILE_PATH), file: PROFILE_PATH };
    } catch {
      return { text: '', file: PROFILE_PATH };
    }
  });

  ipcMain.handle('save-profile', (_e, text) => {
    // a PDF profile is read-only: writing plain text over it would destroy the file
    if (PROFILE_PATH.toLowerCase().endsWith('.pdf')) {
      return { ok: false, error: 'PROFILE_FILE points at a PDF, which cannot be written. Point PROFILE_FILE at a .txt path to save edits.' };
    }
    try {
      fs.writeFileSync(PROFILE_PATH, String(text ?? ''), 'utf8');
      ai.setProfile(text);
      return { ok: true, file: PROFILE_PATH };
    } catch (e) {
      return { ok: false, error: `could not save ${PROFILE_PATH}: ${e.message}` };
    }
  });

  ipcMain.handle('pick-resume', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load resume or context file',
      filters: [{ name: 'Resume', extensions: ['pdf', 'txt', 'md'] }],
      properties: ['openFile']
    });
    if (canceled || !filePaths[0]) return null;
    try {
      return { text: await extractText(filePaths[0]), name: path.basename(filePaths[0]) };
    } catch (e) {
      return { error: `could not read ${path.basename(filePaths[0])}: ${e.message}` };
    }
  });

  // ask(arrayBuffer|null, arrayBuffer|null, 'brief'|'normal'|'deep'): pcm s16le mono 16k. First = interview/question
  // audio, second = the user's mic. Streams answer back over ai-chunk / ai-done / ai-error.
  ipcMain.on('ask', async (event, pcmBuffer, micBuffer, length) => {
    const send = (ch, ...args) => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, ...args);
    };
    try {
      // screenshot is best-effort: an answer from audio beats no answer
      let png = null;
      if (ai.usesScreenshot()) {
        try {
          png = await captureScreenshot();
        } catch (e) {
          console.error(`screenshot skipped: ${e.message}`);
        }
      }
      const wav = pcmBuffer && pcmBuffer.byteLength >= 2 ? pcm16ToWav(Buffer.from(pcmBuffer)) : null;
      const micWav = micBuffer && micBuffer.byteLength >= 2 ? pcm16ToWav(Buffer.from(micBuffer)) : null;
      const text = await ai.suggest({ png, wav, micWav, length, onChunk: (t) => send('ai-chunk', t) });
      send('ai-done', text);
    } catch (e) {
      send('ai-error', String(e.message || e));
      send('ai-done', '');
    }
  });
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = 420;
  const height = 400; // options row wraps; the Context panel carries resume, status, and device selects
  win = new BrowserWindow({
    width,
    height,
    x: wa.x + wa.width - width - 24,
    y: wa.y + 24,
    transparent: true,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Aside',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // stay above fullscreen calls/videos
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (cfg.hideFromCapture) win.setContentProtection(true); // WDA_EXCLUDEFROMCAPTURE: gone from screen capture/recording
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive()); // never steal focus
}

function setupHotkeys() {
  const toggle = () => (win.isVisible() ? win.hide() : win.showInactive());
  const ask = () => win?.webContents.send('force-ask');
  if (!globalShortcut.register(cfg.hotkeyToggle, toggle)) console.error(`hotkey busy: ${cfg.hotkeyToggle}`);
  if (!globalShortcut.register(cfg.hotkeyAsk, ask)) console.error(`hotkey busy: ${cfg.hotkeyAsk}`);
}

async function selftest() {
  console.log(`[selftest] provider=${cfg.provider}`);
  let png;
  try {
    png = await captureScreenshot();
    fs.writeFileSync(path.join(__dirname, 'selftest-shot.png'), png);
    console.log(`[selftest] screenshot OK (${png.length} bytes -> selftest-shot.png)`);
  } catch (e) {
    console.error(`[selftest] screenshot FAILED: ${e.message}`);
    return app.exit(2);
  }

  const info = await ai.probe();
  console.log(`[selftest] provider check: ${info.ok ? 'OK' : 'FAIL'} - ${info.detail}`);
  if (!info.ok) return app.exit(2);

  if (info.vision) {
    const text = await ai.suggest({ png, wav: null, onChunk: () => {} });
    console.log(`[selftest] vision answer: ${text.trim().slice(0, 300)}`);
  } else {
    const text = await ai.suggest({ png: null, wav: null, onChunk: () => {} });
    console.log(`[selftest] text-only answer: ${text.trim().slice(0, 200)}`);
    console.log('[selftest] WARNING: no vision model. Screen analysis needs one, e.g.: ollama pull gemma3:4b');
  }
  app.exit(0);
}

app.whenReady().then(async () => {
  // grant the renderer whole-screen + system-audio loopback without a picker (Windows: "audio" loopback)
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
      .catch(() => callback({}));
  });

  if (SELFTEST) return selftest();

  await loadProfile();
  setupIpc();  createWindow();
  setupHotkeys();

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
});
