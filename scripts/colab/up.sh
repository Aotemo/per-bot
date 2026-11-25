#!/usr/bin/env bash
# Runs locally. Starts a Colab GPU session, starts Ollama on it and forwards it
# to http://127.0.0.1:11434 until interrupted.
# USE_DRIVE=1 also mounts Google Drive as a fallback/backup for the installer
# and models; that needs browser authorization on every new VM.
set -euo pipefail

SESSION=${SESSION:-ollama}
GPU=${GPU:-L4}
LOCAL_PORT=${LOCAL_PORT:-11434}
# Colab only accepts ed25519/ecdsa keys
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_colab}
DIR=$(cd "$(dirname "$0")" && pwd)

if ! colab sessions 2>/dev/null | grep -q "$SESSION"; then
  colab new -s "$SESSION" --gpu "$GPU"
fi
if [ "${USE_DRIVE:-0}" = 1 ] && ! colab ssh -s "$SESSION" -i "$SSH_KEY.pub" -- mountpoint -q /content/drive; then
  colab drivemount -s "$SESSION"
fi
colab upload -s "$SESSION" "$DIR/start.sh" /content/start.sh
colab ssh -s "$SESSION" -i "$SSH_KEY.pub" -- bash /content/start.sh

echo "Forwarding 127.0.0.1:$LOCAL_PORT -> Colab Ollama (Ctrl-C to stop; 'colab stop -s $SESSION' to release the GPU)"
exec ssh -N \
  -i "$SSH_KEY" \
  -o "ProxyCommand=colab ssh --proxy-mode -s $SESSION -i $SSH_KEY.pub" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ServerAliveInterval=30 \
  -L "$LOCAL_PORT:127.0.0.1:11434" \
  root@colab
