import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  IP_HASH_SECRET: z.string().min(16),
  DEV_EXPOSE_EMAIL_TOKENS: z.string().default('false')
});

export const config = schema.parse(process.env);
