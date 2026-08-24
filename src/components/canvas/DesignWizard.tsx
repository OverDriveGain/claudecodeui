import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * In-app design wizard — the same funnel as the BTI website configurator
 * (project type → built area → style → finish), self-contained in BLDR.
 * Completing it composes one brief line and hands it to the chat composer
 * (window 'bldr:brief' event) — the visitor then refines with the AI or sends
 * as-is to generate. Shown on first visit and reopenable via "New design".
 *
 * i18n: the option LABELS are localized (bldr namespace) so the customer sees
 * their language, but the VALUE stored/sent stays a canonical English string —
 * the design brief feeds the generation models, which handle English best.
 */

type Option = { key: string; value: string; icon?: string };

const TYPES: Option[] = [
  { key: 'villa_single', value: 'Single-storey villa', icon: '🏠' },
  { key: 'villa_g1', value: 'Villa G+1 (2 floors)', icon: '🏡' },
  { key: 'villa_g2', value: 'Villa G+2 (3 floors)', icon: '🏘️' },
  { key: 'villa_g3', value: 'Villa G+3 (4 floors)', icon: '🏰' },
  { key: 'majlis', value: 'Majlis / annex', icon: '🛋️' },
  { key: 'guardhouse', value: 'Guard house / cabin', icon: '🛖' },
  { key: 'commercial', value: 'Commercial building', icon: '🏢' },
  { key: 'custom', value: 'Custom project', icon: '✨' },
];

const STYLES: Option[] = [
  { key: 'modern_organic', value: 'Modern organic' },
  { key: 'modern_geometric', value: 'Modern geometric' },
  { key: 'islamic_heritage', value: 'Islamic heritage' },
  { key: 'futuristic', value: 'Futuristic (Mars style)' },
];

const FINISHES: Option[] = [
  { key: 'shell', value: 'Printed shell only' },
  { key: 'standard', value: 'Standard finish (turnkey)' },
  { key: 'premium', value: 'Premium finish' },
];

const STEP_KEYS = ['type', 'area', 'style', 'finish'] as const;

export type WizardParams = { type: string; area: number; style: string; finish: string };

/** Saved selections (canonical English values) as stamped on the manifest. */
export type SavedParams = { type?: string; area?: number; style?: string; finish?: string; lang?: string };

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Turn saved canonical selections back into a localized, human summary
 * ("فيلا بطابق واحد، ٢٠٠ م²، عضوي حديث، تشطيب قياسي") for the proactive
 * greeting. Unknown values pass through verbatim.
 */
export function localizeParams(params: SavedParams | null | undefined, t: TFn): string {
  if (!params) return '';
  const keyOf = (opts: Option[], value?: string) => (value ? opts.find((o) => o.value === value)?.key : undefined);
  const parts: string[] = [];
  if (params.type) {
    const k = keyOf(TYPES, params.type);
    parts.push(k ? t(`wizard.types.${k}`) : params.type);
  }
  if (params.area) parts.push(t('wizard.areaValue', { area: params.area }));
  if (params.style) {
    const k = keyOf(STYLES, params.style);
    parts.push(k ? t(`wizard.styles.${k}.label`) : params.style);
  }
  if (params.finish) {
    const k = keyOf(FINISHES, params.finish);
    parts.push(k ? t(`wizard.finishes.${k}.label`) : params.finish);
  }
  return parts.join(t('listSep', { defaultValue: ', ' }));
}

interface DesignWizardProps {
  onComplete: (params: WizardParams) => void;
  onClose: () => void;
  busy?: boolean;
}

export default function DesignWizard({ onComplete, onClose, busy }: DesignWizardProps) {
  const { t } = useTranslation('bldr');
  const [step, setStep] = useState(0);
  // State holds the OPTION KEY (for localized display); the canonical value is
  // resolved from the option arrays only when we hand off on complete.
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [area, setArea] = useState(200);
  const [styleKey, setStyleKey] = useState<string | null>(null);
  const [finishKey, setFinishKey] = useState<string | null>(null);

  const typeLabel = typeKey ? t(`wizard.types.${typeKey}`) : null;
  const styleLabel = styleKey ? t(`wizard.styles.${styleKey}.label`) : null;
  const finishLabel = finishKey ? t(`wizard.finishes.${finishKey}.label`) : null;

  const canNext = step === 0 ? typeKey !== null : step === 2 ? styleKey !== null : step === 3 ? finishKey !== null : true;
  const pick = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setStep((s) => Math.min(s + 1, STEP_KEYS.length - 1));
  };

  const finishWizard = () => {
    if (!typeKey || !styleKey || !finishKey) return;
    const valueOf = (opts: Option[], key: string) => opts.find((o) => o.key === key)?.value ?? key;
    onComplete({
      type: valueOf(TYPES, typeKey),
      area,
      style: valueOf(STYLES, styleKey),
      finish: valueOf(FINISHES, finishKey),
    });
  };

  const optionCard = (selected: boolean) =>
    `rounded-lg border p-3 text-start text-sm transition hover:border-primary ${
      selected ? 'border-primary bg-primary/10' : 'border-border bg-card'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        {/* BTI sheet-style header */}
        <div className="flex items-center justify-between border-b-2 border-primary bg-card px-5 py-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              BTI · Build Tech Innovation 3D
            </div>
            <div className="text-lg font-bold">{t('wizard.title')}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
            title={t('wizard.skip')}
          >
            {t('wizard.skip')} ✕
          </button>
        </div>

        {/* step indicator */}
        <div className="flex items-center gap-1 px-5 pt-4">
          {STEP_KEYS.map((key, i) => (
            <button
              key={key}
              type="button"
              onClick={() => i < step && setStep(i)}
              className={`h-1.5 flex-1 rounded-full transition ${i <= step ? 'bg-primary' : 'bg-border'}`}
              title={t(`wizard.steps.${key}`)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-5 pt-2 text-xs text-muted-foreground">
          <span>
            {step + 1} · {t(`wizard.steps.${STEP_KEYS[step]}`)}
          </span>
          {/* recap of choices made so far — tap a chip's step bar above to change */}
          {[typeLabel, step > 1 ? t('wizard.areaValue', { area }) : null, styleLabel, finishLabel].filter(Boolean).map((v) => (
            <span key={String(v)} className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              {v}
            </span>
          ))}
        </div>

        <div className="max-h-[55vh] overflow-y-auto p-5">
          {step === 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TYPES.map((o) => (
                <button key={o.key} type="button" onClick={() => pick(setTypeKey)(o.key)} className={optionCard(typeKey === o.key)}>
                  <div className="mb-1 text-2xl">{o.icon}</div>
                  {t(`wizard.types.${o.key}`)}
                </button>
              ))}
            </div>
          )}

          {step === 1 && (
            <div className="py-4">
              <div className="mb-6 text-center">
                <span className="text-4xl font-bold tabular-nums text-primary">{area}</span>
                <span className="ms-1 text-lg text-muted-foreground">m²</span>
              </div>
              <input
                type="range"
                min={30}
                max={1200}
                step={10}
                value={area}
                onChange={(e) => setArea(Number(e.target.value))}
                className="w-full accent-[#D52027]"
              />
              <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>30 m²</span>
                <span>1200 m²</span>
              </div>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {[120, 200, 350, 500, 800].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setArea(v)}
                    className={`rounded-full border px-3 py-1 text-xs transition ${
                      area === v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary'
                    }`}
                  >
                    {v} m²
                  </button>
                ))}
              </div>
              <p className="mt-4 text-center text-xs text-muted-foreground">
                {t('wizard.areaPrompt')}
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {STYLES.map((o) => (
                <button key={o.key} type="button" onClick={() => pick(setStyleKey)(o.key)} className={optionCard(styleKey === o.key)}>
                  <div className="font-semibold">{t(`wizard.styles.${o.key}.label`)}</div>
                  <div className="text-xs text-muted-foreground">{t(`wizard.styles.${o.key}.hint`)}</div>
                </button>
              ))}
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-2 sm:grid-cols-3">
              {FINISHES.map((o) => (
                <button key={o.key} type="button" onClick={() => setFinishKey(o.key)} className={optionCard(finishKey === o.key)}>
                  <div className="font-semibold">{t(`wizard.finishes.${o.key}.label`)}</div>
                  <div className="text-xs text-muted-foreground">{t(`wizard.finishes.${o.key}.hint`)}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-card px-5 py-3">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-40"
          >
            ← {t('wizard.back')}
          </button>
          {step < STEP_KEYS.length - 1 ? (
            <button
              type="button"
              onClick={() => canNext && setStep((s) => s + 1)}
              disabled={!canNext}
              className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              {t('wizard.next')} →
            </button>
          ) : (
            <button
              type="button"
              onClick={finishWizard}
              disabled={!finishKey || busy}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              {busy ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t('wizard.starting')}
                </>
              ) : (
                <>✨ {t('wizard.generate')}</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
