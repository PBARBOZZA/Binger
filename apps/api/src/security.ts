import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from './db.js';
import { config } from './config.js';

export const SESSION_COOKIE = 'binger_session';
export const hash = (value: string, secret = config.SESSION_SECRET) =>
  crypto.createHmac('sha256', secret).update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const ipHash = (ip: string) => hash(ip, config.IP_HASH_SECRET);
export const cleanText = (value: string) => value.replace(/[<>]/g, '').replace(/\p{C}/gu, '').trim();
export const hasUrl = (value: string) => /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|br)\b)/i.test(value);

declare global {
  namespace Express { interface Request { auth?: { userId: string; role: string; sessionId: string } } }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return res.status(401).json({ error: 'Autenticação necessária.' });
  const session = await prisma.session.findUnique({ where: { tokenHash: hash(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE')
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  req.auth = { userId: session.userId, role: session.user.role, sessionId: session.id };
  next();
}

export const requireRole = (...roles: string[]) => (req: Request, res: Response, next: NextFunction) =>
  req.auth && roles.includes(req.auth.role) ? next() : res.status(403).json({ error: 'Acesso restrito.' });

export const cookieOptions = {
  httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax' as const,
  maxAge: 1000 * 60 * 60 * 24 * 14, path: '/'
};
