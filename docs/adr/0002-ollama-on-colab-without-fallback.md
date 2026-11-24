# Ollama runs on Colab with no fallback model

Chat (`qwen3:14b`) and embedding (`bge-m3`) models are served by Ollama on a Google Colab L4 GPU, reached through a fixed-hostname Cloudflare Tunnel. When Colab is offline the bot replies that the model is offline instead of falling back to a cloud API; indexing jobs queue until it returns. This keeps all inference local and free, accepting downtime when the Colab runtime is recycled.

## Considered Options

- **Cloud API fallback (e.g. DeepSeek)**: rejected for now; the LLM client stays provider-agnostic so it can be added later.
- **Queue messages until the model returns**: rejected; replies could arrive hours late with no context.

## Consequences

- Single GPU means one request at a time: a global request queue plus per-User rate limits for non-Owner Users.
- Documents sent while Colab is offline are not retrievable until indexed.
