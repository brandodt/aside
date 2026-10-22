// Config: .env file next to this file, overridable by real environment variables.
const fs = require('fs');
const path = require('path');

const DEFAULT_PROMPT = [
  'You are the user\'s voice. Your only job: write the exact words the user should say next,',
  'as a script they can read aloud word for word.',
  'Rules:',
  '- Output ONLY the spoken words, in first person, in the language of the conversation.',
  '- Never give advice, instructions, or commentary. No phrases like "respond with", "mention that", "suggest".',
  '- No markdown, no bullets, no stage directions, no emojis. Plain sentences only.',
  '- Sound like a confident, natural professional speaking out loud. Short sentences.',
  '- Usually 2-5 sentences (15-70 words). Longer only if the question clearly needs it.',
  '- If the last thing said was a question, answer it directly with a concrete, specific reply.',
  '- Never output placeholders or brackets like [Your Name], [X years]. Never invent facts, numbers, employers, or dates: reuse details from "About the user" when present, otherwise answer without them.',
  '- If there is nothing to answer, write a short natural sentence the user could say to keep the conversation moving.'
].join('\n');

function parseEnvFile(file) {
  const env = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = { ...parseEnvFile(path.join(__dirname, '.env')), ...process.env };
const get = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d);

module.exports = {
  provider: get('PROVIDER', 'ollama'), // ollama | gemini | openai
  ollamaUrl: get('OLLAMA_URL', 'http://localhost:11434'),
  ollamaModel: get('OLLAMA_MODEL', ''),
  geminiKey: get('GEMINI_API_KEY', ''),
  geminiModel: get('GEMINI_MODEL', 'gemini-2.5-flash'),
  openaiBaseUrl: get('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  openaiKey: get('OPENAI_API_KEY', ''),
  openaiModel: get('OPENAI_MODEL', 'gpt-4o-mini'),
  openaiVision: get('OPENAI_VISION', 'true') !== 'false', // set false for text-only models (e.g. deepseek-v4-pro)
  openaiExtraBody: (() => {
    try {
      return JSON.parse(get('OPENAI_EXTRA_BODY', ''));
    } catch {
      return null;
    }
  })(),
  // Optional speech-to-text for providers that cannot take audio directly (e.g. Ollama).
  // Any OpenAI-compatible /audio/transcriptions endpoint: local faster-whisper, whisper.cpp server, OpenAI, ...
  transcribeUrl: get('TRANSCRIBE_URL', ''),
  transcribeKey: get('TRANSCRIBE_KEY', ''),
  transcribeModel: get('TRANSCRIBE_MODEL', 'whisper-1'),
  intervalMs: Number(get('INTERVAL_MS', '0')), // 0 = manual only (button / hotkey)
  requestTimeoutMs: Number(get('REQUEST_TIMEOUT_MS', '60000')), // give up when a provider response has not started; raise for slow local models
  historyChunks: Number(get('HISTORY_CHUNKS', '8')), // past exchanges kept as context; 0 disables memory
  screenshotMaxWidth: Number(get('SCREENSHOT_MAX_WIDTH', '1280')),
  hideFromCapture: get('HIDE_FROM_CAPTURE', 'true') !== 'false', // keep the overlay out of screen shares/recordings
  profileFile: get('PROFILE_FILE', 'profile.txt'), // resume/context, relative paths resolve to the app folder
  profileMaxChars: Number(get('PROFILE_MAX_CHARS', '6000')),
  hotkeyToggle: get('HOTKEY_TOGGLE', 'CommandOrControl+\\'),
  hotkeyAsk: get('HOTKEY_ASK', 'CommandOrControl+Enter'),
  systemPrompt: get('SYSTEM_PROMPT', DEFAULT_PROMPT)
};
