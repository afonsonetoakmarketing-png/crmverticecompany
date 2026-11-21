// ============================================================
// GET /api/system/status
//
// Returns boolean configuration status of backend environment
// variables (never exposing secret values) so administrators can see
// whether the app is running in Local Hybrid Mode or connected to
// Supabase, and which variables remain for production/GitHub deploy.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  isPlaceholderEnvValue,
  isSupabaseConfigured,
  isValidEncryptionKey,
  isValidSupabaseKey,
  isValidSupabaseUrl,
  resolveAppLocale,
} from '@/lib/local-backend/mode';

interface EnvCheck {
  key: string;
  configured: boolean;
  category: 'supabase' | 'security' | 'whatsapp' | 'app';
  requiredForProduction: boolean;
}

export async function GET() {
  try {
    await getCurrentAccount();

    const envChecks: EnvCheck[] = [
      {
        key: 'NEXT_PUBLIC_SUPABASE_URL',
        configured: isValidSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
        category: 'supabase',
        requiredForProduction: true,
      },
      {
        key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        configured: isValidSupabaseKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
        category: 'supabase',
        requiredForProduction: true,
      },
      {
        key: 'SUPABASE_SERVICE_ROLE_KEY',
        configured: isValidSupabaseKey(process.env.SUPABASE_SERVICE_ROLE_KEY),
        category: 'supabase',
        requiredForProduction: true,
      },
      {
        key: 'ENCRYPTION_KEY',
        configured: isValidEncryptionKey(process.env.ENCRYPTION_KEY),
        category: 'security',
        requiredForProduction: true,
      },
      {
        key: 'META_APP_SECRET',
        configured: !isPlaceholderEnvValue(process.env.META_APP_SECRET),
        category: 'whatsapp',
        requiredForProduction: false,
      },
      {
        key: 'NEXT_PUBLIC_SITE_URL',
        configured: !isPlaceholderEnvValue(process.env.NEXT_PUBLIC_SITE_URL),
        category: 'app',
        requiredForProduction: false,
      },
      {
        key: 'NEXT_PUBLIC_APP_LOCALE',
        configured: !isPlaceholderEnvValue(process.env.NEXT_PUBLIC_APP_LOCALE),
        category: 'app',
        requiredForProduction: false,
      },
    ];

    return NextResponse.json({
      mode: isSupabaseConfigured() ? 'supabase' : 'local_hybrid',
      locale: resolveAppLocale(),
      envChecks,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
