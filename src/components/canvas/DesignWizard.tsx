import { useState } from 'react';

/**
 * In-app design wizard — the same funnel as the BTI website configurator
 * (project type → built area → style → finish), self-contained in BLDR.
 * Completing it composes one brief line and hands it to the chat composer
 * (window 'bldr:brief' event) — the visitor then refines with the AI or sends
 * as-is to generate. Shown on first visit and reopenable via "New design".
 */

const TYPES = [
  { label: 'Single-storey villa', icon: '🏠' },
  { label: 'Villa G+1 (2 floors)', icon: '🏡' },
  { label: 'Villa G+2 (3 floors)', icon: '🏘️' },
  { label: 'Villa G+3 (4 floors)', icon: '🏰' },
  { label: 'Majlis / annex', icon: '🛋️' },
  { label: 'Guard house / cabin', icon: '🛖' },
  { label: 'Commercial building', icon: '🏢' },
  { label: 'Custom project', icon: '✨' },
];

const STYLES = [
  { label: 'Modern organic', hint: 'Flowing curves, natural forms' },
  { label: 'Modern geometric', hint: 'Clean lines, bold volumes' },
  { label: 'Islamic heritage', hint: 'Arches, mashrabiya, courtyards' },
  { label: 'Futuristic (Mars style)', hint: 'Printed domes, otherworldly' },
];

const FINISHES = [
  { label: 'Printed shell only', hint: 'Structure only — you finish it' },
  { label: 'Standard finish (turnkey)', hint: 'Move-in ready' },
  { label: 'Premium finish', hint: 'High-end materials & detailing' },
];

const STEPS = ['Project type', 'Built area', 'Style', 'Finish'] as const;

export function composeBrief(type: string, area: number, style: string, finish: string) {
  return `${type}, ${area} m², ${style} style, ${finish}.`;
}

interface DesignWizardProps {
  onComplete: (brief: string) => void;
  onClose: () => void;
}

export default function DesignWizard({ onComplete, onClose }: DesignWizardProps) {
  const [step, setStep] = useState(0);
  const [type, setType] = useState<string | null>(null);
  const [area, setArea] = useState(200);
  const [style, setStyle] = useState<string | null>(null);
  const [finish, setFinish] = useState<string | null>(null);

  const canNext = step === 0 ? type !== null : step === 2 ? style !== null : step === 3 ? finish !== null : true;
  const pick = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const finishWizard = () => {
    if (!type || !style || !finish) return;
    onComplete(composeBrief(type, area, style, finish));
  };

  const optionCard = (selected: boolean) =>
    `rounded-lg border p-3 text-left text-sm transition hover:border-primary ${
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
            <div className="text-lg font-bold">Design your building</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
            title="Skip — go straight to the studio"
          >
            Skip ✕
          </button>
        </div>

        {/* step indicator */}
        <div className="flex items-center gap-1 px-5 pt-4">
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => i < step && setStep(i)}
              className={`h-1.5 flex-1 rounded-full transition ${i <= step ? 'bg-primary' : 'bg-border'}`}
              title={label}
            />
          ))}
        </div>
        <div className="px-5 pt-2 text-xs text-muted-foreground">
          {step + 1} · {STEPS[step]}
        </div>

        <div className="max-h-[55vh] overflow-y-auto p-5">
          {step === 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TYPES.map((t) => (
                <button key={t.label} type="button" onClick={() => pick(setType)(t.label)} className={optionCard(type === t.label)}>
                  <div className="mb-1 text-2xl">{t.icon}</div>
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {step === 1 && (
            <div className="py-4">
              <div className="mb-6 text-center">
                <span className="text-4xl font-bold tabular-nums text-primary">{area}</span>
                <span className="ml-1 text-lg text-muted-foreground">m²</span>
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
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {STYLES.map((s) => (
                <button key={s.label} type="button" onClick={() => pick(setStyle)(s.label)} className={optionCard(style === s.label)}>
                  <div className="font-semibold">{s.label}</div>
                  <div className="text-xs text-muted-foreground">{s.hint}</div>
                </button>
              ))}
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-2 sm:grid-cols-3">
              {FINISHES.map((f) => (
                <button key={f.label} type="button" onClick={() => setFinish(f.label)} className={optionCard(finish === f.label)}>
                  <div className="font-semibold">{f.label}</div>
                  <div className="text-xs text-muted-foreground">{f.hint}</div>
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
            ← Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => canNext && setStep((s) => s + 1)}
              disabled={!canNext}
              className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={finishWizard}
              disabled={!finish}
              className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              ✨ Open the design studio
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
