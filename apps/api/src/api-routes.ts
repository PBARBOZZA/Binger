import { Router } from 'express';
import { prisma } from './db.js';
import { cleanText, hasUrl, requireAuth, requireRole } from './security.js';
import { isParticipant } from './privacy.js';
import { messageSchema } from './validation.js';

export const apiRouter = Router();
apiRouter.get('/cities', async (_req, res) => {
  const cities = await prisma.city.findMany({ where: { active: true }, include: { rooms: { where: { active: true }, select: { id: true, name: true, slug: true } } }, orderBy: { name: 'asc' } });
  res.json(cities.map(city => ({ ...city, onlineCount: 0 })));
});

apiRouter.get('/rooms/:id/messages', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const room = await prisma.room.findFirst({ where: { id: String(req.params.id), active: true, city: { active: true, profiles: { some: { userId } } } } });
  if (!room) return res.status(404).json({ error: 'Sala indisponível.' });
  const [messages, blocks] = await Promise.all([
    prisma.roomMessage.findMany({ where: { roomId: room.id, deletedAt: null, moderationStatus: 'VISIBLE', OR: [{ scope: 'PUBLIC' }, { userId }, { recipientId: userId }] }, include: { user: { select: { id: true, profile: true } }, recipient: { select: { id: true, profile: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.userBlock.findMany({ where: { blockerId: userId }, select: { blockedUserId: true } })
  ]);
  const hidden = new Set(blocks.map(block => block.blockedUserId));
  res.json(messages.reverse().map(message => ({ ...message, blockedForMe: message.scope === 'PUBLIC' && hidden.has(message.userId) })));
});

apiRouter.get('/blocks', requireAuth, async (req, res) => {
  const blocks = await prisma.userBlock.findMany({ where: { blockerId: req.auth!.userId }, include: { blocked: { select: { id: true, profile: true } } }, orderBy: { createdAt: 'desc' } });
  res.json(blocks.map(block => ({ id: block.id, createdAt: block.createdAt, user: block.blocked })));
});
apiRouter.post('/blocks/:userId', requireAuth, async (req, res) => {
  const blockerId = req.auth!.userId; const blockedUserId = String(req.params.userId);
  if (blockedUserId === blockerId || !await prisma.user.findUnique({ where: { id: blockedUserId }, select: { id: true } })) return res.status(400).json({ error: 'Ação inválida.' });
  await prisma.$transaction(async tx => {
    await tx.userBlock.upsert({ where: { blockerId_blockedUserId: { blockerId, blockedUserId } }, update: {}, create: { blockerId, blockedUserId } });
    await tx.privateConversation.updateMany({ where: { status: { in: ['PENDING', 'ACCEPTED'] }, OR: [{ participantOneId: blockerId, participantTwoId: blockedUserId }, { participantOneId: blockedUserId, participantTwoId: blockerId }] }, data: { status: 'CLOSED', closedAt: new Date() } });
  });
  res.status(201).json({ message: 'Usuário bloqueado.' });
});
apiRouter.delete('/blocks/:userId', requireAuth, async (req, res) => {
  await prisma.userBlock.deleteMany({ where: { blockerId: req.auth!.userId, blockedUserId: String(req.params.userId) } });
  res.status(204).end();
});

apiRouter.post('/mutes/:userId', requireAuth, async (req, res) => {
  const muterId = req.auth!.userId; const mutedUserId = String(req.params.userId);
  if (muterId === mutedUserId) return res.status(400).json({ error: 'Ação inválida.' });
  await prisma.userMute.upsert({ where: { muterId_mutedUserId: { muterId, mutedUserId } }, update: {}, create: { muterId, mutedUserId } });
  res.status(201).json({ message: 'Usuário silenciado.' });
});
apiRouter.delete('/mutes/:userId', requireAuth, async (req, res) => {
  await prisma.userMute.deleteMany({ where: { muterId: req.auth!.userId, mutedUserId: String(req.params.userId) } });
  res.status(204).end();
});

apiRouter.get('/private-conversations', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const conversations = await prisma.privateConversation.findMany({ where: { OR: [{ participantOneId: userId }, { participantTwoId: userId }], status: { in: ['PENDING', 'ACCEPTED'] } }, include: { participantOne: { select: { id: true, profile: true } }, participantTwo: { select: { id: true, profile: true } }, messages: { where: { senderId: { not: userId }, readAt: null, deletedAt: null }, select: { id: true } } }, orderBy: { createdAt: 'desc' } });
  res.json(conversations.map(({ messages, ...conversation }) => ({ ...conversation, unreadCount: messages.length })));
});
apiRouter.get('/private-conversations/:id/messages', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const conversation = await prisma.privateConversation.findUnique({ where: { id: String(req.params.id) } });
  if (!conversation || conversation.status !== 'ACCEPTED' || !isParticipant(conversation, userId)) return res.status(404).json({ error: 'Conversa não encontrada.' });
  const messages = await prisma.$transaction(async tx => {
    const result = await tx.privateMessage.findMany({ where: { conversationId: conversation.id, deletedAt: null, moderationStatus: 'VISIBLE' }, include: { sender: { select: { id: true, profile: true } } }, orderBy: { createdAt: 'asc' }, take: 100 });
    await tx.privateMessage.updateMany({ where: { conversationId: conversation.id, senderId: { not: userId }, readAt: null }, data: { readAt: new Date() } });
    return result;
  });
  res.json(messages);
});
apiRouter.post('/private-conversations/:id/close', requireAuth, async (req, res) => {
  const conversation = await prisma.privateConversation.findUnique({ where: { id: String(req.params.id) } });
  if (!conversation || !isParticipant(conversation, req.auth!.userId)) return res.status(404).json({ error: 'Conversa não encontrada.' });
  await prisma.privateConversation.update({ where: { id: conversation.id }, data: { status: 'CLOSED', closedAt: new Date() } });
  res.status(204).end();
});

apiRouter.post('/reports', requireAuth, async (req, res) => {
  const { reportedUserId, roomMessageId, privateMessageId, reason, description } = req.body ?? {};
  if (typeof reportedUserId !== 'string' || typeof reason !== 'string' || reportedUserId === req.auth!.userId) return res.status(400).json({ error: 'Dados da denúncia inválidos.' });
  const priority = reason === 'MINOR_SUSPECTED' ? 'CRITICAL' : ['THREAT', 'FRAUD'].includes(reason) ? 'HIGH' : 'NORMAL';
  const report = await prisma.report.create({ data: { reporterId: req.auth!.userId, reportedUserId, roomMessageId, privateMessageId, reason: cleanText(reason).slice(0, 60), description: typeof description === 'string' ? cleanText(description).slice(0, 500) : null, priority } });
  res.status(201).json(report);
});
apiRouter.get('/moderation/reports', requireAuth, requireRole('MODERATOR', 'ADMIN'), async (_req, res) => res.json(await prisma.report.findMany({ include: { reporter: { select: { id: true, profile: true } }, reportedUser: { select: { id: true, profile: true } }, roomMessage: true, privateMessage: true }, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }] })));
apiRouter.patch('/admin/cities/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const city = await prisma.city.update({ where: { id: String(req.params.id) }, data: { active: Boolean(req.body?.active) } });
  await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'CITY_STATUS_CHANGED', targetType: 'City', targetId: city.id, metadata: { active: city.active } } }); res.json(city);
});
apiRouter.patch('/admin/rooms/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const room = await prisma.room.update({ where: { id: String(req.params.id) }, data: { active: Boolean(req.body?.active) } });
  await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'ROOM_STATUS_CHANGED', targetType: 'Room', targetId: room.id, metadata: { active: room.active } } }); res.json(room);
});

export function validateMessage(input: unknown) {
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) return { error: 'A mensagem deve ter entre 1 e 500 caracteres.' } as const;
  const content = cleanText(parsed.data.content);
  if (!content) return { error: 'A mensagem não pode estar vazia.' } as const;
  if (hasUrl(content)) return { error: 'Links não são permitidos no MVP.' } as const;
  return { content } as const;
}
