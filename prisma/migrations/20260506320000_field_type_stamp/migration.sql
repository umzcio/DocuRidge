-- Sender-uploaded image stamp (e.g. "APPROVED" graphic). Image bytes
-- live in Field.meta.stampImageBase64 + meta.stampMimeType.
ALTER TYPE "FieldType" ADD VALUE 'STAMP';
