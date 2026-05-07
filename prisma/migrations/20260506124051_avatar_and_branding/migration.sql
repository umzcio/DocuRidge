-- AlterTable
ALTER TABLE "organisation" ADD COLUMN     "emailFooter" TEXT,
ADD COLUMN     "logoBase64" TEXT,
ADD COLUMN     "logoMimeType" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "avatarBase64" TEXT,
ADD COLUMN     "avatarMimeType" TEXT;
