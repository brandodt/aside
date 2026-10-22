#!/bin/bash
# Start the whisper server (port 8000). Run inside WSL and leave the window open:
#   bash /mnt/c/Users/brandodt/cluely-lite/whisper/start.sh
# Bigger/slower model:  WHISPER_MODEL=Systran/faster-whisper-small bash .../start.sh
cd "$(dirname "$0")"
exec "$HOME/whisper-env/bin/uvicorn" server:app --host 127.0.0.1 --port 8000
