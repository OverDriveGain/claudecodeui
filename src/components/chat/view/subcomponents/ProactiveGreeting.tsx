import { useEffect, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import { localizeParams, type SavedParams } from '../../../canvas/DesignWizard';

/**
 * BLDR proactive greeting — replaces the empty chat state.
 *
 * Instead of a blank conversation, the assistant opens the dialogue: it reads
 * the customer's saved wizard selections (stamped on the project manifest) and
 * greets them with those choices, asking whether to generate now. Localized via
 * the `bldr` namespace, so it speaks the customer's (website's) language.
 *
 * "Yes — generate my design" dispatches `bldr:sendMessage` (the composer replays
 * it through the real send path, so the live AI Architect takes over). "Add
 * details first" just focuses the composer.
 */
interface ProactiveGreetingProps {
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef?: RefObject<HTMLTextAreaElement>;
}

export default function ProactiveGreeting({ setInput, textareaRef }: ProactiveGreetingProps) {
  const { t } = useTranslation('bldr');
  const [brief, setBrief] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.bldr.manifest();
        if (!res.ok) throw new Error(String(res.status));
        const manifest = (await res.json()) as { brief?: string; params?: SavedParams };
        // Prefer a localized summary rebuilt from the structured selections;
        // fall back to the raw composed brief line (e.g. a free-text handoff).
        const summary = localizeParams(manifest.params, t) || manifest.brief?.trim() || '';
        if (!cancelled) setBrief(summary || null);
      } catch {
        if (!cancelled) setBrief(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    // The wizard / website handoff saves selections AFTER this mounts — refresh
    // so the greeting reflects what the customer just chose.
    const onSaved = () => void load();
    window.addEventListener('bldr:paramsSaved', onSaved);
    return () => {
      cancelled = true;
      window.removeEventListener('bldr:paramsSaved', onSaved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wait for the manifest so we don't flash the no-brief copy then swap.
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
      </div>
    );
  }

  const message = brief ? t('greeting.proactiveWithBrief', { brief }) : t('greeting.proactiveNoBrief');

  const onGenerate = () => {
    window.dispatchEvent(
      new CustomEvent('bldr:sendMessage', { detail: { text: t('greeting.generateMessage') } }),
    );
  };
  const onAddDetails = () => {
    setInput('');
    textareaRef?.current?.focus();
  };

  return (
    <div className="flex h-full items-start justify-center px-3 py-6 sm:items-center">
      <div className="w-full max-w-md">
        {/* Assistant-style greeting bubble */}
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
            B
          </div>
          <div className="min-w-0 flex-1">
            <div className="rounded-2xl rounded-ss-sm border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm">
              {message}
            </div>
            {brief && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onGenerate}
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90"
                >
                  ✨ {t('greeting.generateCta')}
                </button>
                <button
                  type="button"
                  onClick={onAddDetails}
                  className="inline-flex items-center rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-accent"
                >
                  {t('greeting.addDetailsCta')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
