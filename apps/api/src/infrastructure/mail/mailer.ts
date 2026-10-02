import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Machine-readable tag (e.g. "verify_email") — used by the dev mailbox and E2E tests. */
  tag: string;
  /** The primary action link, if any (dev mailbox / E2E convenience). */
  link?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/** Development/test transport: writes each message as JSON so developers and E2E tests can follow links. */
export class FileMailer implements Mailer {
  private readonly logger = new Logger('FileMailer');
  constructor(private readonly dir: string) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${message.tag}.json`);
    await writeFile(file, JSON.stringify({ ...message, sentAt: new Date().toISOString() }, null, 2));
    this.logger.log(`[dev mail] ${message.tag} → ${message.to}${message.link ? ` ${message.link}` : ''}`);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(private readonly config: Extract<AppConfig['mail'], { transport: 'smtp' }>) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      requireTLS: config.port !== 465 && config.port !== 1025,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

export function mailerFactory(config: AppConfig): Mailer {
  return config.mail.transport === 'file' ? new FileMailer(config.mail.dir) : new SmtpMailer(config.mail);
}
