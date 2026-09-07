-- One database order shared by messages and server-issued participation boundaries.
-- Existing content, IDs, timestamps and foreign keys remain unchanged.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "RoomMessage" ADD COLUMN "position" BIGSERIAL NOT NULL;
CREATE INDEX "RoomMessage_roomId_position_idx" ON "RoomMessage"("roomId", "position");
COMMIT;
