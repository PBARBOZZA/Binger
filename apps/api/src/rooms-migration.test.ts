import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { seedRegionalRooms } from './seed-regional-rooms.js';

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
const migrationSql = (name: string) => readFile(new URL(`${name}/migration.sql`, migrations), 'utf8');
const repair = '20260907120000_repair_regional_rooms';
const order = '20260907121000_room_message_order';
const cityRepair = '20260908120000_repair_regional_city_alias';
const sql = async () => (await Promise.all((await readdir(migrations)).filter(name => /^\d/.test(name) && name >= regionalMigration).sort().map(migrationSql))).join('\n');
// Exercise the real seed algorithm on PostgreSQL, through only its used Prisma operations.
function seedDatabase(db: PGlite) {
  return seedRegionalRooms({
    $transaction: (callback: any) => db.transaction(async tx => {
      const one = async (sql: string, args: any[]) => (await tx.query(sql, args)).rows[0];
      return callback({
        $executeRawUnsafe: (sql: string) => tx.exec(sql),
        city: {
          findUnique: ({ where }: any) => one('SELECT * FROM "City" WHERE slug = $1', [where.slug]),
          count: async ({ where }: any) => Number((await one('SELECT count(*) AS n FROM "City" WHERE name = $1 AND state = $2 AND NOT (slug = ANY($3::text[]))', [where.name, where.state, where.slug.notIn]) as any).n),
          update: ({ where, data }: any) => one('UPDATE "City" SET active = $1 WHERE id = $2 RETURNING *', [data.active, where.id]),
          upsert: async ({ where, create }: any) => {
          await tx.query('INSERT INTO "City" (id, name, state, slug) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING', [`seed-${create.slug}`, create.name, create.state, create.slug]);
          return one('SELECT * FROM "City" WHERE slug = $1', [where.slug]);
        } },
        room: {
          findMany: async ({ where }: any) => (await tx.query('SELECT * FROM "Room" WHERE "cityId" = $1', [where.cityId])).rows,
          findUnique: ({ where }: any) => where.cityId_slug
            ? one('SELECT * FROM "Room" WHERE "cityId" = $1 AND slug = $2', [where.cityId_slug.cityId, where.cityId_slug.slug])
            : one('SELECT * FROM "Room" WHERE "publicSlug" = $1', [where.publicSlug]),
          count: async ({ where }: any) => Number((await one('SELECT count(*) AS n FROM "Room" WHERE "cityId" = $1 AND id <> $2', [where.cityId, where.id.not]) as any).n),
          update: ({ where, data }: any) => one('UPDATE "Room" SET "publicSlug" = $1, active = COALESCE($2, active), "updatedAt" = clock_timestamp() WHERE id = $3 RETURNING *', [data.publicSlug, data.active ?? null, where.id]),
          create: ({ data }: any) => one('INSERT INTO "Room" (id, "cityId", name, slug, "publicSlug") VALUES ($1, $2, $3, $4, $5) RETURNING *', [`seed-room-${data.cityId}`, data.cityId, data.name, data.slug, data.publicSlug])
        },
        roomMessage: { count: async ({ where }: any) => Number((await one('SELECT count(*) AS n FROM "RoomMessage" WHERE "roomId" = $1', [where.roomId]) as any).n) },
        userProfile: { count: async ({ where }: any) => Number((await one('SELECT count(*) AS n FROM "UserProfile" WHERE "cityId" = $1', [where.cityId]) as any).n) }
      });
    })
  } as unknown as PrismaClient);
}
const withoutPosition = (rows: any[]) => rows.map(({ position: _position, ...row }) => row);

describe('migração regional em PostgreSQL isolado (PGlite)', () => {
  async function legacyDatabase() {
    const db = await prepare();
    await db.exec(`
      INSERT INTO "City" (id, name, state, slug) VALUES ('city-to', 'Teófilo Otoni', 'MG', 'teofilo-otoni');
      INSERT INTO "Room" (id, "cityId", name, slug) VALUES ('original-id', 'city-to', 'Sala Geral', 'geral');
      INSERT INTO "User" (id, email, "passwordHash", "birthDate", "updatedAt") VALUES ('a', 'a@example.test', 'synthetic', '1990-01-01', NOW());
      INSERT INTO "RoomMessage" (id, "roomId", "userId", content)
        SELECT 'legacy-' || i, 'original-id', 'a', 'mensagem ' || i FROM generate_series(1,24) i;
    `);
    await db.exec(await migrationSql(regionalMigration));
    return db;
  }

  it('corrige o legado geral dentro da mesma cidade e mantém a duplicata desativada após repetir seed', async () => {
    const db = await legacyDatabase();
    try {
      const before = (await db.query('SELECT * FROM "RoomMessage" ORDER BY id')).rows;
      expect((await db.query('SELECT "publicSlug" FROM "Room" WHERE id = \'original-id\'')).rows).toEqual([{ publicSlug: null }]);
      await db.exec(await migrationSql(repair));
      await db.exec(await migrationSql(order));
      await db.exec(await migrationSql(cityRepair));
      await seedDatabase(db); await seedDatabase(db);
      expect((await db.query('SELECT id, slug, name, "publicSlug", active FROM "Room" WHERE "cityId" = \'city-to\' ORDER BY slug')).rows).toEqual([
        { id: 'cregionalroomteofilootoni', slug: 'conversa-geral', name: 'Conversa Geral', publicSlug: null, active: false },
        { id: 'original-id', slug: 'geral', name: 'Sala Geral', publicSlug: 'teofilo-otoni-mg', active: true }
      ]);
      expect(withoutPosition((await db.query('SELECT * FROM "RoomMessage" ORDER BY id')).rows)).toEqual(before);
      const catalog = await db.query('SELECT r.id, r."publicSlug" FROM "Room" r JOIN "City" c ON c.id = r."cityId" WHERE r.active AND c.active ORDER BY r."publicSlug"');
      expect(catalog.rows).toEqual([{ id: 'cregionalroommucuri', publicSlug: 'mucuri-ba' }, { id: 'original-id', publicSlug: 'teofilo-otoni-mg' }]);
      await expect(db.exec(`UPDATE "Room" SET "publicSlug" = 'teofilo-otoni-mg' WHERE id = 'cregionalroomteofilootoni'`)).rejects.toThrow(/unique/i);
      // Boundary ordering is strict even when a previous insert has a future timestamp.
      const boundary = (await db.query<{ after: number }>(`SELECT nextval('"RoomMessage_position_seq"') AS "after"`)).rows[0]!.after;
      await db.exec(`INSERT INTO "RoomMessage" (id, "roomId", "userId", content, "createdAt") VALUES ('after-entry', 'original-id', 'a', 'nova', '2000-01-01')`);
      expect((await db.query('SELECT id FROM "RoomMessage" WHERE "roomId" = $1 AND position > $2', ['original-id', boundary])).rows).toEqual([{ id: 'after-entry' }]);
    } finally { await db.close(); }
  }, 30_000);

  it.each([
    ['mensagens visíveis', `INSERT INTO "RoomMessage" (id, "roomId", "userId", content) VALUES ('unexpected', 'cregionalroomteofilootoni', 'a', 'preservar')`, /contains messages/],
    ['mensagens moderadas', `INSERT INTO "RoomMessage" (id, "roomId", "userId", content, "moderationStatus") VALUES ('unexpected', 'cregionalroomteofilootoni', 'a', 'preservar', 'HIDDEN')`, /contains messages/],
    ['mensagens inclusive excluídas', `INSERT INTO "RoomMessage" (id, "roomId", "userId", content, "deletedAt") VALUES ('unexpected', 'cregionalroomteofilootoni', 'a', 'preservar', NOW())`, /contains messages/],
    ['ID inesperado', `UPDATE "Room" SET id = 'another-room' WHERE slug = 'conversa-geral' AND "cityId" = 'city-to'`, /unexpected duplicate/],
    ['nome ambíguo', `UPDATE "Room" SET name = 'Outra sala' WHERE id = 'original-id'`, /ambiguous legacy/],
    ['endereço ambíguo', `UPDATE "Room" SET "publicSlug" = NULL WHERE id = 'cregionalroomteofilootoni'`, /unexpected duplicate/],
    ['endereço ocupado', `UPDATE "Room" SET "publicSlug" = NULL, active = false WHERE id = 'cregionalroomteofilootoni'; UPDATE "Room" SET "publicSlug" = 'teofilo-otoni-mg' WHERE id = 'cregionalroommucuri'`, /public address conflict/]
  ])('recusa %s com rollback integral; seed também recusa', async (_label, change, error) => {
    const db = await legacyDatabase();
    try {
      await db.exec(change as string);
      const before = (await db.query('SELECT * FROM "Room" ORDER BY id')).rows;
      const messages = (await db.query('SELECT * FROM "RoomMessage" ORDER BY id')).rows;
      await expect(db.exec(await migrationSql(repair))).rejects.toThrow(error as RegExp);
      await db.exec('ROLLBACK');
      expect((await db.query('SELECT * FROM "Room" ORDER BY id')).rows).toEqual(before);
      await expect(seedDatabase(db)).rejects.toThrow(/Seed regional/);
      expect((await db.query('SELECT * FROM "Room" ORDER BY id')).rows).toEqual(before);
      expect((await db.query('SELECT * FROM "RoomMessage" ORDER BY id')).rows).toEqual(messages);
    } finally { await db.close(); }
  }, 30_000);

  it('reverte também uma cidade já corrigida quando a segunda cidade é ambígua', async () => {
    const db = await legacyDatabase();
    try {
      await db.exec(`INSERT INTO "Room" (id, "cityId", name, slug) SELECT 'ambiguous-mucuri', id, 'Outra sala', 'geral' FROM "City" WHERE slug = 'mucuri'`);
      const before = (await db.query('SELECT * FROM "Room" ORDER BY id')).rows;
      await expect(db.exec(await migrationSql(repair))).rejects.toThrow(/ambiguous legacy/);
      await db.exec('ROLLBACK');
      expect((await db.query('SELECT * FROM "Room" ORDER BY id')).rows).toEqual(before);
      await expect(seedDatabase(db)).rejects.toThrow(/sala legada ambígua/);
      expect((await db.query('SELECT * FROM "Room" ORDER BY id')).rows).toEqual(before);
    } finally { await db.close(); }
  }, 30_000);

  it('aplica o histórico completo em banco vazio e cria as duas salas', async () => {
    const db = await prepare();
    try {
      await db.exec(await sql());
      await seedDatabase(db);
      await seedDatabase(db);
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
      await seedDatabase(db);
      await seedDatabase(db);
      for (const [i, table] of preserved.entries()) expect(withoutPosition((await db.query(`SELECT * FROM "${table}" ORDER BY "id"`)).rows)).toEqual(before[i]!.rows);
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


describe('correção entre cidades com IDs distintos — cenário real da VPS', () => {
  async function vpsDatabase() {
    const db = await prepare();
    await db.exec(`
      INSERT INTO "City" (id, name, state, slug) VALUES
        ('original-city-id', 'Teófilo Otoni', 'MG', 'teofilo-otoni-mg'),
        ('original-mucuri-id', 'Mucuri', 'BA', 'mucuri');
      INSERT INTO "Room" (id, "cityId", name, slug) VALUES
        ('original-room-id', 'original-city-id', 'Sala Geral', 'geral'),
        ('original-mucuri-room', 'original-mucuri-id', 'Conversa Geral', 'conversa-geral');
      INSERT INTO "User" (id, email, "passwordHash", "birthDate", "updatedAt") VALUES
        ('a', 'a@example.test', 'synthetic', '1990-01-01', NOW()), ('b', 'b@example.test', 'synthetic', '1990-01-01', NOW());
      INSERT INTO "UserProfile" (id, "userId", "cityId", nickname, "ageRange", interests, "updatedAt") VALUES
        ('original-profile', 'a', 'original-city-id', 'A', '25–34', '{}', NOW()),
        ('mucuri-profile', 'b', 'original-mucuri-id', 'B', '25–34', '{}', NOW());
      INSERT INTO "RoomMessage" (id, "roomId", "userId", content)
        SELECT 'legacy-' || i, 'original-room-id', 'a', 'mensagem ' || i FROM generate_series(1,24) i;
      INSERT INTO "RoomMessage" (id, "roomId", "userId", content) VALUES ('mucuri-message', 'original-mucuri-room', 'b', 'preservar Mucuri');
      INSERT INTO "PrivateConversation" (id, "participantOneId", "participantTwoId", "requestedById", status)
        VALUES ('private', 'a', 'b', 'a', 'ACCEPTED');
      INSERT INTO "PrivateMessage" (id, "conversationId", "senderId", kind, content)
        VALUES ('private-message', 'private', 'a', 'IMAGE', '');
      INSERT INTO "PrivateMedia" (id, "conversationId", "messageId", "authorId", "storageKey", "mimeType", "byteSize", width, height, "expiresAt")
        VALUES ('private-media', 'private', 'private-message', 'a', 'opaque-key', 'image/webp', 100, 10, 10, NOW() + INTERVAL '1 day');
    `);
    const history = await snapshot(db, ['User', 'UserProfile', 'RoomMessage', 'PrivateConversation', 'PrivateMessage', 'PrivateMedia']);
    for (const migration of [regionalMigration, repair, order]) await db.exec(await migrationSql(migration));
    // Prove the old repair completed without repairing this real scenario.
    expect((await db.query('SELECT "publicSlug" FROM "Room" WHERE id = \'original-room-id\'')).rows).toEqual([{ publicSlug: null }]);
    expect((await db.query('SELECT r.id, r."cityId", r.active, r."publicSlug" FROM "Room" r WHERE r.id = \'cregionalroomteofilootoni\'')).rows).toEqual([
      { id: 'cregionalroomteofilootoni', cityId: 'cregionalteofilootonimg001', active: true, publicSlug: 'teofilo-otoni-mg' }
    ]);
    for (const [table, rows] of Object.entries(history)) expect(withoutPosition((await db.query(`SELECT * FROM "${table}" ORDER BY id`)).rows)).toEqual(rows);
    return db;
  }

  async function snapshot(db: PGlite, tables = ['City', 'Room', 'User', 'UserProfile', 'RoomMessage', 'PrivateConversation', 'PrivateMessage', 'PrivateMedia']) {
    return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.query(`SELECT * FROM "${table}" ORDER BY id`)).rows])));
  }

  it.each(['migration', 'seed'])('preserva as 24 mensagens e todos os vínculos; %s primeiro, sequência completa e seed repetido', async first => {
    const db = await vpsDatabase();
    try {
      const before = await snapshot(db);
      if (first === 'seed') await seedDatabase(db);
      await db.exec(await migrationSql(cityRepair));
      const after = await snapshot(db);
      await seedDatabase(db); await seedDatabase(db);
      expect(await snapshot(db)).toEqual(after);
      for (const table of ['User', 'UserProfile', 'RoomMessage', 'PrivateConversation', 'PrivateMessage', 'PrivateMedia']) expect(after[table]).toEqual(before[table]);
      expect(after.City).toEqual(before.City.map((city: any) => city.id === 'cregionalteofilootonimg001' ? { ...city, active: false } : city));
      const originalBefore = before.Room.find((room: any) => room.id === 'original-room-id');
      expect(after.Room.find((room: any) => room.id === 'original-room-id')).toEqual({ ...originalBefore, publicSlug: 'teofilo-otoni-mg', updatedAt: expect.any(Date) });
      expect(after.Room.find((room: any) => room.id === 'original-mucuri-room')).toEqual(before.Room.find((room: any) => room.id === 'original-mucuri-room'));
      expect(after.Room.find((room: any) => room.id === 'cregionalroomteofilootoni')).toMatchObject({ cityId: 'cregionalteofilootonimg001', slug: 'conversa-geral', active: false, publicSlug: null });
      expect((await db.query('SELECT count(*)::int AS n FROM "RoomMessage" WHERE "roomId" = \'original-room-id\'')).rows).toEqual([{ n: 24 }]);
      expect((await db.query('SELECT c.id AS "cityId", c.slug AS "citySlug", r.id, r.slug, r."publicSlug" FROM "City" c JOIN "Room" r ON r."cityId" = c.id WHERE c.active AND r.active ORDER BY c.slug')).rows).toEqual([
        { cityId: 'original-mucuri-id', citySlug: 'mucuri', id: 'original-mucuri-room', slug: 'conversa-geral', publicSlug: 'mucuri-ba' },
        { cityId: 'original-city-id', citySlug: 'teofilo-otoni-mg', id: 'original-room-id', slug: 'geral', publicSlug: 'teofilo-otoni-mg' }
      ]);
      await expect(db.exec(`UPDATE "Room" SET "publicSlug" = 'teofilo-otoni-mg' WHERE id = 'cregionalroomteofilootoni'`)).rejects.toThrow(/unique/i);
    } finally { await db.close(); }
  }, 30_000);

  it('preserva a desativação original e salas legítimas vinculadas à cidade original', async () => {
    const db = await vpsDatabase();
    try {
      await db.exec(`UPDATE "City" SET active = false WHERE id = 'original-city-id'; UPDATE "Room" SET active = false WHERE id = 'original-room-id';
        INSERT INTO "Room" (id, "cityId", name, slug) VALUES ('legitimate-original', 'original-city-id', 'Cultura', 'cultura')`);
      await db.exec(await migrationSql(cityRepair));
      const after = await snapshot(db);
      await seedDatabase(db); await seedDatabase(db);
      expect(await snapshot(db)).toEqual(after);
      expect(after.City.find((city: any) => city.id === 'original-city-id')).toMatchObject({ active: false });
      expect(after.Room.find((room: any) => room.id === 'original-room-id')).toMatchObject({ active: false, publicSlug: 'teofilo-otoni-mg' });
      expect(after.Room.find((room: any) => room.id === 'legitimate-original')).toMatchObject({ active: true, cityId: 'original-city-id' });
    } finally { await db.close(); }
  }, 30_000);

  it.each([
    ['mensagem visível', `INSERT INTO "RoomMessage" (id, "roomId", "userId", content) VALUES ('conflict', 'cregionalroomteofilootoni', 'a', 'preservar')`, /contains messages/],
    ['mensagem excluída', `INSERT INTO "RoomMessage" (id, "roomId", "userId", content, "deletedAt") VALUES ('conflict', 'cregionalroomteofilootoni', 'a', 'preservar', NOW())`, /contains messages/],
    ['mensagem moderada', `INSERT INTO "RoomMessage" (id, "roomId", "userId", content, "moderationStatus") VALUES ('conflict', 'cregionalroomteofilootoni', 'a', 'preservar', 'HIDDEN')`, /contains messages/],
    ['perfil na duplicata', `UPDATE "UserProfile" SET "cityId" = 'cregionalteofilootonimg001' WHERE id = 'mucuri-profile'`, /has profiles/],
    ['outra sala ativa', `INSERT INTO "Room" (id, "cityId", name, slug) VALUES ('legitimate', 'cregionalteofilootonimg001', 'Cultura', 'cultura')`, /has other rooms/],
    ['outra sala inativa', `INSERT INTO "Room" (id, "cityId", name, slug, active) VALUES ('legitimate', 'cregionalteofilootonimg001', 'Cultura', 'cultura', false)`, /has other rooms/],
    ['identidade da cidade duplicada', `UPDATE "City" SET name = 'Outra cidade' WHERE id = 'cregionalteofilootonimg001'`, /duplicate city identity/],
    ['identidade da sala duplicada', `UPDATE "Room" SET id = 'unexpected-room-id' WHERE id = 'cregionalroomteofilootoni'`, /unexpected duplicate room/],
    ['identidade da cidade original', `UPDATE "City" SET state = 'BA' WHERE id = 'original-city-id'`, /ambiguous original city/],
    ['sala original ausente', `UPDATE "Room" SET slug = 'another' WHERE id = 'original-room-id'`, /ambiguous original Sala Geral/],
    ['terceira cidade', `INSERT INTO "City" (id, name, state, slug) VALUES ('third', 'Teófilo Otoni', 'MG', 'another')`, /additional city/],
    ['endereço ocupado', `UPDATE "Room" SET "publicSlug" = NULL, active = false WHERE id = 'cregionalroomteofilootoni'; UPDATE "Room" SET "publicSlug" = 'teofilo-otoni-mg' WHERE id = 'original-mucuri-room'`, /public address conflict/]
  ])('interrompe por %s e reverte integralmente migration e seed', async (_label, change, error) => {
    const db = await vpsDatabase();
    try {
      await db.exec(change as string);
      const before = await snapshot(db);
      await expect(db.exec(await migrationSql(cityRepair))).rejects.toThrow(error as RegExp);
      await db.exec('ROLLBACK');
      expect(await snapshot(db)).toEqual(before);
      await expect(seedDatabase(db)).rejects.toThrow(/Seed regional/);
      expect(await snapshot(db)).toEqual(before);
    } finally { await db.close(); }
  }, 30_000);
});
