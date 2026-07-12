import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(254), password: z.string().min(10).max(128),
  birthDate: z.coerce.date(), adultDeclaration: z.literal(true), acceptTerms: z.literal(true), acceptPrivacy: z.literal(true)
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const profileSchema = z.object({
  cityId: z.string().cuid(), nickname: z.string().trim().min(3).max(24)
    .regex(/^[\p{L}\p{N}_ -]+$/u, 'Use letras, números, espaço, hífen ou sublinhado.'),
  interests: z.array(z.string().trim().min(1).max(30)).max(8).default([])
}).refine(v => !/(admin|administrador|moderador|suporte|oficial)/i.test(v.nickname), { message: 'Apelido reservado.' });
export const messageSchema = z.object({ content: z.string().trim().min(1).max(500) });
