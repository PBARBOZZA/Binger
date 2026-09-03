-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('VERIFY_EMAIL', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "EmailToken"
ALTER COLUMN "purpose" TYPE "EmailTokenPurpose"
USING ("purpose"::"EmailTokenPurpose");

-- CreateIndex
CREATE INDEX "EmailToken_userId_purpose_createdAt_idx" ON "EmailToken"("userId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "EmailToken_expiresAt_idx" ON "EmailToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
