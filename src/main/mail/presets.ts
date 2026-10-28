import type { MailPreset, MailSettings } from '../../shared/types'

export const MAIL_PRESETS: Record<Exclude<MailPreset, 'other'>, Omit<MailSettings, 'address' | 'preset'>> = {
  gmail: { smtpHost: 'smtp.gmail.com', smtpPort: 465, imapHost: 'imap.gmail.com', imapPort: 993, sentMailbox: '[Gmail]/Sent Mail' },
  zoho: { smtpHost: 'smtp.zoho.com', smtpPort: 465, imapHost: 'imap.zoho.com', imapPort: 993, sentMailbox: 'Sent' },
  zoho_in: { smtpHost: 'smtp.zoho.in', smtpPort: 465, imapHost: 'imap.zoho.in', imapPort: 993, sentMailbox: 'Sent' }
}

// Google Workspace custom domains aren't detectable from the address; those users pick gmail manually.
export function presetForAddress(address: string): MailPreset {
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase()
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail'
  if (domain === 'zoho.com') return 'zoho'
  if (domain === 'zoho.in') return 'zoho_in'
  return 'other'
}
