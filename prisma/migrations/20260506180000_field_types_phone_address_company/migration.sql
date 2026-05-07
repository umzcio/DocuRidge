-- Field type expansion: PHONE, ADDRESS, COMPANY
ALTER TYPE "FieldType" ADD VALUE 'PHONE';
ALTER TYPE "FieldType" ADD VALUE 'ADDRESS';
ALTER TYPE "FieldType" ADD VALUE 'COMPANY';

-- User profile expansion: phone / address / company so signing prefills
-- can pull from the registered user just like jobTitle does today.
ALTER TABLE "user" ADD COLUMN "phone"   TEXT;
ALTER TABLE "user" ADD COLUMN "address" TEXT;
ALTER TABLE "user" ADD COLUMN "company" TEXT;
