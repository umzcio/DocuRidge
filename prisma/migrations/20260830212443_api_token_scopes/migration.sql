-- AlterTable
ALTER TABLE "api_token" ADD COLUMN     "scopes" TEXT NOT NULL DEFAULT 'read';

