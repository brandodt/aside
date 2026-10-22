#!/bin/bash
# One-time install for the local whisper server. Run inside WSL:
#   bash /mnt/c/Users/brandodt/cluely-lite/whisper/install.sh
set -e
ENVDIR=$HOME/whisper-env
if [ ! -x "$ENVDIR/bin/python" ]; then
  python3 -m venv "$ENVDIR"
fi
"$ENVDIR/bin/pip" install -U pip wheel
"$ENVDIR/bin/pip" install faster-whisper fastapi uvicorn python-multipart
echo "install OK. Start with: bash /mnt/c/Users/brandodt/cluely-lite/whisper/start.sh"
