export * from './adapter.js';
export * from './registry.js';
export { classifySmtpError, SmtpEmailAdapter, type SmtpOptions } from './email/smtp.js';
export { MAILGUN_WEBHOOK_MAX_AGE_SECONDS, MailgunEmailAdapter, type MailgunOptions } from './email/mailgun.js';
export { TwilioSmsAdapter, type TwilioOptions } from './sms/twilio.js';
export { MetaWhatsAppAdapter, type MetaWhatsAppOptions, WHATSAPP_MARKETING_OPT_OUT_CODE } from './whatsapp/meta.js';
