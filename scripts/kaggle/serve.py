"""Serve the bot's Ollama models from a Kaggle notebook (GPU T4 x2).

Paste this file into one notebook cell, with Settings -> Accelerator "GPU T4 x2" and Internet on.
Run it with "Save Version -> Save & Run All" so it keeps running in the background (Kaggle stops a
session after about 12 hours). Kaggle has no SSH, so Ollama is exposed through cloudflared behind a
proxy that requires `Authorization: Bearer <OLLAMA_API_KEY>`.

Kaggle secrets (Add-ons -> Secrets), all optional:
  OLLAMA_API_KEY           token the bot sends; generated and printed when missing
  CLOUDFLARE_TUNNEL_TOKEN  named tunnel with a fixed hostname; without it a random
                           https://*.trycloudflare.com URL is printed on every start

Then set OLLAMA_URL and OLLAMA_API_KEY in the bot's .env and restart it.
"""

import http.client
import io
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHAT_MODEL = "qwen3.6:35b-a3b"
EMBEDDING_MODEL = "bge-m3"
CONTEXT_TOKENS = 32768
OLLAMA_PORT = 11434
PROXY_PORT = 8000
MODELS_DIR = "/tmp/ollama-models"
LOG_DIR = "/tmp/per_bot"


def secret(name):
    try:
        from kaggle_secrets import UserSecretsClient

        return UserSecretsClient().get_secret(name) or None
    except Exception:
        return os.environ.get(name) or None


def run(command):
    subprocess.run(command, check=True)


def install_ollama():
    if shutil.which("ollama"):
        return
    print("Installing Ollama", flush=True)
    run([sys.executable, "-m", "pip", "install", "-q", "zstandard"])
    import zstandard

    url = "https://ollama.com/download/ollama-linux-amd64.tar.zst"
    with urllib.request.urlopen(url) as response:
        data = zstandard.ZstdDecompressor().stream_reader(response).read()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall("/usr")
    # Kaggle's CUDA 13 driver makes Ollama pick cuda_v13, which JIT-compiles kernels for the T4
    # for minutes on every start; cuda_v12 ships prebuilt sm_75 kernels.
    if os.path.isdir("/usr/lib/ollama/cuda_v12"):
        shutil.rmtree("/usr/lib/ollama/cuda_v13", ignore_errors=True)


def start_ollama():
    env = {
        **os.environ,
        "OLLAMA_HOST": f"127.0.0.1:{OLLAMA_PORT}",
        "OLLAMA_MODELS": MODELS_DIR,
        "OLLAMA_FLASH_ATTENTION": "1",
        "OLLAMA_KV_CACHE_TYPE": "q8_0",
        "OLLAMA_KEEP_ALIVE": "-1",
    }
    log = open(f"{LOG_DIR}/ollama.log", "ab")
    process = subprocess.Popen(["ollama", "serve"], env=env, stdout=log, stderr=log)
    for _ in range(120):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{OLLAMA_PORT}/api/version", timeout=2)
            return process
        except Exception:
            time.sleep(1)
    raise RuntimeError("ollama serve did not start; see /tmp/per_bot/ollama.log")


def ollama_post(path, body, timeout):
    connection = http.client.HTTPConnection("127.0.0.1", OLLAMA_PORT, timeout=timeout)
    connection.request("POST", path, body=body, headers={"content-type": "application/json"})
    response = connection.getresponse()
    payload = response.read()
    if response.status != 200:
        raise RuntimeError(f"{path} failed with {response.status}: {payload[:300]!r}")
    return payload


def pull_and_warm_up():
    for model in (CHAT_MODEL, EMBEDDING_MODEL):
        print(f"Pulling {model}", flush=True)
        ollama_post("/api/pull", f'{{"model":"{model}","stream":false}}', timeout=3600)
    print("Warming up", flush=True)
    # Chat model first: loaded second, it could evict the embedding model.
    ollama_post(
        "/api/chat",
        f'{{"model":"{CHAT_MODEL}","messages":[{{"role":"user","content":"hi"}}],'
        f'"stream":false,"think":false,"options":{{"num_ctx":{CONTEXT_TOKENS}}}}}',
        timeout=900,
    )
    ollama_post("/api/embed", f'{{"model":"{EMBEDDING_MODEL}","input":["warm up"]}}', timeout=600)
    subprocess.run(["ollama", "ps"], env={**os.environ, "OLLAMA_HOST": f"127.0.0.1:{OLLAMA_PORT}"})


def start_auth_proxy(api_key):
    expected = f"Bearer {api_key}"

    class Proxy(BaseHTTPRequestHandler):
        def _forward(self):
            if not secrets.compare_digest(self.headers.get("authorization", ""), expected):
                self.send_response(401)
                self.end_headers()
                return
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length else None
            connection = http.client.HTTPConnection("127.0.0.1", OLLAMA_PORT, timeout=900)
            connection.request(
                self.command,
                self.path,
                body=body,
                headers={"content-type": self.headers.get("content-type", "application/json")},
            )
            response = connection.getresponse()
            payload = response.read()
            self.send_response(response.status)
            self.send_header("content-type", response.getheader("content-type", "application/json"))
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = _forward
        do_POST = _forward

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", PROXY_PORT), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def start_tunnel(tunnel_token):
    binary = "/tmp/cloudflared"
    if not os.path.exists(binary):
        urllib.request.urlretrieve(
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            binary,
        )
        os.chmod(binary, 0o755)
    log_path = f"{LOG_DIR}/cloudflared.log"
    log = open(log_path, "ab")
    if tunnel_token:
        command = [binary, "tunnel", "--no-autoupdate", "run", "--token", tunnel_token]
    else:
        command = [binary, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PROXY_PORT}"]
    process = subprocess.Popen(command, stdout=log, stderr=log)
    if tunnel_token:
        return process, "(the hostname configured for this Cloudflare tunnel)"
    for _ in range(60):
        with open(log_path, encoding="utf-8", errors="replace") as handle:
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", handle.read())
        if match:
            return process, match.group(0)
        time.sleep(1)
    raise RuntimeError("cloudflared did not print a URL; see /tmp/per_bot/cloudflared.log")


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(MODELS_DIR, exist_ok=True)
    started = time.time()

    api_key = secret("OLLAMA_API_KEY")
    if not api_key:
        api_key = secrets.token_urlsafe(32)
        print("No OLLAMA_API_KEY secret; generated one for this run.", flush=True)

    install_ollama()
    ollama = start_ollama()
    pull_and_warm_up()
    start_auth_proxy(api_key)
    tunnel, url = start_tunnel(secret("CLOUDFLARE_TUNNEL_TOKEN"))
    subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv"])

    print(f"\nReady in {time.time() - started:.0f}s. Put these in the bot's .env and restart it:", flush=True)
    print(f"OLLAMA_URL={url}")
    print(f"OLLAMA_API_KEY={api_key}\n", flush=True)

    while True:
        time.sleep(300)
        for name, process in (("ollama", ollama), ("cloudflared", tunnel)):
            if process.poll() is not None:
                raise RuntimeError(f"{name} exited; see {LOG_DIR}/{name}.log")
        print(f"{time.strftime('%H:%M:%S')} serving {url}", flush=True)


main()
