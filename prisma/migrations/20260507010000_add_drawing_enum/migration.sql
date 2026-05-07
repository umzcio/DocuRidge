-- Add DRAWING to FieldType enum. Postgres rejects ALTER TYPE ADD VALUE
-- inside a transaction block, so this lives in its own migration file.
ALTER TYPE "FieldType" ADD VALUE IF NOT EXISTS 'DRAWING';
