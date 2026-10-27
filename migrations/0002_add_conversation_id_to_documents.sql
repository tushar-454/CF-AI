-- Migration: 0002_add_conversation_id_to_documents.sql
-- Description: Add conversation_id column to documents table for chat-specific knowledge base

ALTER TABLE documents ADD COLUMN conversation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_conversation_id ON documents(conversation_id);
