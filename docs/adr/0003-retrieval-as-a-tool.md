# Knowledge Base retrieval is a model-invoked tool

Retrieval is exposed to the model as a tool it decides to call, rather than running before every turn. Most group chatter does not need the Knowledge Base, and a single shared GPU makes wasted embedding and prompt tokens costly. Memories, being few, are always injected into the system prompt instead. Escalation is likewise a tool (`escalate_to_owner`) the model calls when retrieval does not answer the question, rather than a similarity threshold.

## Consequences

- The model may occasionally skip retrieval when it should have searched; the system prompt instructs it to search before answering factual questions about the Owner's work and to escalate rather than guess.
- Requires a model with reliable tool calling, which constrains model choice.
