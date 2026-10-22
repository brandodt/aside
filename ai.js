// AI adapters: ollama (local, images), gemini (images + audio natively), openai-compatible (images).
// Optional TRANSCRIBE_URL turns audio into text for providers without audio input.
const cfg = require('./config');

// Owner-set answer length (options row). One explicit override line beats conflicting defaults.
const LENGTH_OVERRIDE = {
  brief: 'Length override: 1-2 short sentences (max ~25 words). This overrides the default length rule.',
  deep: 'Length override: 6-10 sentences (up to ~150 words), spoken and detailed. This overrides the default length rule.'
};

async function* readLines(res) {
  const timer = idleTimers.get(res);
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for await (const chunk of res.body) {
      if (timer) timer.arm();
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines) yield line;
    }
  } finally {
    if (timer) timer.stop();
  }
  if (rest) yield rest;
}

async function* readSse(res) {
  for await (const line of readLines(res)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      yield JSON.parse(payload);
    } catch {
      /* ignore partial */
    }
  }
}

// fetch that aborts when nothing arrives within cfg.requestTimeoutMs. readLines re-arms the timer
// on every chunk, so a slow but progressing stream is not cut off.
const idleTimers = new WeakMap(); // Response -> the timer controlling the abort

async function fetchT(url, opts = {}) {
  const ac = new AbortController();
  const timer = {
    t: 0,
    arm() {
      clearTimeout(this.t);
      this.t = setTimeout(() => ac.abort(new Error(`no data for ${cfg.requestTimeoutMs} ms`)), cfg.requestTimeoutMs);
    },
    stop() {
      clearTimeout(this.t);
    }
  };
  timer.arm();
  let res;
  try {
    res = await fetch(url, { ...opts, signal: ac.signal });
  } catch (e) {
    timer.stop();
    throw e;
  }
  idleTimers.set(res, timer);
  return res;
}

async function transcribe(wav) {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  fd.append('model', cfg.transcribeModel);
  let res;
  try {
    res = await fetchT(cfg.transcribeUrl, {
      method: 'POST',
      body: fd,
      headers: cfg.transcribeKey ? { authorization: `Bearer ${cfg.transcribeKey}` } : {}
    });
  } catch (e) {
    throw new Error(`transcription server unreachable at ${cfg.transcribeUrl} - start it (whisper/start.sh) or fix TRANSCRIBE_URL (${e.message})`);
  }
  if (!res.ok) throw new Error(`transcribe failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return (j.text || '').trim();
}

function buildPrompt(transcript, hasImage, history, youSaid, length) {
  const lines = ['Write the words the user should say right now, word for word.'];
  if (profile) {
    lines.push('About the user - reuse these facts, never contradict them:', `"""${profile.slice(0, cfg.profileMaxChars)}"""`);
  }
  if (history.length) {
    lines.push('Earlier in this session, oldest first ("Suggested reply" lines are scripts the user may have read aloud already):');
    for (const h of history) {
      if (h.said) lines.push(`- They said: "${h.said}"`);
      if (h.script) lines.push(`- Suggested reply: "${h.script}"`);
    }
    lines.push('Continue the conversation naturally; do not repeat earlier replies.');
  }
  if (transcript) {
    lines.push('Just said (system audio):', `"""${transcript}"""`);
    lines.push('The user has not replied yet. Script their reply.');
  } else {
    lines.push('No speech was captured in the last moments.');
  }
  if (youSaid) lines.push('The user already said this out loud (improvised or read from the script - do not repeat it):', `"""${youSaid}"""`);
  if (hasImage) lines.push('A screenshot of the user screen is attached.');
  if (LENGTH_OVERRIDE[length]) lines.push(LENGTH_OVERRIDE[length]); // last line: recency + explicit override
  return lines.join('\n');
}

// ---- ollama ----
let ollamaInfoCache = null;
let history = []; // session memory: [{said, script}], oldest first
let profile = ''; // user-provided context / resume text, injected into every ask

function setProfile(text) {
  profile = (text || '').trim();
}

async function ollamaInfo() {
  if (ollamaInfoCache) return ollamaInfoCache;
  const res = await fetchT(`${cfg.ollamaUrl}/api/tags`);
  if (!res.ok) throw new Error(`ollama not reachable at ${cfg.ollamaUrl} (${res.status})`);
  const { models = [] } = await res.json();
  const model = cfg.ollamaModel || models.find((m) => (m.capabilities || []).includes('vision'))?.name || models[0]?.name;
  const entry = models.find((m) => m.name === model);
  ollamaInfoCache = { models, model, vision: !!(entry?.capabilities || []).includes('vision') };
  return ollamaInfoCache;
}

async function* ollamaStream(prompt, b64png) {
  const { model } = await ollamaInfo();
  const res = await fetchT(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      keep_alive: '30m', // do not evict the model mid-interview (cold load costs 30-50s)
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content: prompt, ...(b64png ? { images: [b64png] } : {}) }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text();
    const hint = /does not support (images|multimodal)/i.test(body)
      ? ' — pull a vision model: ollama pull gemma3:4b (then restart)'
      : '';
    throw new Error(`ollama: ${res.status} ${body.slice(0, 300)}${hint}`);
  }
  for await (const line of readLines(res)) {
    if (!line.trim()) continue;
    const j = JSON.parse(line);
    const t = j.message?.content;
    if (t) yield t;
    if (j.error) throw new Error(`ollama: ${j.error}`);
  }
}

// ---- gemini ----
async function* geminiStream(prompt, b64png, b64wav, b64mic) {
  if (!cfg.geminiKey) throw new Error('GEMINI_API_KEY is not set');
  const parts = [{ text: prompt }];
  if (b64png) parts.push({ inline_data: { mime_type: 'image/png', data: b64png } });
  if (b64wav) parts.push({ inline_data: { mime_type: 'audio/wav', data: b64wav } });
  if (b64mic) {
    parts.push({ text: "The next audio clip is the user's own microphone (their voice), not the interviewer." });
    parts.push({ inline_data: { mime_type: 'audio/wav', data: b64mic } });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:streamGenerateContent?alt=sse&key=${cfg.geminiKey}`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system_instruction: { parts: [{ text: cfg.systemPrompt }] }, contents: [{ role: 'user', parts }] })
  });
  if (!res.ok) throw new Error(`gemini: ${res.status} ${(await res.text()).slice(0, 300)}`);
  for await (const j of readSse(res)) {
    const t = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (t) yield t;
  }
}

// ---- openai-compatible ----
async function* openaiStream(prompt, b64png) {
  if (!cfg.openaiKey) throw new Error('OPENAI_API_KEY is not set');
  const content = [{ type: 'text', text: prompt }];
  if (b64png) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64png}` } });
  const res = await fetchT(`${cfg.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openaiKey}` },
    body: JSON.stringify({
      model: cfg.openaiModel,
      stream: true,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content }
      ],
      ...(cfg.openaiExtraBody || {}) // e.g. {"thinking":{"type":"disabled"}} for DeepSeek
    })
  });
  if (!res.ok) throw new Error(`openai: ${res.status} ${(await res.text()).slice(0, 300)}`);
  for await (const j of readSse(res)) {
    const t = j.choices?.[0]?.delta?.content;
    if (t) yield t;
  }
}

// Streams suggestion text. png/wav/micWav are Buffers or null. length is 'brief'|'normal'|'deep'.
async function suggest({ png, wav, micWav, length, onChunk }) {
  const b64png = png ? png.toString('base64') : null;
  const b64wav = wav ? wav.toString('base64') : null;
  const b64mic = micWav ? micWav.toString('base64') : null;
  let transcript = null;
  let youSaid = null;
  let audioErr = null;
  if (cfg.provider !== 'gemini' && cfg.transcribeUrl && (wav || micWav)) {
    // both channels at once: loopback = the question, mic = what the user already answered.
    // One dead STT channel must not kill the ask; audioErr is re-checked below for the case
    // where there is no screenshot to fall back on.
    const [q, u] = await Promise.all([
      wav ? transcribe(wav).catch((e) => { audioErr = e; return ''; }) : Promise.resolve(''),
      micWav ? transcribe(micWav).catch(() => '') : Promise.resolve('')
    ]);
    transcript = q || null;
    youSaid = u.trim() || null;
  }

  // providers that cannot see images: do not attach the screenshot
  let useImage = !!b64png;
  if (cfg.provider === 'openai' && !cfg.openaiVision) useImage = false;
  if (cfg.provider === 'ollama') {
    const info = await ollamaInfo();
    if (!info.vision) {
      // text-only model: only the transcript can help it
      if (!transcript) {
        throw new Error(
          `ollama model "${info.model}" is text-only and no speech was transcribed. ` +
            'Is the whisper server running (whisper/start.sh) and is system audio playing? Then ask again.'
        );
      }
      useImage = false;
    }
  }

  // a dead STT channel is fatal only when there is no screenshot to answer from
  if (audioErr && !useImage && !transcript) throw audioErr;

  const prompt = buildPrompt(transcript, useImage, history, youSaid, length);
  const makeStream = () =>
    cfg.provider === 'gemini' ? geminiStream(prompt, b64png, b64wav, b64mic)
    : cfg.provider === 'openai' ? openaiStream(prompt, useImage ? b64png : null)
    : ollamaStream(prompt, useImage ? b64png : null);
  let text = '';
  for (let attempt = 1; ; attempt++) {
    try {
      for await (const t of makeStream()) {
        text += t;
        onChunk(t);
      }
      break;
    } catch (e) {
      // retry a transient failure only before any output; after output a retry would duplicate text
      const transient = /429|50[234]|no data for|fetch failed|ECONNREFUSED|not reachable|socket hang up|terminated/i.test(String(e.message));
      if (text || attempt >= 3 || !transient) throw e;
      console.error(`provider error, retrying (${attempt}/3): ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  const script = text.trim();
  if (script) {
    history.push({ said: transcript || '', script: script.slice(0, 400) });
    while (history.length > cfg.historyChunks) history.shift();
  }
  return text;
}

// Probe provider for selftest: reachability + vision capability.
async function probe() {
  if (cfg.provider === 'ollama') {
    const info = await ollamaInfo();
    return {
      ok: !!info.model,
      vision: info.vision,
      detail: `ollama model "${info.model}" (${info.models.length} installed)${info.vision ? ', vision' : ', NO vision model installed'}`
    };
  }
  if (cfg.provider === 'gemini') return { ok: !!cfg.geminiKey, vision: true, detail: `gemini ${cfg.geminiModel}` };
  return {
    ok: !!cfg.openaiKey,
    vision: cfg.openaiVision,
    detail: `openai-compatible ${cfg.openaiModel} @ ${cfg.openaiBaseUrl}${cfg.openaiVision ? '' : ' (OPENAI_VISION=false: screenshots are not sent)'}`
  };
}

// Does the current provider use screenshots at all? (ollama capability is known only
// async, so assume yes there; suggest() drops the image for text-only models)
function usesScreenshot() {
  return cfg.provider !== 'openai' || cfg.openaiVision;
}

module.exports = { suggest, probe, usesScreenshot, setProfile };
