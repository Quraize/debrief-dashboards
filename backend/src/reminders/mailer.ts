/**
 * Outbound email. One transport, SMTP, configured entirely from the
 * environment — Google Workspace by default (smtp.gmail.com:465 with an app
 * password on a dedicated mailbox). Nothing here knows what a debrief is.
 *
 * Secrets live only in the server's env file (deploy/.env.production), never
 * in code, chat, or anything VITE_-prefixed.
 */
import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  from: string;
  send(message: MailMessage): Promise<{ messageId: string }>;
}

export interface MailerConfig {
  configured: boolean;
  reason: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
}

/** What the environment says about sending mail. Never returns the password. */
export function mailerConfig(env: NodeJS.ProcessEnv = process.env): MailerConfig {
  const host = env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(env.SMTP_PORT || 465);
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465;
  const user = env.SMTP_USER || "";
  const from = env.SMTP_FROM || (user ? `Allied Debriefs <${user}>` : "");
  let reason = "";
  if (!user) reason = "SMTP_USER not set";
  else if (!env.SMTP_PASSWORD) reason = "SMTP_PASSWORD not set";
  else if (!Number.isInteger(port) || port <= 0) reason = "SMTP_PORT is not a valid port";
  return { configured: reason === "", reason, host, port, secure, user, from };
}

/** The real SMTP mailer, or null when the environment is not configured. */
export function createMailer(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  const cfg = mailerConfig(env);
  if (!cfg.configured) return null;
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: env.SMTP_PASSWORD },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    from: cfg.from,
    async send(message) {
      const info = await transport.sendMail({ from: cfg.from, ...message });
      return { messageId: String(info.messageId ?? "") };
    },
  };
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
