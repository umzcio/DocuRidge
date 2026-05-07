-- Calculated field type — expression of other field values, evaluated live
-- in the ceremony and re-evaluated server-side at submit.
ALTER TYPE "FieldType" ADD VALUE 'FORMULA';
