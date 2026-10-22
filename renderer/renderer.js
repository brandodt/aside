// Capture system audio (loopback) + the user's mic via inline AudioWorklets, then on each ask
// send the buffered PCM + a fresh screenshot to the AI and stream the answer in.
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const outEl = document.getElementById('out');
const errEl = document.getElementById('err');
const askBtn = document.getElementById('ask');
const optsEl = document.getElementById('opts');
const micBtn = document.getElementById('mic-btn');
const micDot = document.getElementById('mic-dot');
const autoSeg = document.getElementById('auto-seg');
const lenSeg = document.getElementById('len-seg');
const micDev = document.getElementById('mic-dev');
const outDev = document.getElementById('out-dev');

const SAMPLE_RATE = 48000;
const OUT_RATE = 16000;
const RMS_GATE = 0.004; // below this the buffer is treated as silence and dropped
const MAX_BUFFER_SECONDS = 15;

let cfg = { intervalMs: 3000, hotkeyToggle: 'CommandOrControl+\\', hotkeyAsk: 'CommandOrControl+Enter' };
const loopState = { chunks: [], buffered: 0, level: 0 };
const micState = { chunks: [], buffered: 0, level: 0 };
let busy = false;
let lastAsk = 0;
let errored = false; // last ask failed: onDone must not overwrite the error status
// options row (session-only; .env is the startup defaults)
let autoMs = 0;
let answerLength = 'normal';
let micOn = true;
let micAvailable = true;

const WORKLET = `
class Tapper extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (!ch || ch.length === 0) return true;
    const n = ch[0].length;
    const out = new Float32Array(n);
    for (let c = 0; c < ch.length; c++) {
      const d = ch[c];
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    const k = 1 / ch.length;
    for (let i = 0; i < n; i++) out[i] *= k;
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}
registerProcessor('tapper', Tapper);
`;

function setStatus(text, cls) {
  statusEl.textContent = text;
  dot.className = cls || '';
}

function rmsOf(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  return Math.sqrt(sum / f32.length);
}

// ---- audio graph: one silent sink, two swappable taps (loop = interviewer, mic = user) ----
const LOOPBACK = { id: 'loopback', label: 'System loopback (default)' };
let ctx = null;
let silent = null;
let micTrack = null;
let inDevId = 'default';
let outDevId = LOOPBACK.id;
const taps = { loop: null, mic: null };

async function ensureGraph() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  silent = ctx.createGain();
  silent.gain.value = 0;
  silent.connect(ctx.destination); // keep the graph pulling (Cluely does the same)
}

function replaceTap(kind, stream, state) {
  const prev = taps[kind];
  if (prev) {
    try {
      prev.src.disconnect();
      prev.node.disconnect();
      prev.node.port.onmessage = null;
    } catch { /* already torn down */ }
    for (const t of prev.stream.getTracks()) t.stop();
  }
  state.chunks = []; // fresh device, fresh buffer
  state.buffered = 0;
  state.level = 0;
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'tapper', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  src.connect(node);
  node.connect(silent);
  node.port.onmessage = (e) => {
    state.chunks.push(e.data);
    state.buffered += e.data.length;
    state.level = Math.max(state.level, rmsOf(e.data)); // for the mic level dot
    while (state.buffered > SAMPLE_RATE * MAX_BUFFER_SECONDS) state.buffered -= state.chunks.shift().length;
  };
  taps[kind] = { src, node, stream };
}

async function setOutDevice(id) {
  const stream = id === LOOPBACK.id
    // whole-screen grant; main auto-approves it with audio: 'loopback'
    ? await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1, width: 1, height: 1 } })
    // any enumerated input (Stereo Mix, VB-Cable, a monitor source) can carry the interviewer audio
    : await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
  for (const t of stream.getVideoTracks()) t.stop(); // the grant carries the loopback audio; video is a stub
  replaceTap('loop', stream, loopState);
  outDevId = id;
}

async function setMicDevice(id) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: id === 'default' ? true : { deviceId: { exact: id } } });
    replaceTap('mic', stream, micState);
    micTrack = stream.getAudioTracks()[0] || null;
    if (micTrack && !micOn) micTrack.enabled = false;
    inDevId = id;
    if (!micAvailable) {
      micAvailable = true;
      micBtn.disabled = false;
      micBtn.classList.remove('is-error');
      micBtn.title = 'Your microphone - tap to mute';
    }
  } catch (e) {
    // best-effort: the loopback channel keeps working without a mic
    micAvailable = false;
    micBtn.disabled = true;
    micBtn.classList.add('is-error');
    micBtn.title = `no microphone (${e.message})`;
    micDev.value = inDevId;
    console.warn(`mic unavailable - answers will not know what the user actually said (${e.message})`);
  }
}

// Device selects (Context panel). Session-only; labels only appear after a capture is
// granted, so the list is refreshed once the first stream starts.
function fillSelect(sel, items, current) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.label;
    sel.append(o);
  }
  sel.value = current;
  if (sel.selectedIndex < 0) sel.selectedIndex = 0; // previous device unplugged
  return sel.value;
}

async function refreshDevices() {
  let inputs = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch { /* no device list: keep the single defaults */ }
  const named = inputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Audio input ${i + 1}` }));
  inDevId = fillSelect(micDev, [{ id: 'default', label: 'Default' }, ...named], inDevId);
  outDevId = fillSelect(outDev, [LOOPBACK, ...named], outDevId);
}

async function startAudio() {
  await ensureGraph();
  await setOutDevice(outDevId); // throws on failure: the caller shows the error state
  await setMicDevice(inDevId);
  await refreshDevices();
  setStatus('listening', 'on');
}

function drain(state) {
  if (state.buffered === 0) return { pcm: null, rms: 0 };
  const flat = new Float32Array(state.buffered);
  let off = 0;
  for (const c of state.chunks) {
    flat.set(c, off);
    off += c.length;
  }
  state.chunks = [];
  state.buffered = 0;
  let sum = 0;
  for (let i = 0; i < flat.length; i++) sum += flat[i] * flat[i];
  const rms = Math.sqrt(sum / flat.length);
  const n = Math.floor(flat.length / 3); // crude 48k -> 16k: average each group of 3 (acts as a low-pass)
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = (flat[i * 3] + flat[i * 3 + 1] + flat[i * 3 + 2]) / 3;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return { pcm, rms };
}

function ask({ force = false } = {}) {
  if (busy) return;
  const { pcm, rms } = drain(loopState);
  if (!force && (!pcm || pcm.length < OUT_RATE * 0.4 || rms < RMS_GATE)) return; // auto mode: skip silence
  const mic = micOn && micAvailable ? drain(micState) : { pcm: null, rms: 0 };
  const micPcm = mic.pcm && mic.rms >= RMS_GATE ? mic.pcm : null; // silent mic -> the script is the only record
  busy = true;
  lastAsk = Date.now();
  optsEl.classList.add('is-loading'); // in-flight ask: the options row locks
  setStatus('thinking', 'busy');
  askBtn.disabled = true;
  askBtn.textContent = 'Thinking…';
  errEl.style.display = 'none';
  errored = false;
  outEl.textContent = '';
  window.api.ask(pcm && pcm.length ? pcm.buffer : null, micPcm ? micPcm.buffer : null, answerLength);
}

askBtn.addEventListener('click', () => ask({ force: true }));

// ---- options row (session-only) ----
micBtn.addEventListener('click', () => {
  if (!micAvailable) return;
  micOn = !micOn;
  if (micTrack) micTrack.enabled = micOn; // the tap keeps running; its input goes silent
  micBtn.setAttribute('aria-pressed', String(micOn));
  if (!micOn) {
    micState.chunks = [];
    micState.buffered = 0;
    micState.level = 0;
  }
});

autoSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-auto]');
  if (!b) return;
  autoMs = Number(b.dataset.auto);
  for (const s of autoSeg.querySelectorAll('button')) s.setAttribute('aria-pressed', String(s === b));
});

lenSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-len]');
  if (!b) return;
  answerLength = b.dataset.len;
  for (const s of lenSeg.querySelectorAll('button')) s.setAttribute('aria-pressed', String(s === b));
});

// ---- device switches (Context panel selects) ----
micDev.addEventListener('change', () => setMicDevice(micDev.value));

outDev.addEventListener('change', async () => {
  const prev = outDevId;
  try {
    await setOutDevice(outDev.value);
  } catch (e) {
    outDevId = prev;
    outDev.value = prev;
    errEl.textContent = `output switch failed: ${e.message}`;
    errEl.style.display = 'block';
  }
});

if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

// ---- Context panel: background / resume ----
const ctxBtn = document.getElementById('ctx-btn');
const ctxPanel = document.getElementById('ctx');
const ctxText = document.getElementById('ctx-text');
const ctxStatus = document.getElementById('ctx-status');
let ctxOpen = false;

ctxBtn.addEventListener('click', async () => {
  ctxOpen = !ctxOpen;
  ctxPanel.classList.toggle('open', ctxOpen);
  outEl.style.display = ctxOpen ? 'none' : '';
  errEl.style.display = 'none';
  askBtn.parentElement.style.display = ctxOpen ? 'none' : '';
  if (ctxOpen) {
    const { text } = await window.api.getProfile();
    ctxText.value = text;
    ctxStatus.textContent = text.trim()
      ? 'Loaded. Edit, Load resume, or Save.'
      : 'Paste your background or load a resume, then Save.';
    refreshDevices(); // labels need a granted capture; refresh on every open
  }
});

document.getElementById('ctx-save').addEventListener('click', async () => {
  try {
    const r = await window.api.saveProfile(ctxText.value);
    if (!r.ok) {
      ctxStatus.textContent = r.error;
      return;
    }
    setStatus('listening', 'on');
    ctxStatus.textContent = `Saved to ${r.file} - used in every answer now.`;
  } catch (e) {
    ctxStatus.textContent = `save failed: ${e.message}`;
  }
});

document.getElementById('ctx-load').addEventListener('click', async () => {
  const r = await window.api.pickResume();
  if (!r) return;
  if (r.error) {
    ctxStatus.textContent = r.error;
    return;
  }
  ctxText.value = r.text;
  ctxStatus.textContent = `Loaded ${r.name} - review and Save.`;
});

window.api.onChunk((t) => {
  outEl.textContent += t;
  outEl.scrollTop = outEl.scrollHeight;
});
window.api.onDone(() => {
  busy = false;
  optsEl.classList.remove('is-loading');
  askBtn.disabled = false;
  askBtn.textContent = 'What to say';
  setStatus(errored ? 'error' : 'listening', errored ? 'err' : 'on');
});
window.api.onError((msg) => {
  errored = true;
  errEl.textContent = msg;
  errEl.style.display = 'block';
  busy = false;
  optsEl.classList.remove('is-loading');
  askBtn.disabled = false;
  askBtn.textContent = 'What to say';
  setStatus('error', 'err');
});
window.api.onForceAsk(() => ask({ force: true }));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.hide();
});

(async () => {
  cfg = { ...cfg, ...(await window.api.getConfig()) };
  hintEl.textContent = `${cfg.hotkeyToggle.replace('CommandOrControl', 'Ctrl')} hide - ${cfg.hotkeyAsk.replace('CommandOrControl', 'Ctrl')} ask`;
  try {
    await startAudio();
  } catch (e) {
    setStatus('capture failed', 'err');
    errEl.textContent = String(e.message || e);
    errEl.style.display = 'block';
  }
  // .env sets the startup defaults; the options row changes them for this session only
  autoMs = cfg.intervalMs || 0;
  for (const s of autoSeg.querySelectorAll('button')) s.setAttribute('aria-pressed', String(Number(s.dataset.auto) === autoMs));

  // always-on ticker: mic level dot + auto mode (autoMs = 0 means manual only)
  setInterval(() => {
    micDot.classList.toggle('ok', micOn && micAvailable && micState.level > RMS_GATE);
    micState.level *= 0.5; // decay: the dot falls about a second after you stop talking
    if (!autoMs) return;
    if (document.visibilityState === 'hidden') return; // overlay hidden: no calls, no spend
    if (Date.now() - lastAsk < autoMs) return;
    ask();
  }, 500);
})();
