-- Migration: align document_chunks with upload route
-- Run in Supabase SQL Editor

-- Make notebook_id optional (documents can exist without a notebook)
ALTER TABLE document_chunks ALTER COLUMN notebook_id DROP NOT NULL;
ALTER TABLE document_chunks ALTER COLUMN doc_id      DROP NOT NULL;
ALTER TABLE document_chunks ALTER COLUMN doc_name    DROP NOT NULL;

-- Add columns our code uses (if they don't exist)
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS document_id  UUID REFERENCES notebook_documents(id) ON DELETE CASCADE;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS content      TEXT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS page_number  INTEGER;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tfidf_terms  JSONB DEFAULT '{}';

-- Backfill: map old columns to new ones
UPDATE document_chunks SET document_id = doc_id   WHERE document_id IS NULL AND doc_id IS NOT NULL;
UPDATE document_chunks SET content     = text      WHERE content IS NULL AND text IS NOT NULL;
UPDATE document_chunks SET page_number = page      WHERE page_number IS NULL AND page IS NOT NULL;
UPDATE document_chunks SET tfidf_terms = tf_idf_terms WHERE tfidf_terms = '{}' AND tf_idf_terms != '{}';

-- notebook_documents: add is_pinned if missing
ALTER TABLE notebook_documents ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT true;
ALTER TABLE notebook_documents ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;
