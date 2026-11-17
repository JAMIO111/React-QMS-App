/**
 * The few facts the site needs from outside it. Change them here (or with PUBLIC_ environment variables on
 * the Vercel project) and every page follows.
 */
const env = import.meta.env;

/** Where the product lives. The navbar button and every "start" button go here. */
export const APP_URL: string = (env.PUBLIC_APP_URL || 'https://app.fortress-qms.com').replace(/\/$/, '');
export const LOGIN_URL = `${APP_URL}/login`;
export const SIGNUP_URL = `${APP_URL}/signup`;

/** The address the contact page and the legal pages give out. It must be a real mailbox. */
export const CONTACT_EMAIL: string = env.PUBLIC_CONTACT_EMAIL || 'hello@fortress-qms.com';

export const SITE_NAME = 'Fortress QMS';
export const SITE_URL = 'https://fortress-qms.com';
export const TAGLINE = 'Quality management for manufacturing';
export const TRIAL_DAYS = 14;

/**
 * Who runs the service, for the terms and privacy policy. Fill these in before the site goes live: while a
 * value is empty the legal pages show a visible "to be added" marker and the build says so.
 */
export const COMPANY = {
  legalName: env.PUBLIC_COMPANY_NAME || '',
  registeredAddress: env.PUBLIC_COMPANY_ADDRESS || '',
  companyNumber: env.PUBLIC_COMPANY_NUMBER || '',
  country: 'England and Wales',
};

/** Month and year shown on the legal pages and in the footer's revision box. */
export const LEGAL_UPDATED = '17 November 2026';
export const REVISION = '2026-11';

export const NAV = [
  { href: '/#modules', label: 'Product' },
  { href: '/help', label: 'Help' },
  { href: '/faq', label: 'FAQ' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

/**
 * The terms, privacy and cookie texts are drafts until a solicitor has reviewed them. While this is false the
 * legal pages say so on the page. Set PUBLIC_LEGAL_REVIEWED=true on the Vercel project once they are signed off.
 */
export const LEGAL_REVIEWED: boolean = env.PUBLIC_LEGAL_REVIEWED === 'true';
