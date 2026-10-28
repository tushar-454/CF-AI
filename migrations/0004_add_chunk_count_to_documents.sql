-- Migration: 0004_add_chunk_count_to_documents.sql
-- Description: Add chunk_count column to documents table for accurate vector cleanup

ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0;
