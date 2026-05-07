-- Action / annotation field types: APPROVE (recipient one-click approval),
-- DECLINE (shortcut into the existing envelope-decline flow), NOTE (sender
-- annotation text rendered on the document and audit page).
ALTER TYPE "FieldType" ADD VALUE 'APPROVE';
ALTER TYPE "FieldType" ADD VALUE 'DECLINE';
ALTER TYPE "FieldType" ADD VALUE 'NOTE';
