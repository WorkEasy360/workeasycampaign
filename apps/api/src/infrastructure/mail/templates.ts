import type { MailMessage } from './mailer.js';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#18181b">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e4e4e7">
<div style="font-weight:600;font-size:15px;color:#4338ca;margin-bottom:24px">Workeasy Campaign</div>
<h1 style="font-size:20px;margin:0 0 16px">${escape(title)}</h1>${bodyHtml}
</div></body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${escape(href)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">${escape(label)}</a></p>
<p style="font-size:13px;color:#71717a">Or paste this link into your browser:<br><span style="word-break:break-all">${escape(href)}</span></p>`;
}

export const Mail = {
  verifyEmail(to: string, name: string, link: string): MailMessage {
    return {
      to,
      tag: 'verify_email',
      link,
      subject: 'Confirm your email address',
      text: `Hi ${name},\n\nConfirm your email address to finish setting up Workeasy Campaign:\n${link}\n\nThis link expires in 24 hours. If you did not sign up, ignore this email.`,
      html: layout(
        'Confirm your email address',
        `<p>Hi ${escape(name)},</p><p>Confirm your email address to finish setting up your account.</p>${button(link, 'Confirm email')}<p style="font-size:13px;color:#71717a">This link expires in 24 hours. If you did not sign up, you can ignore this email.</p>`,
      ),
    };
  },

  accountAlreadyExists(to: string, loginLink: string, resetLink: string): MailMessage {
    return {
      to,
      tag: 'account_exists',
      link: loginLink,
      subject: 'You already have an account',
      text: `Someone (hopefully you) tried to sign up with this email, but an account already exists.\nSign in: ${loginLink}\nForgot your password? ${resetLink}`,
      html: layout(
        'You already have an account',
        `<p>Someone (hopefully you) tried to sign up with this email address, but an account already exists.</p>${button(loginLink, 'Sign in')}<p>Forgot your password? <a href="${escape(resetLink)}">Reset it</a>.</p>`,
      ),
    };
  },

  resetPassword(to: string, link: string): MailMessage {
    return {
      to,
      tag: 'reset_password',
      link,
      subject: 'Reset your password',
      text: `Use this link to choose a new password:\n${link}\n\nIt expires in 1 hour and can be used once. If you did not ask for this, ignore this email — your password has not changed.`,
      html: layout(
        'Reset your password',
        `<p>Use the button below to choose a new password.</p>${button(link, 'Choose a new password')}<p style="font-size:13px;color:#71717a">It expires in 1 hour and works once. If you did not ask for this, ignore this email — your password has not changed.</p>`,
      ),
    };
  },

  passwordChanged(to: string): MailMessage {
    return {
      to,
      tag: 'password_changed',
      subject: 'Your password was changed',
      text: 'Your Workeasy Campaign password was just changed and other sessions were signed out. If this was not you, reset your password immediately.',
      html: layout(
        'Your password was changed',
        '<p>Your password was just changed and your other sessions were signed out.</p><p>If this was not you, reset your password immediately.</p>',
      ),
    };
  },

  invitation(to: string, inviterName: string, orgName: string, link: string): MailMessage {
    return {
      to,
      tag: 'invitation',
      link,
      subject: `${inviterName} invited you to ${orgName}`,
      text: `${inviterName} invited you to join ${orgName} on Workeasy Campaign.\nAccept: ${link}\n\nThis invitation expires in 7 days.`,
      html: layout(
        `Join ${orgName}`,
        `<p>${escape(inviterName)} invited you to join <strong>${escape(orgName)}</strong> on Workeasy Campaign.</p>${button(link, 'Accept invitation')}<p style="font-size:13px;color:#71717a">This invitation expires in 7 days.</p>`,
      ),
    };
  },
};
