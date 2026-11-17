import { useEffect, useMemo, useState } from 'react';
import { CopyButton, Field, OutputBox, TransformTool, type ToolProps } from './common';
import { errorMessage } from './util';
import * as L from './lib';

// ----- Ferramentas "entrada -> saída" -----
export const JsonTool = (p: ToolProps) => (
  <TransformTool
    {...p}
    placeholder='{"chave": "valor"}'
    modes={[
      { label: 'Formatar (2 espaços)', run: (s) => L.formatJson(s, 2) },
      { label: 'Formatar (4 espaços)', run: (s) => L.formatJson(s, 4) },
      { label: 'Minificar', run: L.minifyJson },
    ]}
  />
);

export const Base64Tool = (p: ToolProps) => (
  <TransformTool {...p} modes={[{ label: 'Codificar', run: L.base64Encode }, { label: 'Decodificar', run: L.base64Decode }]} />
);

export const UrlTool = (p: ToolProps) => (
  <TransformTool {...p} modes={[{ label: 'Codificar', run: L.urlEncode }, { label: 'Decodificar', run: L.urlDecode }]} />
);

export const HtmlTool = (p: ToolProps) => (
  <TransformTool {...p} modes={[{ label: 'Codificar', run: L.htmlEncode }, { label: 'Decodificar', run: L.htmlDecode }]} />
);

export const JwtTool = (p: ToolProps) => (
  <TransformTool
    {...p}
    placeholder="eyJhbGciOi..."
    modes={[
      {
        label: 'Decodificar',
        run: (s) => {
          const r = L.decodeJwt(s);
          return JSON.stringify({ header: r.header, payload: r.payload, expiraEm: r.expiresAt }, null, 2);
        },
      },
    ]}
  />
);

export const CaseTool = (p: ToolProps) => (
  <TransformTool {...p} modes={Object.entries(L.caseConverters).map(([label, run]) => ({ label, run }))} />
);

// ----- Hash -----
export function HashTool({ onToast }: ToolProps) {
  const [input, setInput] = useState('');
  const [out, setOut] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const algos: L.HashAlgo[] = ['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
      const entries = await Promise.all(algos.map(async (a) => [a, await L.hashText(input, a)] as const));
      if (!cancelled) setOut(Object.fromEntries(entries));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [input]);
  return (
    <div className="tool">
      <Field label="Texto">
        <textarea className="tool-text" rows={4} value={input} onChange={(e) => setInput(e.target.value)} />
      </Field>
      {Object.entries(out).map(([algo, hex]) => (
        <div key={algo} className="tool-field">
          <div className="tool-row between">
            <span className="tool-label">{algo}</span>
            <CopyButton text={hex} onToast={onToast} />
          </div>
          <code className="tool-code">{hex}</code>
        </div>
      ))}
    </div>
  );
}

// ----- UUID -----
export function UuidTool({ onToast }: ToolProps) {
  const [count, setCount] = useState(5);
  const [list, setList] = useState<string[]>(() => Array.from({ length: 5 }, L.uuidV4));
  const text = list.join('\n');
  return (
    <div className="tool">
      <div className="tool-row">
        <Field label="Quantidade">
          <input className="tool-input" type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        </Field>
        <button type="button" className="btn primary" onClick={() => setList(Array.from({ length: Math.min(100, Math.max(1, count)) }, L.uuidV4))}>
          Gerar
        </button>
      </div>
      <OutputBox label="UUID v4" value={text} onToast={onToast} />
    </div>
  );
}

// ----- Senha -----
export function PasswordTool({ onToast }: ToolProps) {
  const [opts, setOpts] = useState<L.PasswordOpts>({ length: 20, lower: true, upper: true, digits: true, symbols: true });
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const generate = () => {
    try {
      setPwd(L.generatePassword(opts));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(generate, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: 'lower' | 'upper' | 'digits' | 'symbols', label: string) => (
    <label className="tool-check">
      <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <div className="tool">
      <Field label={`Tamanho: ${opts.length}`}>
        <input type="range" min={4} max={64} value={opts.length} onChange={(e) => setOpts({ ...opts, length: Number(e.target.value) })} />
      </Field>
      <div className="tool-row">
        {toggle('lower', 'a-z')}
        {toggle('upper', 'A-Z')}
        {toggle('digits', '0-9')}
        {toggle('symbols', '!@#')}
      </div>
      <button type="button" className="btn primary" onClick={generate}>Gerar</button>
      <OutputBox label="Senha" value={pwd} error={error} onToast={onToast} />
    </div>
  );
}

// ----- Lorem Ipsum -----
export function LoremTool({ onToast }: ToolProps) {
  const [n, setN] = useState(3);
  const text = useMemo(() => L.loremIpsum(n), [n]);
  return (
    <div className="tool">
      <Field label="Parágrafos">
        <input className="tool-input" type="number" min={1} max={50} value={n} onChange={(e) => setN(Number(e.target.value) || 1)} />
      </Field>
      <OutputBox label="Texto" value={text} onToast={onToast} />
    </div>
  );
}

// ----- Timestamp -----
export function TimestampTool({ onToast }: ToolProps) {
  const [ts, setTs] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [date, setDate] = useState(() => new Date().toISOString());
  let a = '';
  let aErr: string | null = null;
  try {
    const r = L.timestampToDate(ts);
    a = `ISO: ${r.iso}\nLocal: ${r.local}\n(interpretado como ${r.unit === 's' ? 'segundos' : 'milissegundos'})`;
  } catch (e) {
    aErr = errorMessage(e);
  }
  let b = '';
  let bErr: string | null = null;
  try {
    const r = L.dateToTimestamp(date);
    b = `Segundos: ${r.seconds}\nMilissegundos: ${r.millis}`;
  } catch (e) {
    bErr = errorMessage(e);
  }
  return (
    <div className="tool">
      <Field label="Timestamp Unix">
        <div className="tool-row">
          <input className="tool-input" value={ts} onChange={(e) => setTs(e.target.value)} />
          <button type="button" className="btn sm" onClick={() => setTs(String(Math.floor(Date.now() / 1000)))}>Agora</button>
        </div>
      </Field>
      <OutputBox label="Data" value={a} error={aErr} onToast={onToast} />
      <Field label="Data (ISO ou qualquer formato reconhecido)">
        <input className="tool-input" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <OutputBox label="Timestamp" value={b} error={bErr} onToast={onToast} />
    </div>
  );
}

// ----- Base numérica -----
export function BaseTool({ onToast }: ToolProps) {
  const [input, setInput] = useState('255');
  const [from, setFrom] = useState<L.NumBase>(10);
  let res: Record<L.NumBase, string> | null = null;
  let error: string | null = null;
  try {
    res = L.convertBase(input, from);
  } catch (e) {
    error = errorMessage(e);
  }
  return (
    <div className="tool">
      <div className="tool-row">
        {([2, 8, 10, 16] as L.NumBase[]).map((b) => (
          <button key={b} type="button" className={b === from ? 'chip active' : 'chip'} onClick={() => setFrom(b)}>
            Base {b}
          </button>
        ))}
      </div>
      <Field label="Número">
        <input className="tool-input" value={input} onChange={(e) => setInput(e.target.value)} />
      </Field>
      {error && <div className="tool-error">{error}</div>}
      {res &&
        ([2, 8, 10, 16] as L.NumBase[]).map((b) => (
          <div key={b} className="tool-field">
            <div className="tool-row between">
              <span className="tool-label">Base {b}</span>
              <CopyButton text={res![b]} onToast={onToast} />
            </div>
            <code className="tool-code">{res![b]}</code>
          </div>
        ))}
    </div>
  );
}

// ----- Cores -----
export function ColorTool({ onToast }: ToolProps) {
  const [input, setInput] = useState('#6C5CE7');
  let rgb: L.Rgb | null = null;
  let error: string | null = null;
  try {
    rgb = L.parseColor(input);
  } catch (e) {
    error = errorMessage(e);
  }
  const hsl = rgb ? L.rgbToHsl(rgb) : null;
  const rows = rgb && hsl
    ? [
        ['HEX', L.rgbToHex(rgb)],
        ['RGB', `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`],
        ['HSL', `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`],
      ]
    : [];
  return (
    <div className="tool">
      <Field label="Cor (#RRGGBB, rgb(), hsl())">
        <div className="tool-row">
          <input className="tool-input" value={input} onChange={(e) => setInput(e.target.value)} />
          <div className="tool-swatch" style={{ background: rgb ? L.rgbToHex(rgb) : 'transparent' }} />
        </div>
      </Field>
      {error && <div className="tool-error">{error}</div>}
      {rows.map(([k, v]) => (
        <div key={k} className="tool-field">
          <div className="tool-row between">
            <span className="tool-label">{k}</span>
            <CopyButton text={v} onToast={onToast} />
          </div>
          <code className="tool-code">{v}</code>
        </div>
      ))}
    </div>
  );
}

// ----- Diff -----
export function DiffTool(_: ToolProps) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  let lines: L.DiffLine[] = [];
  let error: string | null = null;
  if (a || b) {
    try {
      lines = L.diffLines(a, b);
    } catch (e) {
      error = errorMessage(e);
    }
  }
  return (
    <div className="tool">
      <div className="tool-cols">
        <Field label="Original">
          <textarea className="tool-text" rows={7} value={a} onChange={(e) => setA(e.target.value)} />
        </Field>
        <Field label="Alterado">
          <textarea className="tool-text" rows={7} value={b} onChange={(e) => setB(e.target.value)} />
        </Field>
      </div>
      {error && <div className="tool-error">{error}</div>}
      {lines.length > 0 && (
        <pre className="tool-diff">
          {lines.map((l, i) => (
            <div key={i} className={`diff-${l.type}`}>
              {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

// ----- Regex -----
export function RegexTool(_: ToolProps) {
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('g');
  const [text, setText] = useState('');
  let matches: L.RegexMatch[] = [];
  let error: string | null = null;
  try {
    matches = L.runRegex(pattern, flags, text);
  } catch (e) {
    error = errorMessage(e);
  }
  return (
    <div className="tool">
      <div className="tool-row">
        <Field label="Expressão">
          <input className="tool-input mono" value={pattern} placeholder="(\d+)-(\w+)" onChange={(e) => setPattern(e.target.value)} />
        </Field>
        <Field label="Flags">
          <input className="tool-input mono" style={{ width: 70 }} value={flags} onChange={(e) => setFlags(e.target.value.replace(/[^dgimsuy]/g, ''))} />
        </Field>
      </div>
      <Field label="Texto de teste">
        <textarea className="tool-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {error && <div className="tool-error">{error}</div>}
      {!error && pattern && <div className="hint">{matches.length} correspondência(s)</div>}
      {matches.map((m, i) => (
        <div key={i} className="tool-match">
          <code>{m.text || '(vazio)'}</code> <span className="hint">@{m.index}</span>
          {m.groups.length > 0 && <div className="hint">grupos: {m.groups.map((g, j) => `$${j + 1}=${JSON.stringify(g)}`).join('  ')}</div>}
        </div>
      ))}
    </div>
  );
}
