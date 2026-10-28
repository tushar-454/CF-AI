-- D1 database schema for Claude-style chat web app

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  attachments TEXT, -- JSON array of file metadata
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL,
  stage TEXT DEFAULT 'upload',
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  completed_at INTEGER,
  chunk_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_documents_conversation_id ON documents(conversation_id);
