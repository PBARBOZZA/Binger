-- The original city uses teofilo-otoni-mg; earlier repairs only searched
-- teofilo-otoni. Preserve both sets of IDs/FKs and fail closed on ambiguity.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "City", "Room", "UserProfile", "RoomMessage" IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  original_city "City"%ROWTYPE;
  duplicate_city "City"%ROWTYPE;
  original_room "Room"%ROWTYPE;
  duplicate_room "Room"%ROWTYPE;
BEGIN
  SELECT * INTO original_city FROM "City" WHERE "slug" = 'teofilo-otoni-mg';
  -- Empty installations and the supported same-city legacy case are unchanged.
  IF NOT FOUND THEN RETURN; END IF;
  IF original_city."name" <> 'Teófilo Otoni' OR original_city."state" <> 'MG' THEN
    RAISE EXCEPTION 'Regional city repair: ambiguous original city teofilo-otoni-mg; review manually';
  END IF;
  IF EXISTS (SELECT 1 FROM "City" WHERE "name" = 'Teófilo Otoni' AND "state" = 'MG'
    AND "slug" NOT IN ('teofilo-otoni-mg', 'teofilo-otoni')) THEN
    RAISE EXCEPTION 'Regional city repair: additional city for Teófilo Otoni/MG; review manually';
  END IF;
  SELECT * INTO original_room FROM "Room" WHERE "cityId" = original_city."id" AND "slug" = 'geral';
  IF NOT FOUND OR original_room."name" <> 'Sala Geral'
    OR (original_room."publicSlug" IS NOT NULL AND original_room."publicSlug" <> 'teofilo-otoni-mg') THEN
    RAISE EXCEPTION 'Regional city repair: missing or ambiguous original Sala Geral; review manually';
  END IF;

  SELECT * INTO duplicate_city FROM "City" WHERE "slug" = 'teofilo-otoni';
  IF FOUND THEN
    IF duplicate_city."id" <> 'cregionalteofilootonimg001'
      OR duplicate_city."name" <> 'Teófilo Otoni' OR duplicate_city."state" <> 'MG' THEN
      RAISE EXCEPTION 'Regional city repair: unexpected duplicate city identity; review manually';
    END IF;
    SELECT * INTO duplicate_room FROM "Room" WHERE "cityId" = duplicate_city."id" AND "slug" = 'conversa-geral';
    IF NOT FOUND OR duplicate_room."id" <> 'cregionalroomteofilootoni' OR duplicate_room."name" <> 'Conversa Geral'
      OR NOT (COALESCE(duplicate_room."publicSlug" = 'teofilo-otoni-mg', false)
        OR (duplicate_room."publicSlug" IS NULL AND NOT duplicate_room."active")) THEN
      RAISE EXCEPTION 'Regional city repair: missing or unexpected duplicate room; review manually';
    END IF;
    IF EXISTS (SELECT 1 FROM "RoomMessage" WHERE "roomId" = duplicate_room."id") THEN
      RAISE EXCEPTION 'Regional city repair: duplicate room contains messages, including deleted/hidden; review manually';
    END IF;
    IF EXISTS (SELECT 1 FROM "UserProfile" WHERE "cityId" = duplicate_city."id") THEN
      RAISE EXCEPTION 'Regional city repair: duplicate city has profiles; preserve links and review manually';
    END IF;
    -- Even an inactive or empty additional room may be legitimate. Never guess.
    IF EXISTS (SELECT 1 FROM "Room" WHERE "cityId" = duplicate_city."id" AND "id" <> duplicate_room."id") THEN
      RAISE EXCEPTION 'Regional city repair: duplicate city has other rooms; preserve links and review manually';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "Room" WHERE "publicSlug" = 'teofilo-otoni-mg'
    AND "id" <> original_room."id" AND "id" IS DISTINCT FROM duplicate_room."id") THEN
    RAISE EXCEPTION 'Regional city repair: public address conflict; review manually';
  END IF;

  -- All checks precede writes. Release the unique address before assigning it.
  IF duplicate_city."id" IS NOT NULL THEN
    UPDATE "Room" SET "active" = false, "publicSlug" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = duplicate_room."id" AND ("active" OR "publicSlug" IS NOT NULL);
    UPDATE "City" SET "active" = false WHERE "id" = duplicate_city."id" AND "active";
  END IF;
  UPDATE "Room" SET "publicSlug" = 'teofilo-otoni-mg', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = original_room."id" AND "publicSlug" IS DISTINCT FROM 'teofilo-otoni-mg';
END $$;
COMMIT;
