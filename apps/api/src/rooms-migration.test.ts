import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../prisma/migrations/', import.meta.url);
const regionalMigration = '20260905120000_regional_rooms';
async function prepare() {
  const db = new PGlite();
  for (const name of (await readdir(migrations)).filter(name => /^\d/.test(name)).sort()) {
    if (name === regionalMigration) break;
    await db.exec(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
  }
  return db;
}
const sql = () => readFile(new URL(`${regionalMigration}/migration.sql`, migrations), 'utf8');

describe('migração regional em PostgreSQL isolado (PGlite)', () => {
  it('aplica o histórico completo em banco vazio e cria as duas salas', async () => {
    const db = await prepare();
    try {
      await db.exec(await sql());
      expect((await db.query('SELECT "publicSlug", "active" FROM "Room" ORDER BY "publicSlug"')).rows).toEqual([
        { publicSlug: 'mucuri-ba', active: true }, { publicSlug: 'teofilo-otoni-mg', active: true }
      ]);
      await expect(db.exec(`INSERT INTO "Room" ("id", "cityId", "name", "slug", "publicSlug") SELECT 'duplicate', "cityId", 'Duplicate', 'other', "publicSlug" FROM "Room" LIMIT 1`)).rejects.toThrow(/unique/i);
    } finally { await db.close(); }
  }, 30_000);

  it('preserva mensagens, IDs legados, perfil, estados de ativação, conversas e mídia privada', async () => {
    const db = await prepare();
    try {
      await db.exec(`
        INSERT INTO "City" ("id", "name", "state", "slug", "active") VALUES
          ('city-to', 'Teófilo Otoni', 'MG', 'teofilo-otoni', false), ('city-ba', 'Mucuri', 'BA', 'mucuri', true);
        INSERT INTO "Room" ("id", "cityId", "name", "slug", "active") VALUES
          ('legacy-to', 'city-to', 'Conversa Geral', 'conversa-geral', false), ('legacy-ba', 'city-ba', 'Conversa Geral', 'conversa-geral', true);
        INSERT INTO "User" ("id", "email", "passwordHash", "birthDate", "updatedAt") VALUES
          ('a', 'a@example.test', 'synthetic', '1990-01-01', NOW()), ('b', 'b@example.test', 'synthetic', '1990-01-01', NOW());
        INSERT INTO "UserProfile" ("id", "userId", "cityId", "nickname", "ageRange", "interests", "updatedAt")
          VALUES ('profile-a', 'a', 'city-to', 'A', '25–34', '{}', NOW());
        INSERT INTO "RoomMessage" ("id", "roomId", "userId", "content", "scope", "recipientId") VALUES
          ('public-to', 'legacy-to', 'a', 'public TO', 'PUBLIC', NULL),
          ('reserved-to', 'legacy-to', 'a', 'reserved TO', 'RESERVED', 'b'),
          ('public-ba', 'legacy-ba', 'b', 'public BA', 'PUBLIC', NULL);
        INSERT INTO "PrivateConversation" ("id", "participantOneId", "participantTwoId", "requestedById", "status")
          VALUES ('private', 'a', 'b', 'a', 'ACCEPTED');
        INSERT INTO "PrivateMessage" ("id", "conversationId", "senderId", "kind", "content")
          VALUES ('photo', 'private', 'a', 'IMAGE', '');
        INSERT INTO "PrivateMedia" ("id", "conversationId", "messageId", "authorId", "storageKey", "mimeType", "byteSize", "width", "height", "expiresAt")
          VALUES ('media', 'private', 'photo', 'a', 'opaque-key', 'image/webp', 100, 10, 10, NOW() + INTERVAL '1 day');
      `);
      const preserved = ['RoomMessage', 'UserProfile', 'PrivateConversation', 'PrivateMessage', 'PrivateMedia'];
      const before = await Promise.all(preserved.map(table => db.query(`SELECT * FROM "${table}" ORDER BY "id"`)));
      await db.exec(await sql());
      for (const [i, table] of preserved.entries()) expect((await db.query(`SELECT * FROM "${table}" ORDER BY "id"`)).rows).toEqual(before[i]!.rows);
      expect((await db.query('SELECT "id", "publicSlug", "active" FROM "Room" ORDER BY "id"')).rows).toEqual([
        { id: 'legacy-ba', publicSlug: 'mucuri-ba', active: true },
        { id: 'legacy-to', publicSlug: 'teofilo-otoni-mg', active: false }
      ]);
      expect((await db.query('SELECT "active" FROM "City" WHERE "id" = \'city-to\'')).rows).toEqual([{ active: false }]);
      await expect(db.exec(`DELETE FROM "Room" WHERE "id" = 'legacy-to'`)).rejects.toThrow(/foreign key/i);
    } finally { await db.close(); }
  }, 30_000);

  it('reverte toda a migration se encontra identidade de cidade inesperada', async () => {
    const db = await prepare();
    try {
      await db.exec(`INSERT INTO "City" ("id", "name", "state", "slug") VALUES ('unexpected', 'Mucuri', 'MG', 'mucuri')`);
      await expect(db.exec(await sql())).rejects.toThrow(/unexpected city state/);
      await db.exec('ROLLBACK');
      expect((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Room' AND column_name = 'publicSlug'`)).rows).toEqual([]);
      expect((await db.query('SELECT "id" FROM "City"')).rows).toEqual([{ id: 'unexpected' }]);
    } finally { await db.close(); }
  }, 30_000);
});
