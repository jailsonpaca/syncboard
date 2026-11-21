import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { Field, type ToolProps } from './common';

type Preset = 'light' | 'balanced' | 'high';
type Phase = 'idle' | 'converting' | 'done';

const PRESET_LABEL: Record<Preset, string> = {
  light: 'Leve (480p)',
  balanced: 'Padrão (720p)',
  high: 'Alta (1080p)',
};

const LIMITS: Array<{ label: string; value: number | null }> = [
  { label: 'Sem limite', value: null },
  { label: '16 MB', value: 16 },
  { label: '64 MB', value: 64 },
  { label: '100 MB', value: 100 },
];

function fmtSize(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function VideoTool({ onToast }: ToolProps) {
  const api = window.syncboard;
  const [ffmpeg, setFfmpeg] = useState<{ ok: boolean; error?: string; version?: string } | null>(null);
  const [input, setInput] = useState('');
  const [preset, setPreset] = useState<Preset>('balanced');
  const [limit, setLimit] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [output, setOutput] = useState<{ path: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!api?.checkFfmpeg) return;
    void api.checkFfmpeg().then(setFfmpeg);
  }, [api]);

  useEffect(() => {
    if (!api?.onVideoProgress) return;
    return api.onVideoProgress((d) => setPercent(d.percent));
  }, [api]);

  useEffect(() => {
    if (!api?.onFileDrop) return;
    return api.onFileDrop((paths) => {
      const first = paths[0];
      if (first) {
        setInput(first);
        setOutput(null);
        setError(null);
        setPhase('idle');
      }
    });
  }, [api]);

  const pick = useCallback(async () => {
    const p = await api?.pickVideo?.();
    if (p) {
      setInput(p);
      setOutput(null);
      setError(null);
      setPhase('idle');
    }
  }, [api]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const p = f && api?.getPathForFile?.(f);
    if (p) {
      setInput(p);
      setOutput(null);
      setError(null);
      setPhase('idle');
    }
  };

  if (!api?.isElectron || !api.convertVideo) {
    return (
      <div className="tool">
        <div className="empty">
          A conversão de vídeo está disponível apenas no app desktop do SyncBoard (usa o ffmpeg instalado no computador).
        </div>
      </div>
    );
  }

  const start = async () => {
    setPhase('converting');
    setPercent(0);
    setError(null);
    setOutput(null);
    const r = await api.convertVideo!({ input, preset, maxMB: limit });
    if (r.ok && r.outputPath) {
      setOutput({ path: r.outputPath, size: r.sizeBytes ?? 0 });
      setPhase('done');
      onToast('Vídeo convertido');
    } else {
      setPhase('idle');
      if (!r.cancelled) setError(r.error || 'Falha na conversão');
      else onToast('Conversão cancelada');
    }
  };

  const fileName = input.split(/[\\/]/).pop() || '';

  return (
    <div className="tool">
      {ffmpeg && !ffmpeg.ok && <div className="tool-error">{ffmpeg.error}</div>}
      <div className="tool-drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div>{fileName ? <strong>{fileName}</strong> : 'Arraste um vídeo aqui (qualquer formato)'}</div>
        <button type="button" className="btn sm" disabled={phase === 'converting'} onClick={() => void pick()}>
          Escolher arquivo
        </button>
      </div>

      <Field label="Qualidade">
        <div className="tool-row">
          {(Object.keys(PRESET_LABEL) as Preset[]).map((k) => (
            <button key={k} type="button" disabled={phase === 'converting'} className={k === preset ? 'chip active' : 'chip'} onClick={() => setPreset(k)}>
              {PRESET_LABEL[k]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Tamanho máximo">
        <div className="tool-row">
          {LIMITS.map((l) => (
            <button key={l.label} type="button" disabled={phase === 'converting'} className={l.value === limit ? 'chip active' : 'chip'} onClick={() => setLimit(l.value)}>
              {l.label}
            </button>
          ))}
        </div>
      </Field>

      {phase === 'converting' ? (
        <div className="tool-field">
          <div className="tool-progress"><div style={{ width: `${percent}%` }} /></div>
          <div className="tool-row between">
            <span className="hint">Convertendo… {percent}%</span>
            <button type="button" className="btn sm danger" onClick={() => void api.cancelVideo?.()}>Cancelar</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn primary" disabled={!input || ffmpeg?.ok === false} onClick={() => void start()}>
          Converter para MP4 (WhatsApp)
        </button>
      )}

      {error && <div className="tool-error">{error}</div>}

      {output && (
        <div className="tool-field">
          <span className="tool-label">Pronto ({fmtSize(output.size)})</span>
          <code className="tool-code">{output.path}</code>
          <div className="tool-row">
            <button type="button" className="btn sm" onClick={() => void api.revealVideo?.(output.path)}>Mostrar na pasta</button>
            <button
              type="button"
              className="btn sm"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                const r = await api.sendVideoToHistory!(output.path);
                setSending(false);
                onToast(r.ok ? 'Enviado ao histórico' : r.error || 'Falha ao enviar');
              }}
            >
              {sending ? 'Enviando…' : 'Enviar ao histórico'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
