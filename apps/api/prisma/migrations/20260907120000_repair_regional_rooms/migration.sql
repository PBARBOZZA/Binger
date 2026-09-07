-- Correct the already-applied regional migration; never move or delete history.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "City", "Room", "RoomMessage" IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  c RECORD;
  original "Room"%ROWTYPE;
  duplicate "Room"%ROWTYPE;
  address TEXT;
BEGIN
  FOR c IN SELECT * FROM "City" WHERE "slug" IN ('teofilo-otoni', 'mucuri') LOOP
    IF c."state" <> (CASE c."slug" WHEN 'teofilo-otoni' THEN 'MG' ELSE 'BA' END) THEN
      RAISE EXCEPTION 'Regional repair: unexpected city state for %; review manually', c."slug";
    END IF;
    address := c."slug" || '-' || LOWER(c."state");
    SELECT * INTO original FROM "Room" WHERE "cityId" = c."id" AND "slug" = 'geral';
    IF NOT FOUND THEN CONTINUE; END IF;
    IF original."name" <> 'Sala Geral' OR (original."publicSlug" IS NOT NULL AND original."publicSlug" <> address) THEN
      RAISE EXCEPTION 'Regional repair: ambiguous legacy room in %; review manually', c."slug";
    END IF;
    SELECT * INTO duplicate FROM "Room" WHERE "cityId" = c."id" AND "slug" = 'conversa-geral';
    IF FOUND THEN
      IF duplicate."id" <> 'cregionalroom' || REPLACE(c."slug", '-', '')
        OR duplicate."name" <> 'Conversa Geral'
        OR NOT (COALESCE(duplicate."publicSlug" = address, false) OR (duplicate."publicSlug" IS NULL AND NOT duplicate."active")) THEN
        RAISE EXCEPTION 'Regional repair: unexpected duplicate in %; review manually', c."slug";
      END IF;
      IF EXISTS (SELECT 1 FROM "RoomMessage" WHERE "roomId" = duplicate."id") THEN
        RAISE EXCEPTION 'Regional repair: duplicate in % contains messages (including deleted/hidden); review manually', c."slug";
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM "Room" WHERE "publicSlug" = address AND "id" <> original."id" AND "id" IS DISTINCT FROM duplicate."id") THEN
      RAISE EXCEPTION 'Regional repair: public address conflict in %; review manually', c."slug";
    END IF;
    IF duplicate."id" IS NOT NULL THEN
      UPDATE "Room" SET "active" = false, "publicSlug" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = duplicate."id";
    END IF;
    UPDATE "Room" SET "publicSlug" = address, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = original."id";
  END LOOP;
END $$;
COMMIT;
