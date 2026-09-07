import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';
import { seedRegionalRooms } from '../src/seed-regional-rooms.js';

const prisma = new PrismaClient();

async function main() {
  await seedRegionalRooms(prisma);
  const email = process.env.DEV_ADMIN_EMAIL;
  const password = process.env.DEV_ADMIN_PASSWORD;
  if (email && password) {
    await prisma.user.upsert({
      where: { email: email.toLowerCase() },
      update: { role: Role.ADMIN },
      create: {
        email: email.toLowerCase(), passwordHash: await argon2.hash(password),
        birthDate: new Date('1990-01-01'), emailVerifiedAt: new Date(), ageVerifiedAt: new Date(), role: Role.ADMIN
      }
    });
  }
}

main().finally(() => prisma.$disconnect());
