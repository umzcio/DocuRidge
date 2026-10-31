-- AlterTable
ALTER TABLE "envelope" ADD COLUMN     "sealFenceToken" TEXT,
ADD COLUMN     "sealFenceUntil" TIMESTAMP(3);
