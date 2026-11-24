import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";

export type Storage = {
  db: Database.Database;
  close(): void;
};

/** Opens (creating if needed) the single SQLite file holding all bot state. */
export function openStorage(path: string): Storage {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  loadSqliteVec(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_cache_meta (
      chat_id TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members_cache (
      chat_id TEXT NOT NULL,
      open_id TEXT NOT NULL,
      PRIMARY KEY (chat_id, open_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      topic_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      last_extracted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL REFERENCES conversations(topic_id) ON DELETE CASCADE,
      message_id TEXT,
      role TEXT NOT NULL,
      sender_open_id TEXT,
      sender_name TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_topic
      ON conversation_messages(topic_id, id);

    CREATE TABLE IF NOT EXISTS rate_limit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      open_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rate_limit_events_user
      ON rate_limit_events(open_id, created_at);

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      uploader_open_id TEXT NOT NULL,
      repo_name TEXT,
      repo_branch TEXT,
      file_path TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_sync_state (
      repo_name TEXT PRIMARY KEY,
      last_synced_at INTEGER NOT NULL,
      branch TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      embedding BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_document_chunks_doc
      ON document_chunks(document_id);

    CREATE TABLE IF NOT EXISTS index_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_index_jobs_status
      ON index_jobs(status, id);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_open_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_user
      ON memories(user_open_id, id);

    CREATE TABLE IF NOT EXISTS memory_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_open_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      target_memory_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      card_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memory_proposals_status
      ON memory_proposals(status, expires_at);
  `);

  return {
    db,
    close() {
      db.close();
    },
  };
}
