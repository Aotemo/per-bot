# Memories are public and require Owner approval

The bot speaks on the Owner's behalf in group chats, so anything it remembers may surface in front of other people. Rather than tagging memories as public or private, every Memory is public, and every Memory Proposal (whether auto-extracted, written by the model mid-Conversation, or requested via `/remember`) must be approved by the Owner before it takes effect. Extraction is instructed to skip sensitive personal information.

## Considered Options

- **Public/private tiers per Memory**: rejected; adds a visibility check to every retrieval path and still risks private memories leaking through a misclassified tier.
- **Memories used only in the Owner's private chat**: rejected; the bot could not answer "like the Owner" for other people.

## Consequences

- A Memory about one User is used only when that User asks; the Owner's Memories are used for everyone.
- Memory growth is bounded by the Owner's review bandwidth. Unreviewed Proposals expire after 7 days.
