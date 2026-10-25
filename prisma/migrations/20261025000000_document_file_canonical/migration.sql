-- AlterTable
ALTER TABLE "document_file" ADD COLUMN     "canonicalPageCount" INTEGER,
ADD COLUMN     "canonicalRefusal" TEXT,
ADD COLUMN     "canonicalSealCost" JSONB,
ADD COLUMN     "canonicalSha256" TEXT,
ADD COLUMN     "canonicalStoragePath" TEXT,
ADD COLUMN     "canonicalVersion" INTEGER;

