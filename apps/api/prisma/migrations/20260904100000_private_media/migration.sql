-- Private images are stored outside PostgreSQL; this table contains only authorization and lifecycle metadata.
CREATE TYPE "PrivateMessageKind" AS ENUM ('TEXT', 'IMAGE');

ALTER TABLE "PrivateMessage"
  ADD COLUMN "kind" "PrivateMessageKind" NOT NULL DEFAULT 'TEXT';

CREATE TABLE "PrivateMedia" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "storedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "purgedAt" TIMESTAMP(3),
  CONSTRAINT "PrivateMedia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivateMedia_byteSize_positive" CHECK ("byteSize" > 0),
  CONSTRAINT "PrivateMedia_dimensions_positive" CHECK ("width" > 0 AND "height" > 0),
  CONSTRAINT "PrivateMedia_expiry_after_creation" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "PrivateMedia_messageId_key" ON "PrivateMedia"("messageId");
CREATE UNIQUE INDEX "PrivateMedia_storageKey_key" ON "PrivateMedia"("storageKey");
CREATE INDEX "PrivateMessage_conversationId_kind_createdAt_idx" ON "PrivateMessage"("conversationId", "kind", "createdAt");
CREATE INDEX "PrivateMedia_conversationId_expiresAt_deletedAt_idx" ON "PrivateMedia"("conversationId", "expiresAt", "deletedAt");
CREATE INDEX "PrivateMedia_authorId_createdAt_idx" ON "PrivateMedia"("authorId", "createdAt");
CREATE INDEX "PrivateMedia_deletedAt_purgedAt_idx" ON "PrivateMedia"("deletedAt", "purgedAt");
CREATE INDEX "PrivateMedia_storedAt_deletedAt_purgedAt_idx" ON "PrivateMedia"("storedAt", "deletedAt", "purgedAt");

ALTER TABLE "PrivateMedia" ADD CONSTRAINT "PrivateMedia_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "PrivateConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivateMedia" ADD CONSTRAINT "PrivateMedia_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "PrivateMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivateMedia" ADD CONSTRAINT "PrivateMedia_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
