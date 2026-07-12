import { Router } from 'express';
import { prisma } from './db.js';
import { cleanText, hasUrl, requireAuth, requireRole } from './security.js';
import { messageSchema } from './validation.js';

export const apiRouter = Router();

apiRouter.get('/cities', async (_req, res) => {
  const cities = await prisma.city.findMany({ where: { active: true }, include: { rooms: { where: { active: true }, select: { id: true, name: true, slug: true } } }, orderBy: { name: 'asc' } });
  res.json(cities.map(city => ({ ...city, onlineCount: 0 })));
});
apiRouter.get('/rooms/:id/messages', requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const room = await prisma.room.findFirst({ where: { id, active: true, city: { active: true } } });
  if (!room) return res.status(404).json({ error: 'Sala indisponível.' });
  const messages = await prisma.roomMessage.findMany({ where: { roomId: room.id, deletedAt: null, moderationStatus: 'VISIBLE' }, include: { user: { select: { id: true, profile: true } } }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(messages.reverse());
});
apiRouter.post('/blocks/:userId', requireAuth, async (req, res) => {
  const blockedUserId = String(req.params.userId);
  if (blockedUserId === req.auth!.userId) return res.status(400).json({ error: 'Ação inválida.' });
  await prisma.block.upsert({ where: { blockerId_blockedUserId: { blockerId: req.auth!.userId, blockedUserId } }, update: {}, create: { blockerId: req.auth!.userId, blockedUserId } });
  res.status(201).json({ message: 'Usuário bloqueado.' });
});
apiRouter.post('/reports', requireAuth, async (req, res) => {
  const { reportedUserId, roomMessageId, privateMessageId, reason, description } = req.body ?? {};
  if (typeof reportedUserId !== 'string' || typeof reason !== 'string') return res.status(400).json({ error: 'Dados da denúncia inválidos.' });
  const priority = reason === 'MINOR_SUSPECTED' ? 'CRITICAL' : ['THREAT', 'FRAUD'].includes(reason) ? 'HIGH' : 'NORMAL';
  const report = await prisma.report.create({ data: { reporterId: req.auth!.userId, reportedUserId, roomMessageId, privateMessageId, reason, description: typeof description === 'string' ? cleanText(description).slice(0, 500) : null, priority } });
  res.status(201).json(report);
});
apiRouter.get('/moderation/reports', requireAuth, requireRole('MODERATOR', 'ADMIN'), async (_req, res) => {
  res.json(await prisma.report.findMany({ include: { reporter: { select: { id: true, profile: true } }, reportedUser: { select: { id: true, profile: true } }, roomMessage: true, privateMessage: true }, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }] }));
});
apiRouter.patch('/admin/cities/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const city = await prisma.city.update({ where: { id: String(req.params.id) }, data: { active: Boolean(req.body?.active) } });
  await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'CITY_STATUS_CHANGED', targetType: 'City', targetId: city.id, metadata: { active: city.active } } });
  res.json(city);
});
apiRouter.patch('/admin/rooms/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const room = await prisma.room.update({ where: { id: String(req.params.id) }, data: { active: Boolean(req.body?.active) } });
  await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'ROOM_STATUS_CHANGED', targetType: 'Room', targetId: room.id, metadata: { active: room.active } } });
  res.json(room);
});

export function validateMessage(input: unknown) {
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) return { error: 'A mensagem deve ter entre 1 e 500 caracteres.' } as const;
  const content = cleanText(parsed.data.content);
  if (!content) return { error: 'A mensagem não pode estar vazia.' } as const;
  if (hasUrl(content)) return { error: 'Links não são permitidos no MVP.' } as const;
  return { content } as const;
}
