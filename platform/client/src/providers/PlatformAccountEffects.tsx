import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LANGUAGE } from '../config/constants.js';
import { usePushSessionCleanup } from '../hooks/usePushSessionCleanup.js';
import { readDeviceLanguage } from '../lib/deviceLanguage.js';
import { requestInterfaceLanguage } from '../lib/interfaceLanguage.js';
import { normalizeLanguage } from '../lib/normalizers.js';
import { useAuthStore } from '../stores/authStore.js';
import {
  resolvePlatformBrandName,
  usePlatformConfiguration,
} from './PlatformConfiguration.js';

/** Keep account-owned language metadata projected into the shared i18n engine. */
function useAccountLanguageSync(): void {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const language = useAuthStore((state) => state.user?.preferences?.language);
  const previousIsAuthenticated = useRef(isAuthenticated);

  useEffect(() => {
    const wasAuthenticated = previousIsAuthenticated.current;
    previousIsAuthenticated.current = isAuthenticated;

    if (wasAuthenticated && !isAuthenticated) {
      void requestInterfaceLanguage(readDeviceLanguage() ?? DEFAULT_LANGUAGE);
      return;
    }
    if (!isAuthenticated) return;
    void requestInterfaceLanguage(normalizeLanguage(language));
  }, [isAuthenticated, language]);
}

/** Keep browser metadata synchronized with the platform language and brand. */
function useAppMetadata(): void {
  const { t, i18n } = useTranslation('platform-common');
  const configuration = usePlatformConfiguration();
  const brandName = resolvePlatformBrandName(configuration, t('brand.name'));

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language;
    document
      .querySelector('meta[name="apple-mobile-web-app-title"]')
      ?.setAttribute('content', brandName);
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', t('brand.slogan'));
  }, [brandName, i18n, t]);
}

/** Platform-owned effects shared by every game registration. */
export function PlatformAccountEffects(): null {
  usePushSessionCleanup();
  useAccountLanguageSync();
  useAppMetadata();
  return null;
}

export { useAccountLanguageSync };
