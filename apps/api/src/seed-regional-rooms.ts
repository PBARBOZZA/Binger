import type { Prisma, PrismaClient } from '@prisma/client';

// Recognize the original city BEFORE upserting the alias used by the old seed.
// Keep these checks aligned with 20260908120000_repair_regional_city_alias.
async function seedOriginalTeofiloCity(tx: Prisma.TransactionClient) {
  const originalCity = await tx.city.findUnique({ where: { slug: 'teofilo-otoni-mg' } });
  if (!originalCity) return false;
  const fail = (detail: string): never => { throw new Error(`Seed regional: teofilo-otoni-mg: ${detail}. Preserve os vínculos e revise manualmente.`); };
  if (originalCity.name !== 'Teófilo Otoni' || originalCity.state !== 'MG') fail('cidade original ambígua');
  if (await tx.city.count({ where: { name: 'Teófilo Otoni', state: 'MG', slug: { notIn: ['teofilo-otoni-mg', 'teofilo-otoni'] } } })) fail('cadastro adicional da cidade');
  const original = await tx.room.findUnique({ where: { cityId_slug: { cityId: originalCity.id, slug: 'geral' } } });
  if (!original || original.name !== 'Sala Geral' || (original.publicSlug !== null && original.publicSlug !== 'teofilo-otoni-mg')) return fail('Sala Geral original ausente ou ambígua');
  const duplicateCity = await tx.city.findUnique({ where: { slug: 'teofilo-otoni' } });
  let duplicate: Awaited<ReturnType<typeof tx.room.findUnique>> = null;
  if (duplicateCity) {
    if (duplicateCity.id !== 'cregionalteofilootonimg001' || duplicateCity.name !== 'Teófilo Otoni' || duplicateCity.state !== 'MG') fail('identidade da cidade duplicada inesperada');
    duplicate = await tx.room.findUnique({ where: { cityId_slug: { cityId: duplicateCity.id, slug: 'conversa-geral' } } });
    if (!duplicate || duplicate.id !== 'cregionalroomteofilootoni' || duplicate.name !== 'Conversa Geral'
      || !(duplicate.publicSlug === 'teofilo-otoni-mg' || (duplicate.publicSlug === null && !duplicate.active))) return fail('sala duplicada ausente ou inesperada');
    if (await tx.roomMessage.count({ where: { roomId: duplicate.id } })) fail('sala duplicada contém mensagens, inclusive excluídas ou moderadas');
    if (await tx.userProfile.count({ where: { cityId: duplicateCity.id } })) fail('cidade duplicada possui perfis');
    if (await tx.room.count({ where: { cityId: duplicateCity.id, id: { not: duplicate.id } } })) fail('cidade duplicada possui outras salas');
  }
  const owner = await tx.room.findUnique({ where: { publicSlug: 'teofilo-otoni-mg' } });
  if (owner && owner.id !== original.id && owner.id !== duplicate?.id) fail('endereço público ocupado');
  if (duplicate && (duplicate.active || duplicate.publicSlug !== null)) await tx.room.update({ where: { id: duplicate.id }, data: { active: false, publicSlug: null } });
  if (duplicateCity?.active) await tx.city.update({ where: { id: duplicateCity.id }, data: { active: false } });
  if (original.publicSlug !== 'teofilo-otoni-mg') await tx.room.update({ where: { id: original.id }, data: { publicSlug: 'teofilo-otoni-mg' } });
  return true;
}

export async function seedRegionalRooms(prisma: PrismaClient) {
  await prisma.$transaction(async tx => {
    // Same exclusion as the repair: no concurrent message/room write during inspection.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    await tx.$executeRawUnsafe('LOCK TABLE "City", "Room", "UserProfile", "RoomMessage" IN SHARE ROW EXCLUSIVE MODE');
    const hasOriginalTeofilo = await seedOriginalTeofiloCity(tx);
    for (const data of [
      { name: 'Teófilo Otoni', state: 'MG', slug: 'teofilo-otoni' },
      { name: 'Mucuri', state: 'BA', slug: 'mucuri' }
    ]) {
      if (data.slug === 'teofilo-otoni' && hasOriginalTeofilo) continue;
      const city = await tx.city.upsert({ where: { slug: data.slug }, update: {}, create: data });
      const fail = (detail: string): never => { throw new Error(`Seed regional: ${data.slug}: ${detail}. Revise os dados manualmente.`); };
      if (city.state !== data.state) fail('estado inesperado');
      const address = `${data.slug}-${data.state.toLowerCase()}`;
      const rooms = await tx.room.findMany({ where: { cityId: city.id } });
      const original = rooms.find(room => room.slug === 'geral');
      const duplicate = rooms.find(room => room.slug === 'conversa-geral');
      const selected = original ?? duplicate;
      if (original) {
        if (original.name !== 'Sala Geral' || (original.publicSlug !== null && original.publicSlug !== address)) fail('sala legada ambígua');
        if (duplicate) {
          if (duplicate.id !== `cregionalroom${data.slug.replaceAll('-', '')}` || duplicate.name !== 'Conversa Geral'
            || !(duplicate.publicSlug === address || (duplicate.publicSlug === null && !duplicate.active))) fail('duplicata inesperada');
          if (await tx.roomMessage.count({ where: { roomId: duplicate.id } })) fail('duplicata contém mensagens, inclusive excluídas ou moderadas');
        }
      }
      const owner = await tx.room.findUnique({ where: { publicSlug: address } });
      if (owner && owner.id !== selected?.id && !(original && owner.id === duplicate?.id)) fail('endereço público ocupado');
      if (selected?.publicSlug && selected.publicSlug !== address) fail('endereço da sala inesperado');
      if (original && duplicate && (duplicate.active || duplicate.publicSlug !== null)) await tx.room.update({ where: { id: duplicate.id }, data: { active: false, publicSlug: null } });
      if (selected) {
        if (selected.publicSlug !== address) await tx.room.update({ where: { id: selected.id }, data: { publicSlug: address } });
      }
      else await tx.room.create({ data: { cityId: city.id, name: 'Conversa Geral', slug: 'conversa-geral', publicSlug: address } });
    }
  }, { timeout: 30_000 });
}
