import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';

const MAIL_DIR = resolve(import.meta.dirname, '../.mail');

interface Mail {
  to: string;
  tag: string;
  link?: string;
  subject: string;
}

/** Waits for the newest email of `tag` sent to `to` and returns its action link as a path (/verify-email?token=…). */
export async function linkFromMail(to: string, tag: string): Promise<string> {
  let found: Mail | undefined;
  await expect
    .poll(
      () => {
        if (!existsSync(MAIL_DIR)) return false;
        const mails = readdirSync(MAIL_DIR)
          .filter((f) => f.endsWith(`-${tag}.json`))
          .sort()
          .map((f) => JSON.parse(readFileSync(join(MAIL_DIR, f), 'utf8')) as Mail)
          .filter((m) => m.to.toLowerCase() === to.toLowerCase());
        found = mails.at(-1);
        return !!found;
      },
      { message: `waiting for ${tag} email to ${to}`, timeout: 15_000 },
    )
    .toBe(true);
  const url = new URL(found!.link!);
  return `${url.pathname}${url.search}`;
}
