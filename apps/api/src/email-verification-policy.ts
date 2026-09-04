export const verificationResendPolicy = {
  requestWindowMs: 15 * 60_000,
  requestLimit: 5,
  accountCooldownMs: 5 * 60_000,
  tokenTtlMs: 24 * 60 * 60_000
} as const;

export const verificationResendResponse = () => ({
  message: 'Se houver uma conta não verificada para esse e-mail, enviaremos um novo código de confirmação.'
});
