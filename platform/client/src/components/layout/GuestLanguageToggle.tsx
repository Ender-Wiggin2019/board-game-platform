import {
  SUPPORTED_USER_LANGUAGES,
  type TUserLanguage,
} from '@board-platform/contracts/types/protocol/userLanguage';
import { Languages } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  chipClassName,
  chipTrackClassName,
} from '@/components/ui/filter-chip-group';
import { cn } from '@/lib/cn';
import { rememberDeviceLanguage } from '@/lib/deviceLanguage';
import { requestInterfaceLanguage } from '@/lib/interfaceLanguage';
import { normalizeLanguage } from '@/lib/normalizers';

// Each language is named in its own script, so both options stay readable
// whichever language the page is currently in.
const LANGUAGE_LABELS: Record<TUserLanguage, string> = {
  'zh-CN': '中文',
  en: 'English',
};

/**
 * Language switch for signed-out visitors. Signed-in players change their
 * account language in settings instead.
 */
export function GuestLanguageToggle(): React.JSX.Element {
  const { i18n, t } = useTranslation('platform-common');
  const [requested, setRequested] = useState<TUserLanguage | null>(null);
  // A requested language already shows as selected while it loads.
  const selected =
    requested ?? normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);

  function choose(language: TUserLanguage): void {
    if (language === selected) return;
    setRequested(language);
    rememberDeviceLanguage(language);
    void requestInterfaceLanguage(language).finally(() => setRequested(null));
  }

  return (
    <div
      role='group'
      aria-label={t('home.language')}
      data-testid='guest-language-toggle'
      className={cn(chipTrackClassName, 'shrink-0 items-center')}
    >
      <Languages
        aria-hidden='true'
        className='ml-1 size-3.5 shrink-0 text-text-400'
      />
      {SUPPORTED_USER_LANGUAGES.map((language) => (
        <button
          key={language}
          type='button'
          lang={language}
          aria-pressed={language === selected}
          onClick={() => choose(language)}
          className={chipClassName(language === selected)}
        >
          {LANGUAGE_LABELS[language]}
        </button>
      ))}
    </div>
  );
}
