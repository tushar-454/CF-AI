-- Migration: 0003_add_processing_fields_to_documents.sql
-- Description: Add processing fields (stage, progress, error_message, completed_at) to documents table

ALTER TABLE documents ADD COLUMN stage TEXT DEFAULT 'upload';
ALTER TABLE documents ADD COLUMN progress INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN error_message TEXT;
ALTER TABLE documents ADD COLUMN completed_at INTEGER;
