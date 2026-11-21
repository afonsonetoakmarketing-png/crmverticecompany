// ============================================================
// Hybrid backend mode detection (isomorphic — Edge, Server, Client).
//
// When NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are
// present, the application uses Supabase natively (100% production
// behavior for Vercel / Docker / GitHub deployments).
//
// When those environment variables are absent (e.g. local preview or
// sandbox before connecting Supabase), the app transparently runs on
// the built-in local hybrid backend so login, signup, CRM screens,
// and backend configuration panels work immediately.
// ============================================================

export const LOCAL_SESSION_COOKIE = 'wacrm_local_session';
export const LOCAL_SESSION_HEADER = 'x-local-session';
export const LOCAL_SESSION_STORAGE_KEY = 'wacrm_local_session_token';

export const DEFAULT_LOCAL_ADMIN = {
  email: 'admin@wacrm.local',
  password: 'Admin123!',
  fullName: 'Administrador',
} as const;

export const SUPPORTED_APP_LOCALES = ['en', 'pt', 'es', 'ko'] as const;
export type AppLocale = (typeof SUPPORTED_APP_LOCALES)[number];

const PLACEHOLDER_VALUE_PATTERNS = [
  /^your[-_]/i,
  /^my[-_]/i,
  /^replace[-_]/i,
  /^change[-_]?me/i,
  /^placeholder$/i,
  /^example$/i,
  /^<.*>$/,
  /^xxx+$/i,
];

const PLACEHOLDER_HOST_PATTERNS = [
  'your-project',
  'your_project',
  'your-supabase',
  'project-ref',
  'placeholder',
  'example.com',
];

export function isPlaceholderEnvValue(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isValidSupabaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed || isPlaceholderEnvValue(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) return false;
    return !PLACEHOLDER_HOST_PATTERNS.some((marker) => host.includes(marker));
  } catch {
    return false;
  }
}

export function isValidSupabaseKey(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed || isPlaceholderEnvValue(trimmed)) return false;
  return true;
}

export function isValidEncryptionKey(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^[0-9a-fA-F]{64}$/.test(trimmed);
}

export function isSupabaseConfigured(): boolean {
  return (
    isValidSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    isValidSupabaseKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

export function isLocalHybridMode(): boolean {
  return !isSupabaseConfigured();
}

export function resolveAppLocale(): AppLocale {
  const requested = process.env.NEXT_PUBLIC_APP_LOCALE?.trim() ?? '';
  const isSupported = (SUPPORTED_APP_LOCALES as readonly string[]).includes(
    requested,
  );
  if (isLocalHybridMode()) {
    // In Local Hybrid Mode, preview runtimes may inject the repo's legacy
    // `.env.example` default ("en") alongside placeholder Supabase values.
    // Default to Portuguese ('pt') unless another non-English locale is set.
    if (isSupported && requested !== 'en') {
      return requested as AppLocale;
    }
    return 'pt';
  }
  return isSupported ? (requested as AppLocale) : 'pt';
}

