import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config.js";

export interface SendResult {
  sent: boolean;
  reason?: string;
}

let transport: Transporter | null = null;

// Lazy and re-checked on every call rather than cached at boot, so setting
// SMTP_* in .env and redeploying picks it up without any other code change -
// no separate "is mail configured" flag to keep in sync.
function getTransport(): Transporter | null {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      ...(config.smtp.tlsServername ? { tls: { servername: config.smtp.tlsServername } } : {}),
    });
  }
  return transport;
}

export async function sendMail(subject: string, text: string): Promise<SendResult> {
  const t = getTransport();
  if (!t) return { sent: false, reason: "SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing)" };
  await t.sendMail({ from: config.smtp.user, to: config.digest.to, subject, text });
  return { sent: true };
}
