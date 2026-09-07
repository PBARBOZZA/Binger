import type { PrismaClient } from '@prisma/client';

export async function seedRegionalRooms(prisma: PrismaClient) {
  await prisma.$transaction(async tx => {
    // Same exclusion as the repair: no concurrent message/room write during inspection.
    await tx.$executeRawUnsafe('LOCK TABLE "City", "Room", "RoomMessage" IN SHARE ROW EXCLUSIVE MODE');
    for (const data of [
      { name: 'Teófilo Otoni', state: 'MG', slug: 'teofilo-otoni' },
      { name: 'Mucuri', state: 'BA', slug: 'mucuri' }
    ]) {
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
      if (original && duplicate) await tx.room.update({ where: { id: duplicate.id }, data: { active: false, publicSlug: null } });
      if (selected) await tx.room.update({ where: { id: selected.id }, data: { publicSlug: address } });
      else await tx.room.create({ data: { cityId: city.id, name: 'Conversa Geral', slug: 'conversa-geral', publicSlug: address } });
    }
  });
}
