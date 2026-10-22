# Minimal OpenAI-compatible speech-to-text server (faster-whisper, CPU by default).
# Endpoint: POST /v1/audio/transcriptions  (multipart: file=..., model=..., language=...)
# Health:   GET /health
# Env: WHISPER_MODEL (default Systran/faster-whisper-base), WHISPER_DEVICE (cpu|cuda), WHISPER_COMPUTE
#
# Decodes WAV with the stdlib (no PyAV): the Aside app always sends 16 kHz mono PCM WAV.
import io
import os
import wave

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "Systran/faster-whisper-base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8" if DEVICE == "cpu" else "float16")

app = FastAPI()
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)


def decode_wav(data: bytes):
    with wave.open(io.BytesIO(data)) as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if width != 2:
        raise ValueError(f"only 16-bit PCM wav is supported, got {width * 8}-bit")
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1).astype(np.int16)
    audio = pcm.astype(np.float32) / 32768.0
    if rate != 16000:  # naive linear resample; our app always sends 16k
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.arange(n) * rate / 16000, np.arange(len(audio)), audio).astype(np.float32)
    return audio


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "device": DEVICE}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), model_name: str = Form("", alias="model"), language: str = Form("")):
    audio = decode_wav(await file.read())
    segments, _info = model.transcribe(audio, language=language or None, vad_filter=True, beam_size=1)
    return {"text": " ".join(s.text.strip() for s in segments).strip()}
