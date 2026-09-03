import nodemailer from 'nodemailer';
import { config } from './config.js';

const smtpConfigured = Boolean(config.EMAIL_FROM && config.SMTP_HOST);
const transporter = smtpConfigured ? nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: config.SMTP_USER && config.SMTP_PASSWORD
    ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
    : undefined,
  logger: false,
  debug: false
}) : null;

export const isEmailDeliveryConfigured = () => transporter !== null;

async function send(to: string, subject: string, text: string, html: string) {
  if (!transporter || !config.EMAIL_FROM) throw Object.assign(new Error('E-mail não configurado.'), { code: 'SMTP_NOT_CONFIGURED' });
  await transporter.sendMail({ from: config.EMAIL_FROM, to, subject, text, html });
}

export async function sendVerificationEmail(to: string, token: string) {
  await send(
    to,
    'Confirme seu e-mail no Binger',
    `Use este código para confirmar sua conta no Binger: ${token}\n\nO código expira em 24 horas.`,
    `<p>Use este código para confirmar sua conta no Binger:</p><p><strong>${token}</strong></p><p>O código expira em 24 horas.</p>`
  );
}

export async function sendPasswordResetEmail(to: string, token: string) {
  const resetUrl = new URL('/recuperar-senha', config.WEB_ORIGIN);
  resetUrl.hash = new URLSearchParams({ token }).toString();
  const link = resetUrl.toString();
  await send(
    to,
    'Redefina sua senha do Binger',
    `Recebemos uma solicitação para redefinir sua senha. Abra o link a seguir em até 30 minutos:\n\n${link}\n\nSe você não fez esta solicitação, ignore este e-mail.`,
    `<p>Recebemos uma solicitação para redefinir sua senha.</p><p><a href="${link}">Redefinir minha senha</a></p><p>Este link expira em 30 minutos e funciona uma única vez.</p><p>Se você não fez esta solicitação, ignore este e-mail.</p>`
  );
}
