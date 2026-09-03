import { Router } from 'express';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import { ageOn, ageVerificationProvider } from './age-verification.js';
import { prisma } from './db.js';
import { config } from './config.js';
import { cookieOptions, emailTokenHash, emailTokenHashCandidates, hash, ipHash, randomToken, requireAuth, SESSION_COOKIE } from './security.js';
import { forgotPasswordSchema, loginSchema, profileSchema, registerSchema, resetPasswordSchema } from './validation.js';
import { isEmailDeliveryConfigured, sendPasswordResetEmail, sendVerificationEmail } from './mailer.js';
import { logEmailFailure } from './email-diagnostics.js';
import { passwordResetCompletedResponse, passwordResetRequestResponse } from './password-reset-policy.js';

export const authRouter = Router();
const termsVersion = '2026-07-12';
const resetRequestLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

async function waitForMinimumResponseTime(startedAt: number) {
  const remaining = 500 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const data = parsed.data;
  if (ageOn(data.birthDate) < 18) return res.status(403).json({ error: 'Serviço exclusivo para maiores de 18 anos.' });
  if (await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } })) return res.status(409).json({ error: 'E-mail já cadastrado.' });
  const user = await prisma.user.create({ data: {
    email: data.email.toLowerCase(), passwordHash: await argon2.hash(data.password), birthDate: data.birthDate,
    terms: { create: [
      { documentType: 'TERMS', documentVersion: termsVersion, ipHash: ipHash(req.ip ?? '') },
      { documentType: 'PRIVACY', documentVersion: termsVersion, ipHash: ipHash(req.ip ?? '') }
    ] }
  } });
  const token = randomToken();
  await prisma.emailToken.create({ data: { userId: user.id, purpose: 'VERIFY_EMAIL', tokenHash: emailTokenHash(token), expiresAt: new Date(Date.now() + 86400000) } });
  if (isEmailDeliveryConfigured()) {
    try {
      await sendVerificationEmail(user.email, token);
    } catch (error) {
      logEmailFailure('verification', error);
    }
  }
  res.status(201).json({ message: 'Conta criada. Confirme seu e-mail.', ...(config.NODE_ENV !== 'production' && config.DEV_EXPOSE_EMAIL_TOKENS === 'true' ? { developmentToken: token } : {}) });
});

authRouter.post('/verify-email', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const record = await prisma.emailToken.findFirst({ where: { tokenHash: { in: emailTokenHashCandidates(token) }, purpose: 'VERIFY_EMAIL' } });
  if (!record || record.usedAt || record.expiresAt <= new Date()) return res.status(400).json({ error: 'Token inválido ou expirado.' });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
  const result = await ageVerificationProvider.verify({ birthDate: user.birthDate, adultDeclaration: true, emailVerified: true });
  if (!result.approved) return res.status(403).json({ error: result.reason });
  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), ageVerifiedAt: new Date() } })
  ]);
  res.json({ message: 'E-mail e maioridade confirmados.' });
});

authRouter.post('/forgot-password', resetRequestLimiter, async (req, res) => {
  const startedAt = Date.now();
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Informe um e-mail válido.' });

  const user = await prisma.user.findFirst({
    where: { email: parsed.data.email.toLowerCase(), status: 'ACTIVE', deletedAt: null, emailVerifiedAt: { not: null } },
    select: { id: true, email: true }
  });

  if (user) {
    const token = randomToken();
    const record = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`password-reset:${user.id}`}, 0))`;
      const recentRequest = await tx.emailToken.findFirst({
        where: {
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          usedAt: null,
          createdAt: { gt: new Date(Date.now() - 5 * 60_000) }
        },
        select: { id: true }
      });
      if (recentRequest) return null;

      const now = new Date();
      await tx.emailToken.updateMany({
        where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: now }
      });
      return tx.emailToken.create({
        data: {
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          tokenHash: emailTokenHash(token),
          expiresAt: new Date(now.getTime() + 30 * 60_000)
        },
        select: { id: true }
      });
    });

    if (record) {
      try {
        await sendPasswordResetEmail(user.email, token);
      } catch (error) {
        logEmailFailure('password_reset', error);
        await prisma.emailToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      }
    }
  }

  await waitForMinimumResponseTime(startedAt);
  res.status(202).json(passwordResetRequestResponse());
});

authRouter.post('/reset-password', resetRequestLimiter, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Token ou nova senha inválidos.' });

  const tokenHash = emailTokenHash(parsed.data.token);
  const record = await prisma.emailToken.findFirst({
    where: { tokenHash, purpose: 'PASSWORD_RESET' },
    include: { user: { select: { id: true, status: true, deletedAt: true } } }
  });
  const now = new Date();
  if (!record || record.usedAt || record.expiresAt <= now || record.user.status !== 'ACTIVE' || record.user.deletedAt) {
    return res.status(400).json({ error: 'Token inválido ou expirado.' });
  }

  const passwordHash = await argon2.hash(parsed.data.password);
  try {
    await prisma.$transaction(async tx => {
      const consumed = await tx.emailToken.updateMany({
        where: { id: record.id, purpose: 'PASSWORD_RESET', usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now }
      });
      if (consumed.count !== 1) throw new Error('RESET_TOKEN_ALREADY_CONSUMED');

      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, sessionVersion: { increment: 1 } }
      });
      await tx.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now }
      });
      await tx.emailToken.updateMany({
        where: { userId: record.userId, purpose: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: now }
      });
      await tx.auditLog.create({
        data: { action: 'PASSWORD_RESET_COMPLETED', targetType: 'User', targetId: record.userId, metadata: {} }
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'RESET_TOKEN_ALREADY_CONSUMED') {
      return res.status(400).json({ error: 'Token inválido ou expirado.' });
    }
    throw error;
  }

  res.json(passwordResetCompletedResponse());
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Credenciais inválidas.' });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (!user || !(await argon2.verify(user.passwordHash, parsed.data.password))) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  if (!user.emailVerifiedAt) {
    return res.status(403).json({
      error: 'Confirme o e-mail antes de entrar.'
    });
  }

  if (!user.ageVerifiedAt) {
    return res.status(403).json({
      error: 'Confirme sua maioridade antes de entrar.'
    });
  }
  const token = randomToken();
  await prisma.session.create({ data: { userId: user.id, tokenHash: hash(token), ipHash: ipHash(req.ip ?? ''), userAgent: req.get('user-agent'), expiresAt: new Date(Date.now() + cookieOptions.maxAge) } });
  res.cookie(SESSION_COOKIE, token, cookieOptions).json({ user: { id: user.id, email: user.email, role: user.role, profileComplete: Boolean(await prisma.userProfile.findUnique({ where: { userId: user.id } })) } });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  await prisma.session.update({ where: { id: req.auth!.sessionId }, data: { revokedAt: new Date() } });
  res.clearCookie(SESSION_COOKIE, cookieOptions).status(204).end();
});
authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await prisma.session.updateMany({ where: { userId: req.auth!.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  res.clearCookie(SESSION_COOKIE, cookieOptions).status(204).end();
});
authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, include: { profile: { include: { city: true } } } });
  res.json({ id: user.id, email: user.email, role: user.role, emailVerified: !!user.emailVerifiedAt, ageVerified: !!user.ageVerifiedAt, profile: user.profile });
});
authRouter.put('/profile', requireAuth, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const city = await prisma.city.findFirst({ where: { id: parsed.data.cityId, active: true } });
  if (!city) return res.status(404).json({ error: 'Cidade indisponível.' });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  const age = ageOn(user.birthDate);
  const ageRange = age < 25 ? '18–24' : age < 35 ? '25–34' : age < 45 ? '35–44' : age < 55 ? '45–54' : '55+';
  const profile = await prisma.userProfile.upsert({ where: { userId: user.id }, update: parsed.data, create: { ...parsed.data, userId: user.id, ageRange } });
  res.json(profile);
});
