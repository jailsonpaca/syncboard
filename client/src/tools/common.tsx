import { useState, type ReactNode } from 'react';
import { copyText, errorMessage } from './util';

export type ToolProps = { onToast: (msg: string) => void };

export function CopyButton({ text, onToast, label = 'Copiar' }: { text: string; onToast: (m: string) => void; label?: string }) {
  return (
    <button
      type="button"
      className="btn sm"
      disabled={!text}
      onClick={async () => onToast((await copyText(text)) ? 'Copiado' : 'Não foi possível copiar')}
    >
      {label}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="tool-field">
      <span className="tool-label">{label}</span>
      {children}
    </label>
  );
}

export function OutputBox({ label, value, onToast, error }: { label: string; value: string; onToast: (m: string) => void; error?: string | null }) {
  return (
    <div className="tool-field">
      <div className="tool-row between">
        <span className="tool-label">{label}</span>
        <CopyButton text={value} onToast={onToast} />
      </div>
      {error ? <div className="tool-error">{error}</div> : <textarea className="tool-text" readOnly value={value} rows={6} />}
    </div>
  );
}

export type Mode = { label: string; run: (input: string) => string };

/** Ferramenta genérica "entrada -> saída" com vários modos. */
export function TransformTool({ modes, placeholder, onToast }: { modes: Mode[]; placeholder?: string } & ToolProps) {
  const [input, setInput] = useState('');
  const [modeIdx, setModeIdx] = useState(0);
  let output = '';
  let error: string | null = null;
  if (input) {
    try {
      output = modes[modeIdx].run(input);
    } catch (e) {
      error = errorMessage(e);
    }
  }
  return (
    <div className="tool">
      {modes.length > 1 && (
        <div className="tool-row">
          {modes.map((m, i) => (
            <button key={m.label} type="button" className={i === modeIdx ? 'chip active' : 'chip'} onClick={() => setModeIdx(i)}>
              {m.label}
            </button>
          ))}
        </div>
      )}
      <Field label="Entrada">
        <textarea className="tool-text" rows={6} value={input} placeholder={placeholder} onChange={(e) => setInput(e.target.value)} />
      </Field>
      <OutputBox label="Resultado" value={output} error={error} onToast={onToast} />
    </div>
  );
}
