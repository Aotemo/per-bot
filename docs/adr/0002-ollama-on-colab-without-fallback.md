# Ollama runs on Colab with no fallback model

Chat (`qwen3.6:35b-a3b`) and embedding (`bge-m3`) models are served by Ollama on a Google Colab L4 GPU, reached from the bot's machine through an SSH tunnel to the Colab runtime (`scripts/colab/up.sh`). When Colab is offline the bot replies that the model is offline instead of falling back to a cloud API; indexing jobs queue until it returns. This keeps all inference local, accepting downtime when the Colab runtime is recycled.

## Considered Options

- **Cloud API fallback (e.g. DeepSeek)**: rejected for now; the LLM client stays provider-agnostic so it can be added later.
- **Queue messages until the model returns**: rejected; replies could arrive hours late with no context.
- **`qwen3:14b`** (fits a T4): rejected; it could not navigate code across several tool calls, and a 3B-active MoE is also faster on an L4 (about 60 vs 26 tokens/s).
- **Qwen3.8-Flash-Next via Strata**: rejected; even 2-bit packs need about 45 GB of RAM plus a 66-76 GB download on every fresh Colab VM.

## Consequences

- Requires an L4: the 21.7 GB chat model does not fit a T4, and L4 allocation sometimes has to be retried.
- Kaggle's free 2x T4 can serve the same models instead (`scripts/kaggle/serve.py`). Kaggle has no SSH, so Ollama is exposed through cloudflared behind a bearer-token proxy and the bot sends `OLLAMA_API_KEY`; sessions last about 12 hours and a quick tunnel's URL changes on every start.
- Single GPU means one request at a time: a global request queue plus per-User rate limits for non-Owner Users.
- Documents sent while Colab is offline are not retrievable until indexed.
