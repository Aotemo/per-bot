#!/usr/bin/env bash
# Runs on the Colab VM. Installs Ollama, pulls the models from the Ollama
# registry and starts `ollama serve`.
#
# Pulling from the registry (~160 MB/s) is faster than copying from Google
# Drive. If Drive is mounted, it is used as a fallback: the installer and
# models are read from it when a download fails, and saved to it otherwise.
set -euo pipefail

DRIVE_DIR=${DRIVE_DIR:-/content/drive/MyDrive/per_bot_ollama}
LOCAL_MODELS=/content/models
MODELS=${MODELS:-"qwen3:14b bge-m3"}
TARBALL=/content/ollama-linux-amd64.tar.zst

drive_mounted() { mountpoint -q /content/drive; }

mkdir -p "$LOCAL_MODELS"

if ! command -v zstd >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zstd >/dev/null
fi

if ! command -v ollama >/dev/null; then
  echo "Installing Ollama"
  if ! curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst -o "$TARBALL"; then
    drive_mounted || { echo "Ollama download failed and Drive is not mounted" >&2; exit 1; }
    echo "Download failed; using the installer from Drive"
    cp "$DRIVE_DIR/ollama-linux-amd64.tar.zst" "$TARBALL"
  fi
  tar -C /usr -xf "$TARBALL"
  # Colab's CUDA 13 driver makes Ollama pick cuda_v13, which ships no prebuilt
  # kernels for T4/L4 and JIT-compiles them on every new VM (~3 minutes).
  # cuda_v12 has sm_75/sm_89 kernels and loads in seconds.
  if [ -d /usr/lib/ollama/cuda_v12 ]; then
    rm -rf /usr/lib/ollama/cuda_v13
  fi
fi

if ! curl -fs http://127.0.0.1:11434 >/dev/null; then
  OLLAMA_MODELS=$LOCAL_MODELS OLLAMA_HOST=127.0.0.1:11434 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_KEEP_ALIVE=-1 \
    nohup ollama serve >/content/ollama.log 2>&1 &
  until curl -fs http://127.0.0.1:11434 >/dev/null; do sleep 1; done
fi

for model in $MODELS; do
  if ollama show "$model" >/dev/null 2>&1; then
    continue
  fi
  echo "Pulling $model"
  if ! ollama pull "$model" >/dev/null; then
    drive_mounted || { echo "Pulling $model failed and Drive is not mounted" >&2; exit 1; }
    echo "Pull failed; copying models from Drive"
    rsync -a "$DRIVE_DIR/models/" "$LOCAL_MODELS/"
    ollama show "$model" >/dev/null
  fi
done

if drive_mounted; then
  echo "Saving installer and models to Drive"
  mkdir -p "$DRIVE_DIR/models"
  [ -f "$TARBALL" ] && rsync -a "$TARBALL" "$DRIVE_DIR/"
  rsync -a "$LOCAL_MODELS/" "$DRIVE_DIR/models/"
fi

# Load both models and trigger CUDA warm-up so the first real request is fast.
# Chat model first: loading it second evicts the embedding model on a T4.
echo "Warming up"
curl -fs http://127.0.0.1:11434/api/chat \
  -d "{\"model\":\"${CHAT_MODEL:-qwen3:14b}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":${CONTEXT_TOKENS:-32768}}}" >/dev/null
curl -fs http://127.0.0.1:11434/api/embed -d '{"model":"bge-m3","input":["warm up"]}' >/dev/null
ollama ps

nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv
echo "ollama ready"
