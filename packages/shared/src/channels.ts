export const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
