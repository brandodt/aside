# Aside

Minimal reimplementation of Cluely v2's core behavior (verified by REA static analysis of `cluely-v2` 2.0.194):
transparent always-on-top overlay + whole-screen capture + system-audio loopback + AI suggestions on demand.
Bring your own model: Ollama (default), Gemini, DeepSeek, or any OpenAI-compatible endpoint.

## Run

```
npm install
copy .env.example .env    # edit if needed
npm start
```

## Before the session: your context / resume

Cold start = generic scripts. Fix that first:

1. Open the overlay, click **Context** in the top bar.
2. Paste your background (name, roles, skills, projects, why you applied) — or click **Load resume (PDF/TXT)** and pick your CV; it is extracted into the box for review.
3. Click **Save**. Stored as `profile.txt` (gitignored), injected into every answer with "reuse these facts, never contradict them".

You can also point `PROFILE_FILE` at a PDF directly (`PROFILE_FILE=C:\path\resume.pdf`); it is parsed through the same extractor at startup. `PROFILE_MAX_CHARS` (default 6000) caps how much of it reaches the prompt.

## How to test it

1. `npm run selftest` — checks screenshot capture + provider without the UI, writes `selftest-shot.png`.
2. `npm start` — overlay appears top-right with status **listening**.
3. Put something on screen (a document, a chat, a video), then press `CommandOrControl+Enter` or click **What to say**. The answer streams into the overlay.
4. To test the listening part, play a video or a call with speech, then press **What to say** — with Gemini (or with `TRANSCRIBE_URL` configured) the answer covers what was said.
5. `CommandOrControl+\` hides/shows the overlay, `Esc` hides it.

Auto mode (old behavior): set `INTERVAL_MS=3000` in `.env` and it answers every ~3 s while there is audio. Default is `0` = manual only.

## Choosing your AI

All in `.env` — `PROVIDER` selects the adapter:

| Want | .env |
|---|---|
| Ollama (local, free) | `PROVIDER=ollama` + `OLLAMA_MODEL=` (needs a vision model, e.g. `ollama pull gemma3:4b`) |
| Gemini (screen + audio natively) | `PROVIDER=gemini` + `GEMINI_API_KEY=...` |
| DeepSeek | `PROVIDER=openai` + `OPENAI_BASE_URL=https://api.deepseek.com` + `OPENAI_API_KEY=sk-...` + `OPENAI_MODEL=deepseek-flash` (takes images, so screenshots are sent) + `TRANSCRIBE_URL=...` adds the spoken words |
| Any OpenAI-compatible (OpenRouter, Groq, LM Studio, vLLM...) | `PROVIDER=openai` + `OPENAI_BASE_URL=...` + `OPENAI_API_KEY=...` + `OPENAI_MODEL=...` |

Set `OPENAI_VISION=false` when the model cannot take images (DeepSeek `deepseek-v4-pro`, local text models): screenshots are then not sent, and the answer relies on the audio transcript.

Audio support: Gemini takes the WAV directly. Every other provider needs `TRANSCRIBE_URL` (any OpenAI-compatible `/audio/transcriptions` endpoint) or the answer covers the screen only.

## Local whisper server (no API keys, no cloud)

Speech-to-text runs in WSL (faster-whisper on CPU). One-time install:

```
wsl -d Ubuntu-24.04 bash /mnt/c/Users/brandodt/cluely-lite/whisper/install.sh
```

Start it (leave that WSL window open while using the app; first start downloads the model, ~150 MB):

```
wsl -d Ubuntu-24.04 bash /mnt/c/Users/brandodt/cluely-lite/whisper/start.sh
```

Then in `.env`: `TRANSCRIBE_URL=http://localhost:8000/v1/audio/transcriptions`. Check it: `curl http://localhost:8000/health`.
Accuracy/speed trade-off: `WHISPER_MODEL=Systran/faster-whisper-small` (better) or `...-tiny` (faster) before the start command. GPU (RTX 3070) works with `WHISPER_DEVICE=cuda` after installing the CUDA/cuDNN pip packages — CPU is fast enough for interview-length answers.

The default prompt makes the model output a first-person script, ready to read aloud (no advice, no bullets). Override with `SYSTEM_PROMPT` in `.env` if you want a different style.

Measured on this machine (RTX 3070): whisper ~1-2 s per chunk. `gpt-oss:20b` script answers: ~10-15 s until first words when warm (it is a reasoning model, it thinks before writing), 20-50 s when cold. `qwen2.5-coder:7b` is 5x faster but inserts `[placeholders]` and stops mid-answer — not recommended for reading aloud despite the speed. For fast, natural scripts pull a small general instruct model, e.g. `ollama pull gemma3:4b` (~3 GB, also adds screen vision) or `ollama pull llama3.2:3b` (~2 GB), then set `OLLAMA_MODEL`.

## Troubleshooting

- `ollama: 400 ... model does not support multimodal requests` — the Ollama model cannot see images. Pull one: `ollama pull gemma3:4b`, then restart the app (the model is picked at startup). Text-only models are auto-detected now: the screenshot is dropped and you get this message instead of the raw 400.
- `hotkey busy: CommandOrControl+\` — another app holds that shortcut (Cluely itself uses the same defaults). Change `HOTKEY_TOGGLE`/`HOTKEY_ASK` in `.env` or quit the other app.

## How it works (mirrors Cluely)

- **Overlay** — frameless transparent always-on-top window, never steals focus. `CommandOrControl+\` toggles it, `CommandOrControl+Enter` forces an ask, `Esc` hides.
- **System audio** — `getDisplayMedia` grant is auto-approved in main via `setDisplayMediaRequestHandler` as whole screen + `audio: "loopback"`; the renderer keeps only the audio, tapped through an inline `AudioWorklet`. Buffered PCM is sent to the model on every ask (or every `INTERVAL_MS` when auto mode is on).
- **Your microphone** (best-effort) — a second `AudioWorklet` tap records what you actually say, so context tracks reality instead of assuming you read the script. Non-Gemini providers get the mic transcribed via `TRANSCRIBE_URL` and the text is added to the next ask; Gemini gets the mic WAV as a labeled second audio clip. No mic, or permission denied, degrades to loopback-only.
- **Options row** — mic on/off with a live level dot, auto mode (off / 3 s / 5 s / 10 s), answer length (brief / normal / deep). Session-only: `.env` (`INTERVAL_MS`, `HISTORY_CHUNKS`, ...) stays the startup default. Component + 8-state preview: `renderer/options.css`, `renderer/options.preview.html` (preview is disposable).
- **Audio devices** — Context panel: `Input` picks the microphone, `Output` picks the interviewer channel (`System loopback (default)` is the Windows loopback; any enumerated input — Stereo Mix, VB-Cable, a monitor source — can be chosen instead). Labels appear after the first capture is granted; device lists refresh on panel open and on hot-plug. Session-only, like the other options.
- **Screen** — on each ask, `desktopCapturer` thumbnail PNG of the display the overlay sits on (same method Cluely uses).
- **AI** — `ai.js` adapters: Ollama `/api/chat` (images), Gemini `streamGenerateContent` (images + audio natively), OpenAI-compatible `/chat/completions` (images). Answers stream into the overlay.
- **Session memory** — the last `HISTORY_CHUNKS` (default 8) exchanges, each "they said" + "suggested reply", are sent with every ask, so follow-up questions stay on topic and replies do not repeat. Cleared when the app restarts; `HISTORY_CHUNKS=0` disables it.

## Limits

- Windows only for system-audio loopback (Chromium loopback limitation; `audio: "loopback"` is Windows-specific in Electron).
- Manual on demand by default; not token-by-token realtime speech translation.
- **Undetectable in capture** — `HIDE_FROM_CAPTURE=true` (default) sets Windows `WDA_EXCLUDEFROMCAPTURE`: the overlay is gone from screen shares, OBS, and DXGI/Windows Graphics Capture recordings. Limits: a camera pointed at the monitor (some proctored setups) still sees it; older GDI/pixel-copy capture tools may show a black box where the overlay is; some proctoring software enumerates running windows/processes and can notice the app itself.
- Clicks land on the overlay (no click-through); no account/auth/billing/telemetry/meeting-detection — those are Cluely's SaaS layer, not its function.
