import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verificationResendPolicy, verificationResendResponse } from './email-verification-policy.js';
import { resendVerificationSchema } from './validation.js';

describe('reenvio de confirmação de e-mail', () => {
  it('valida o e-mail sem aceitar campos inválidos', () => {
    expect(resendVerificationSchema.safeParse({ email: 'pessoa@example.com' }).success).toBe(true);
    expect(resendVerificationSchema.safeParse({ email: 'invalido' }).success).toBe(false);
  });

  it('usa uma resposta genérica que não expõe tokens nem a existência da conta', () => {
    const response = verificationResendResponse();
    expect(response).toEqual({
      message: 'Se houver uma conta não verificada para esse e-mail, enviaremos um novo código de confirmação.'
    });
    expect(response).not.toHaveProperty('token');
    expect(response.message).toContain('Se houver');
  });

  it('define limites por IP e por conta', () => {
    expect(verificationResendPolicy).toMatchObject({
      requestWindowMs: 15 * 60_000,
      requestLimit: 5,
      accountCooldownMs: 5 * 60_000,
      tokenTtlMs: 24 * 60 * 60_000
    });
  });

  it('expõe as duas opções solicitadas na tela de login', () => {
    const authSource = readFileSync(new URL('../../web/src/Auth.tsx', import.meta.url), 'utf8');
    expect(authSource).toContain('to="/recuperar-senha">Esqueci minha senha?</Link>');
    expect(authSource).toContain('>Reenviar confirmação de e-mail</button>');
  });
});
