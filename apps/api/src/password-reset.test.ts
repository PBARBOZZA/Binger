import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { emailFailureDiagnostic, logEmailFailure } from './email-diagnostics.js';
import { forgotPasswordSchema, resetPasswordSchema } from './validation.js';
import { passwordResetCompletedResponse, passwordResetRequestResponse } from './password-reset-policy.js';

describe('recuperação de senha', () => {
  it('valida o formato do e-mail informado', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'pessoa@example.com' }).success).toBe(true);
    expect(forgotPasswordSchema.safeParse({ email: 'invalido' }).success).toBe(false);
  });

  it('aplica à nova senha a mesma faixa de tamanho usada no cadastro', () => {
    const token = 'a'.repeat(43);
    expect(resetPasswordSchema.safeParse({ token, password: 'curta' }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token, password: 'uma-senha-segura' }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token, password: 'a'.repeat(129) }).success).toBe(false);
  });

  it('não inclui o token nas respostas da API de recuperação', () => {
    expect(passwordResetRequestResponse()).toEqual({
      message: 'Se houver uma conta elegível para esse e-mail, enviaremos as instruções de recuperação.'
    });
    expect(passwordResetCompletedResponse()).toEqual({
      message: 'Senha redefinida. Entre novamente com sua nova senha.'
    });
    expect(passwordResetRequestResponse()).not.toHaveProperty('token');
    expect(passwordResetCompletedResponse()).not.toHaveProperty('token');
  });

  it('remove conteúdo sensível do diagnóstico de falha SMTP', () => {
    const diagnostic = emailFailureDiagnostic('password_reset', {
      name: 'Error',
      code: 'ETIMEDOUT',
      command: 'CONN',
      responseCode: 421,
      message: 'credential-value token-value pessoa@example.com',
      response: 'credential-value token-value pessoa@example.com'
    });
    const serialized = JSON.stringify(diagnostic);
    expect(diagnostic).toMatchObject({ message: 'email_delivery_failed', providerCode: 'ETIMEDOUT', responseCode: 421 });
    expect(serialized).not.toContain('credential-value');
    expect(serialized).not.toContain('token-value');
    expect(serialized).not.toContain('pessoa@example.com');
  });

  it('omite campos técnicos fora das listas permitidas', () => {
    const diagnostic = emailFailureDiagnostic('verification', {
      name: 'credentialvalue',
      code: 'tokenvalue',
      command: 'pessoa@example.com'
    });
    expect(diagnostic.errorName).toBeUndefined();
    expect(diagnostic.providerCode).toBeUndefined();
    expect(diagnostic.command).toBeUndefined();
  });

  it('não encaminha a mensagem bruta da falha para o log', () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logEmailFailure('password_reset', {
      code: 'ETIMEDOUT',
      message: 'credential-value token-value pessoa@example.com'
    });
    const serialized = String(logger.mock.calls[0]?.[0]);
    expect(serialized).toContain('email_delivery_failed');
    expect(serialized).not.toContain('credential-value');
    expect(serialized).not.toContain('token-value');
    expect(serialized).not.toContain('pessoa@example.com');
    logger.mockRestore();
  });

  it('mantém a migration sem operações destrutivas sobre dados', () => {
    const migration = readFileSync(new URL('../prisma/migrations/20260903190000_password_reset/migration.sql', import.meta.url), 'utf8');
    expect(migration).not.toMatch(/^\s*(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE)\b/im);
    expect(migration).toContain('ALTER COLUMN "purpose" TYPE "EmailTokenPurpose"');
    expect(migration).toContain('FOREIGN KEY ("userId") REFERENCES "User"("id")');
  });
});
