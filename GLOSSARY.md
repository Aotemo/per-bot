# per_bot

A personal assistant bot reached through Feishu that acts on behalf of its Owner: it answers questions other people would otherwise ask the Owner, grounded in documents and code, and remembers facts across Conversations.

## Language

**Memory**:
A durable fact or preference about one User that persists across Conversations. Always public: never holds anything that must not be said in a group.
_Avoid_: Long-term memory, profile, history

**Memory Proposal**:
A candidate Memory awaiting the Owner's approval. Becomes a Memory only when approved.
_Avoid_: Draft memory, pending memory

**Owner**:
The single person the bot works for and speaks on behalf of.
_Avoid_: Admin, master, me

**User**:
Anyone permitted to talk to the bot: the Owner, or any member of an Allowed Group.
_Avoid_: Account, member, asker

**Allowed Group**:
Any Feishu group the bot has been added to; every member of it is a User. Adding the bot to a group is the act of authorizing it.
_Avoid_: Whitelisted chat, workspace

**Knowledge Base**:
The body of documents and code the bot may consult to answer questions. Read-only to the bot. Made of Repositories and Owner Documents.
_Avoid_: Memory, corpus, docs

**Repository**:
A private GitHub repository whose content is part of the Knowledge Base and visible to every User.
_Avoid_: Repo source, codebase

**Owner Document**:
A file the Owner sent to the bot through Feishu. Part of the Knowledge Base.
_Avoid_: Upload, attachment

**Supplementary Document**:
A file a non-Owner User sent to the bot. Belongs to that User, is not part of the Knowledge Base, and is only consulted in that User's private chat until Promoted.
_Avoid_: Personal document, upload, attachment

**Promotion**:
The Owner's act of moving a Supplementary Document into the Knowledge Base.
_Avoid_: Publish, merge, approve

**Escalation**:
Privately notifying the Owner of a question the bot could not answer, with a link to it.
_Avoid_: Handoff, fallback, forward

**Conversation**:
One Feishu topic thread, in a group or a private chat: a root message and its replies. May involve several Users. The thread's messages form the bot's immediate context.
_Avoid_: Session, chat history, memory
