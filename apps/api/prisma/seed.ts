import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const cities = [
    { name: 'Teófilo Otoni', state: 'MG', slug: 'teofilo-otoni' },
    { name: 'Mucuri', state: 'BA', slug: 'mucuri' }
  ];
  for (const cityData of cities) {
    const city = await prisma.city.upsert({ where: { slug: cityData.slug }, update: cityData, create: cityData });
    await prisma.room.upsert({
      where: { cityId_slug: { cityId: city.id, slug: 'conversa-geral' } },
      update: { name: 'Conversa Geral', active: true },
      create: { cityId: city.id, name: 'Conversa Geral', slug: 'conversa-geral' }
    });
  }
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
