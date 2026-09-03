import { z } from 'zod';

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
  DEV_EXPOSE_EMAIL_TOKENS: z.string().default('false')
}).superRefine((value, ctx) => {
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SMTP_USER e SMTP_PASSWORD devem ser configurados juntos.' });
  }
  if (value.NODE_ENV === 'production') {
    for (const key of ['EMAIL_TOKEN_SECRET', 'EMAIL_FROM', 'SMTP_HOST'] as const) {
      if (!value[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} é obrigatório em produção.` });
    }
  }
});

export const config = schema.parse(process.env);
