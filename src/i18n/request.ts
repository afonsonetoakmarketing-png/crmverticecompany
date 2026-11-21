import { getRequestConfig } from 'next-intl/server';
import { resolveAppLocale } from '@/lib/local-backend/mode';

export default getRequestConfig(async () => {
  // Keep the runtime locale in sync with the build-time catalogue alias.
  // An invalid value must not be returned alongside the fallback:
  // next-intl uses the locale for formatting as well as dictionary lookup.
  const locale = resolveAppLocale();

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if a supported dictionary is unavailable.
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages,
  };
});
