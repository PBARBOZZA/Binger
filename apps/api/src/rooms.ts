import { prisma } from './db.js';

export const publicRoomSelect = {
  id: true, name: true, publicSlug: true, active: true, createdAt: true, updatedAt: true,
  city: { select: { id: true, slug: true, name: true, state: true } }
} as const;

// Explicit room required: never silently fall back to the first/default city.
export function findActiveRoom(reference: unknown) {
  if (typeof reference !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(reference)) return Promise.resolve(null);
  return prisma.room.findFirst({
    where: { OR: [{ id: reference }, { publicSlug: reference }], active: true, city: { active: true } },
    select: publicRoomSelect
  });
}

export function roomView(room: NonNullable<Awaited<ReturnType<typeof findActiveRoom>>>) {
  return {
    id: room.id, slug: room.publicSlug ?? room.id, name: room.name,
    cityId: room.city.id, citySlug: room.city.slug, city: room.city.name, state: room.city.state,
    isActive: room.active, createdAt: room.createdAt, updatedAt: room.updatedAt
  };
}
