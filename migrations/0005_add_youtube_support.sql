-- Migration: 0005_add_youtube_support.sql
-- Description: Add YouTube video chat support, canonical video knowledge, and transcript chunks

ALTER TABLE conversations ADD COLUMN type TEXT DEFAULT 'chat';
ALTER TABLE conversations ADD COLUMN video_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type);
CREATE INDEX IF NOT EXISTS idx_conversations_video_id ON conversations(video_id);

ALTER TABLE messages ADD COLUMN citations TEXT;

CREATE TABLE IF NOT EXISTS youtube_videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  channel_title TEXT,
  duration INTEGER DEFAULT 0,
  thumbnail_url TEXT,
  transcript_lang TEXT,
  transcript_source TEXT,
  transcript_version INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  stage TEXT DEFAULT 'validating',
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  embedding_model TEXT DEFAULT '@cf/baai/bge-base-en-v1.5',
  chunk_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_youtube_videos_status ON youtube_videos(status);

CREATE TABLE IF NOT EXISTS youtube_chunks (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (video_id) REFERENCES youtube_videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_youtube_chunks_video_id ON youtube_chunks(video_id);
