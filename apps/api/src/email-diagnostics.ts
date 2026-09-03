export type EmailKind = 'verification' | 'password_reset';

const allowedErrorNames = new Set(['Error', 'TypeError']);
const allowedProviderCodes = new Set([
  'EAUTH', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'EENVELOPE',
  'EMESSAGE', 'ENOTFOUND', 'ESOCKET', 'ETIMEDOUT', 'EAI_AGAIN', 'SMTP_NOT_CONFIGURED'
]);
const allowedCommands = new Set(['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);

const allowlisted = (value: unknown, allowed: Set<string>) =>
  typeof value === 'string' && allowed.has(value) ? value : undefined;

export function emailFailureDiagnostic(kind: EmailKind, error: unknown) {
  const candidate = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  return {
    level: 'error',
    message: 'email_delivery_failed',
    kind,
    errorName: allowlisted(candidate.name, allowedErrorNames),
    providerCode: allowlisted(candidate.code, allowedProviderCodes),
    command: allowlisted(candidate.command, allowedCommands),
    responseCode: typeof candidate.responseCode === 'number' ? candidate.responseCode : undefined
  };
}

export function logEmailFailure(kind: EmailKind, error: unknown) {
  console.error(JSON.stringify(emailFailureDiagnostic(kind, error)));
}
