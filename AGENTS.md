# AGENTS.md

Aside — Electron overlay (Windows) that captures screen + system audio and streams AI-scripted replies. Plain CommonJS, no bundler, no TypeScript, no tests, no linter. `npm start` is the dev loop.

## Layout

- `main.js` — Electron main: frameless always-on-top window, `desktopCapturer` screenshots, PCM→WAV wrapping, IPC, global hotkeys, `--selftest` mode.
- `preload.js` — the only renderer↔main bridge (`window.api`, `contextIsolation: true`). Add new IPC here, not `nodeIntegration`.
- `renderer/renderer.js` — UI state + system-audio capture (inline AudioWorklet, 48k→16k by 3-sample averaging, RMS silence gate).
- `renderer/index.html` — overlay markup + page styles. `renderer/renderer.js` binds to its element ids by name (`out`, `ask`, `ctx`, `dot`, …); keep ids in sync when editing. All colours and fonts come from `renderer/tokens.css` (tokens + vendored woff2 in `renderer/fonts/`, no runtime font fetch). `renderer/options.css` holds the options-bar styles; `renderer/options.preview.html` is a disposable state preview, not loaded by the app.
- `ai.js` — provider adapters (`ollama` | `gemini` | `openai`), prompt/history/profile. Streams back via `ai-chunk` / `ai-done` / `ai-error`.
- `config.js` — `.env` loader + defaults (single source for all config).
- `whisper/` — optional local OpenAI-compatible STT server, runs inside WSL, not Windows.

## Conventions

- New config key: add it to `config.js`, document it in `.env.example`; add it to the README table only when user-facing. A knob nothing reads is a bug (see `AUDIO_WINDOW_MS`, removed).
- New renderer↔main call: goes through `preload.js` (`window.api`) — never `nodeIntegration`.
- New UI control: add it to `renderer/index.html`, bind it in `renderer.js`; element ids are the contract between the two.

## Commands

- `npm install`, then `copy .env.example .env` if starting fresh; `npm start`.
- `node --check main.js ai.js config.js preload.js renderer/renderer.js` — fast syntax gate after JS edits; no Electron launch.
- `npm run selftest` — headless smoke test: screenshot + provider probe + one answer, writes `selftest-shot.png`. Exit 2 when the provider check fails. Uses a separate Electron userData dir, so it is safe while an instance is running. Slow when the model is cold (10–50 s). It does not cover the renderer audio path.
- Whisper: `wsl -d Ubuntu-24.04 bash /mnt/c/Users/brandodt/cluely-lite/whisper/install.sh` once, then `.../whisper/start.sh` per session (leave the window open; port 8000, `curl localhost:8000/health`). Python venv lives at `~/whisper-env` in WSL.
- Manual verify: `Ctrl+\` toggles the overlay, `Ctrl+Enter` asks, `Esc` hides.

## Config gotchas

- Real environment variables override `.env` (`config.js` merges `{...envFile, ...process.env}`); an empty string means "use default".
- `.env` is read at startup: restart after edits. Invalid `OPENAI_EXTRA_BODY` JSON silently becomes null.
- Non-Gemini providers get audio only through `TRANSCRIBE_URL`; without it the answer is screen-only. A dead STT server does not block an ask when the provider can see the screenshot — it is fatal only when there is no image and no transcript.
- `REQUEST_TIMEOUT_MS` is an idle timeout, not a total one: it covers connect and mid-stream, and every streamed chunk re-arms it. A slow-but-streaming answer survives; a stalled provider aborts and retries.
- `PROFILE_FILE` may point at a PDF; that path is read-only — `save-profile` refuses instead of overwriting it. Point it at a `.txt` to edit from the Context panel.
- `hotkey busy: <combo>` in the console means another app (e.g. Cluely itself) owns the shortcut — change `HOTKEY_*` in `.env`.

## Secrets and personal data

`.env` and `profile.txt` are gitignored and hold live keys / personal resume data in this working copy. Never print, copy, or commit them; document variables in `.env.example` instead.

## Non-obvious behavior

- `OPENAI_VISION=false` (DeepSeek path) skips screenshots entirely. Text-only Ollama models get the image dropped at ask time, and error out if no transcription is available.
- System-audio loopback is Windows-only. Audio works because `main.js` auto-grants `getDisplayMedia` via `setDisplayMediaRequestHandler` (`audio: 'loopback'`); do not port logic that would reintroduce a picker.
- Ask IPC contract: `window.api.ask(pcm, micPcm, length)` — PCM s16le mono 16 kHz (`ArrayBuffer` or null) plus the answer length (`'brief'|'normal'|'deep'`); `main.js` wraps the PCM in a WAV header before `ai.suggest()`.
- `ai.js` retries only before the first output byte (a retry after partial text would duplicate it): 3 attempts, 500/1000 ms backoff, transient statuses only.
- Loopback and mic taps each keep at most 15 s (`MAX_BUFFER_SECONDS`, hardcoded in `renderer.js`) and drain on every ask, so an ask sends only what happened since the last one.
- `whisper/start.sh` binds `127.0.0.1`; WSL localhost forwarding still reaches it from the Windows app. Do not bind it to the LAN.
- `pdf-parse` v2 API: `new PDFParse({ data })` → `getText()` → `destroy()`. Not the v1 default-export function.
- `HIDE_FROM_CAPTURE=true` (default) uses Windows `WDA_EXCLUDEFROMCAPTURE`; a black box in legacy capture tools is expected, not a bug.

## Known gaps (fix deliberately)

- No tray icon: with `skipTaskbar: true`, a busy hotkey plus a hidden window means relaunch.
- A selected audio device that disappears falls back in the select but the tap is not re-armed until you reselect.
- Text-only Ollama still captures and then drops a screenshot on each ask.
- Auto mode gates on RMS only; repeating noise can trigger paid asks with an unchanged transcript.

## Limits (do not extend silently)

- Windows-only for audio capture; no cross-platform claims.
- No accounts, auth, telemetry, or meeting detection — those are Cluely's SaaS layer, deliberately absent.
