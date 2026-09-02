-- Evolve the existing MVP tables without deleting message or conversation data.
CREATE TYPE "MessageScope" AS ENUM ('PUBLIC', 'RESERVED');

ALTER TABLE "RoomMessage"
  ADD COLUMN "recipientId" TEXT,
  ADD COLUMN "scope" "MessageScope" NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE "PrivateConversation" RENAME COLUMN "createdById" TO "participantOneId";
ALTER TABLE "PrivateConversation" RENAME COLUMN "invitedUserId" TO "participantTwoId";
ALTER TABLE "PrivateConversation" ADD COLUMN "requestedById" TEXT;
UPDATE "PrivateConversation" SET "requestedById" = "participantOneId";
ALTER TABLE "PrivateConversation" ALTER COLUMN "requestedById" SET NOT NULL;

-- Canonicalize participant order so the unique constraint is independent of invitation direction.
UPDATE "PrivateConversation"
SET "participantOneId" = LEAST("participantOneId", "participantTwoId"),
    "participantTwoId" = GREATEST("participantOneId", "participantTwoId");

-- Keep only the newest active record if legacy data contains the same pair more than once.
UPDATE "PrivateConversation" older
SET "status" = 'CLOSED', "closedAt" = COALESCE(older."closedAt", NOW())
FROM "PrivateConversation" newer
WHERE older."participantOneId" = newer."participantOneId"
  AND older."participantTwoId" = newer."participantTwoId"
  AND older."id" <> newer."id"
  AND older."createdAt" < newer."createdAt"
  AND older."status" IN ('PENDING', 'ACCEPTED');

ALTER TABLE "PrivateMessage" ADD COLUMN "readAt" TIMESTAMP(3);

ALTER TABLE "Block" RENAME TO "user_blocks";

CREATE TABLE "user_mutes" (
  "id" TEXT NOT NULL,
  "muterId" TEXT NOT NULL,
  "mutedUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_mutes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RoomMessage" ADD CONSTRAINT "RoomMessage_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrivateConversation" ADD CONSTRAINT "PrivateConversation_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_muterId_fkey"
  FOREIGN KEY ("muterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_mutedUserId_fkey"
  FOREIGN KEY ("mutedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_not_self" CHECK ("blockerId" <> "blockedUserId");
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_not_self" CHECK ("muterId" <> "mutedUserId");
ALTER TABLE "PrivateConversation" ADD CONSTRAINT "PrivateConversation_two_distinct_participants"
  CHECK ("participantOneId" < "participantTwoId");
ALTER TABLE "RoomMessage" ADD CONSTRAINT "RoomMessage_scope_recipient"
  CHECK (("scope" = 'PUBLIC' AND "recipientId" IS NULL) OR ("scope" = 'RESERVED' AND "recipientId" IS NOT NULL));

CREATE UNIQUE INDEX "PrivateConversation_active_pair_key"
  ON "PrivateConversation"("participantOneId", "participantTwoId")
  WHERE "status" IN ('PENDING', 'ACCEPTED');
CREATE INDEX "PrivateConversation_participantOneId_status_idx" ON "PrivateConversation"("participantOneId", "status");
CREATE INDEX "PrivateConversation_participantTwoId_status_idx" ON "PrivateConversation"("participantTwoId", "status");
CREATE INDEX "RoomMessage_recipientId_createdAt_idx" ON "RoomMessage"("recipientId", "createdAt");
CREATE INDEX "PrivateMessage_conversationId_createdAt_idx" ON "PrivateMessage"("conversationId", "createdAt");
CREATE INDEX "PrivateMessage_senderId_readAt_idx" ON "PrivateMessage"("senderId", "readAt");
CREATE INDEX "user_blocks_blockedUserId_idx" ON "user_blocks"("blockedUserId");
CREATE UNIQUE INDEX "user_mutes_muterId_mutedUserId_key" ON "user_mutes"("muterId", "mutedUserId");
CREATE INDEX "user_mutes_mutedUserId_idx" ON "user_mutes"("mutedUserId");

-- Rename legacy FK constraints to match the new columns (PostgreSQL keeps them valid after column rename).
ALTER TABLE "PrivateConversation" RENAME CONSTRAINT "PrivateConversation_createdById_fkey" TO "PrivateConversation_participantOneId_fkey";
ALTER TABLE "PrivateConversation" RENAME CONSTRAINT "PrivateConversation_invitedUserId_fkey" TO "PrivateConversation_participantTwoId_fkey";
ALTER TABLE "user_blocks" RENAME CONSTRAINT "Block_pkey" TO "user_blocks_pkey";
ALTER TABLE "user_blocks" RENAME CONSTRAINT "Block_blockerId_fkey" TO "user_blocks_blockerId_fkey";
ALTER TABLE "user_blocks" RENAME CONSTRAINT "Block_blockedUserId_fkey" TO "user_blocks_blockedUserId_fkey";
ALTER INDEX "Block_blockerId_blockedUserId_key" RENAME TO "user_blocks_blockerId_blockedUserId_key";
