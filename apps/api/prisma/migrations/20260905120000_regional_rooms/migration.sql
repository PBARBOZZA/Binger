-- Additive migration: Room/City and the required RoomMessage.roomId FK already exist.
-- Keep every room/message/profile ID, local slug, active flag and private table intact.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "Room" ADD COLUMN "publicSlug" TEXT;
ALTER TABLE "Room" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "Room_publicSlug_key" ON "Room"("publicSlug");

INSERT INTO "City" ("id", "name", "state", "slug") VALUES
  ('cregionalteofilootonimg001', 'Teófilo Otoni', 'MG', 'teofilo-otoni'),
  ('cregionalmucuriba00000001', 'Mucuri', 'BA', 'mucuri')
ON CONFLICT ("slug") DO NOTHING;

-- Refuse unexpected city identity instead of silently relabeling existing history.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "City" WHERE ("slug" = 'teofilo-otoni' AND "state" <> 'MG')
    OR ("slug" = 'mucuri' AND "state" <> 'BA')) THEN
    RAISE EXCEPTION 'Regional migration: unexpected city state; review City before retrying';
  END IF;
END $$;

INSERT INTO "Room" ("id", "cityId", "name", "slug")
SELECT 'cregionalroom' || REPLACE(c."slug", '-', ''), c."id", 'Conversa Geral', 'conversa-geral'
FROM "City" c WHERE c."slug" IN ('teofilo-otoni', 'mucuri')
ON CONFLICT ("cityId", "slug") DO NOTHING;

-- Backfill the address of the SAME legacy general room. All historical messages
-- already point to its ID; never reassign another city's messages to Teófilo Otoni.
UPDATE "Room" r SET "publicSlug" = c."slug" || '-' || LOWER(c."state")
FROM "City" c WHERE r."cityId" = c."id" AND r."slug" = 'conversa-geral'
  AND c."slug" IN ('teofilo-otoni', 'mucuri');
COMMIT;
