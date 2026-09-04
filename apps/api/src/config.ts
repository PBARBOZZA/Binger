import { z } from 'zod';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const defaultPrivateMediaRoot = join(tmpdir(), 'binger-private-media');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  IP_HASH_SECRET: z.string().min(16),
  EMAIL_TOKEN_SECRET: z.string().min(32).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  DEV_EXPOSE_EMAIL_TOKENS: z.string().default('false'),
  PRIVATE_MEDIA_ROOT: z.string().min(1).default(defaultPrivateMediaRoot),
  PRIVATE_MEDIA_MAX_BYTES: z.coerce.number().int().min(16 * 1024).max(20 * 1024 * 1024).default(262_144),
  PRIVATE_MEDIA_MAX_WIDTH: z.coerce.number().int().min(1).max(8_192).default(1_600),
  PRIVATE_MEDIA_MAX_HEIGHT: z.coerce.number().int().min(1).max(8_192).default(1_600),
  PRIVATE_MEDIA_MAX_PIXELS: z.coerce.number().int().min(1).max(32_000_000).default(2_560_000),
  PRIVATE_MEDIA_RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(24),
  PRIVATE_MESSAGE_DELETE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
  PRIVATE_MEDIA_USER_LIMIT: z.coerce.number().int().min(1).max(60).default(6),
  PRIVATE_MEDIA_CONVERSATION_LIMIT: z.coerce.number().int().min(1).max(60).default(12),
  PRIVATE_MEDIA_IP_LIMIT: z.coerce.number().int().min(1).max(120).default(10)
}).superRefine((value, ctx) => {
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SMTP_USER e SMTP_PASSWORD devem ser configurados juntos.' });
  }
  if (value.NODE_ENV === 'production') {
    for (const key of ['EMAIL_TOKEN_SECRET', 'EMAIL_FROM', 'SMTP_HOST'] as const) {
      if (!value[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} é obrigatório em produção.` });
    }
    if (value.PRIVATE_MEDIA_ROOT === defaultPrivateMediaRoot) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PRIVATE_MEDIA_ROOT'], message: 'PRIVATE_MEDIA_ROOT é obrigatório em produção.' });
    }
    const mediaRoot = resolve(value.PRIVATE_MEDIA_ROOT);
    const workingDirectory = resolve(process.cwd());
    const mediaRootRelativeToWorkingDirectory = relative(workingDirectory, mediaRoot);
    if (!isAbsolute(value.PRIVATE_MEDIA_ROOT) || !mediaRootRelativeToWorkingDirectory || (!mediaRootRelativeToWorkingDirectory.startsWith('..') && !isAbsolute(mediaRootRelativeToWorkingDirectory))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PRIVATE_MEDIA_ROOT'], message: 'PRIVATE_MEDIA_ROOT deve ser absoluto e ficar fora do diretório da aplicação em produção.' });
    }
  }
});

export const config = schema.parse(process.env);
