import { useCallback, useEffect, useRef, useState } from 'react';
import { Field, type ToolProps } from './common';

type Source = { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string };
type Status = { platform: string; screen: string; microphone: string; outputDir: string };
type Phase = 'idle' | 'countdown' | 'recording' | 'saving' | 'done';

const MIME_CANDIDATES: Array<{ mime: string; ext: 'mp4' | 'webm' }> = [
  { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

function pickMime() {
  return MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.mime)) ?? null;
}

function fmtTime(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSize(bytes: number) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function RecorderTool({ onToast }: ToolProps) {
  const api = window.syncboard;
  const [status, setStatus] = useState<Status | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mic, setMic] = useState(false);
  const [sysAudio, setSysAudio] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<{ path: string; size: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);

  const refreshSources = useCallback(async () => {
    const r = await api?.recSources?.();
    if (r?.ok) setSources(r.sources);
    else if (r?.error) setError(r.error);
  }, [api]);

  const refreshStatus = useCallback(async () => {
    const s = await api?.recStatus?.();
    if (s) setStatus(s);
  }, [api]);

  useEffect(() => {
    void refreshStatus();
    void refreshSources();
  }, [refreshStatus, refreshSources]);

  const cleanup = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, []);

  // Se o usuário sair da aba durante a gravação, descarta e libera captura/microfone.
  useEffect(
    () => () => {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        stoppingRef.current = true;
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
        void api?.recEnd?.({ discard: true });
      }
      cleanup();
    },
    [api, cleanup],
  );

  if (!api?.isElectron || !api.recSources) {
    return (
      <div className="tool">
        <div className="empty">O gravador de tela está disponível apenas no app desktop do SyncBoard.</div>
      </div>
    );
  }

  const finish = async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setPhase('saving');
    await queueRef.current;
    cleanup();
    const r = await api.recEnd!();
    if (r.ok && r.outputPath) {
      setOutput({ path: r.outputPath, size: r.sizeBytes ?? 0 });
      setPhase('done');
      onToast('Gravação salva');
    } else {
      setError(r.error || 'Falha ao salvar a gravação');
      setPhase('idle');
    }
  };

  const start = async () => {
    if (!selected) return;
    setError(null);
    setOutput(null);
    stoppingRef.current = false;
    const fmt = pickMime();
    if (!fmt) {
      setError('Este app não suporta gravação de vídeo (MediaRecorder).');
      return;
    }
    if (mic && status?.platform === 'darwin' && status.microphone !== 'granted') {
      const r = await api.recAskMic!();
      if (!r.ok) {
        setError('Permissão do microfone negada. Libere em Ajustes do Sistema > Privacidade > Microfone.');
        return;
      }
    }
    // Contagem regressiva para você poder trocar de janela
    setPhase('countdown');
    for (let i = 3; i > 0; i--) {
      setCount(i);
      await new Promise((r) => setTimeout(r, 1000));
    }

    try {
      await api.recSelect!({ sourceId: selected, systemAudio: sysAudio });
      let display: MediaStream;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: sysAudio });
      } catch (e) {
        if (!sysAudio) throw e;
        // Áudio do sistema pode não ser suportado nesta versão do SO/Electron: tenta sem áudio.
        await api.recSelect!({ sourceId: selected, systemAudio: false });
        display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        onToast('Áudio do sistema indisponível — gravando sem ele');
      }
      streamsRef.current.push(display);

      const audioTracks: MediaStreamTrack[] = [];
      let micStream: MediaStream | null = null;
      if (mic) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamsRef.current.push(micStream);
      }
      const displayAudio = display.getAudioTracks();
      if (micStream && displayAudio.length) {
        // Mistura microfone + áudio do sistema em uma única faixa
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        const dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(new MediaStream(displayAudio)).connect(dest);
        ctx.createMediaStreamSource(micStream).connect(dest);
        audioTracks.push(...dest.stream.getAudioTracks());
      } else if (micStream) {
        audioTracks.push(...micStream.getAudioTracks());
      } else {
        audioTracks.push(...displayAudio);
      }

      const stream = new MediaStream([...display.getVideoTracks(), ...audioTracks]);
      const begin = await api.recBegin!({ ext: fmt.ext });
      if (!begin.ok) throw new Error(begin.error || 'Não foi possível criar o arquivo');

      const recorder = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 6_000_000 });
      recorderRef.current = recorder;
      queueRef.current = Promise.resolve();
      recorder.ondataavailable = (ev) => {
        if (ev.data.size === 0) return;
        queueRef.current = queueRef.current.then(async () => api.recChunk!(await ev.data.arrayBuffer()));
      };
      recorder.onstop = () => void finish();
      // Janela fechada / compartilhamento encerrado pelo sistema
      display.getVideoTracks()[0].addEventListener('ended', () => {
        if (recorder.state !== 'inactive') recorder.stop();
      });
      recorder.start(1000);
      setElapsed(0);
      setPhase('recording');
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (e) {
      cleanup();
      await api.recEnd!({ discard: true });
      setPhase('idle');
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /denied|permission/i.test(msg) && status?.platform === 'darwin'
          ? 'Sem permissão de Gravação de Tela. Libere o SyncBoard em Ajustes do Sistema > Privacidade > Gravação de Tela e reabra o app.'
          : msg,
      );
      void refreshStatus();
    }
  };

  const stop = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  };

  const screenDenied = status?.platform === 'darwin' && status.screen !== 'granted';
  const locked = phase !== 'idle' && phase !== 'done';

  return (
    <div className="tool">
      {screenDenied && (
        <div className="tool-error">
          O macOS ainda não liberou a Gravação de Tela para o SyncBoard (status: {status?.screen}). Ao gravar pela primeira vez o sistema
          pede a permissão; se negou, libere manualmente e reabra o app.{' '}
          <button type="button" className="btn sm" onClick={() => void api.recOpenPrivacy?.('screen')}>Abrir ajustes</button>
        </div>
      )}

      <Field label="O que gravar">
        <div className="tool-row between">
          <span className="hint">{sources.length} fonte(s) encontradas</span>
          <button type="button" className="btn sm" disabled={locked} onClick={() => void refreshSources()}>Atualizar</button>
        </div>
        <div className="rec-sources">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={locked}
              className={s.id === selected ? 'rec-source active' : 'rec-source'}
              onClick={() => setSelected(s.id)}
              title={s.name}
            >
              <img src={s.thumbnail} alt="" />
              <span>{s.kind === 'screen' ? '🖥 ' : '🪟 '}{s.name}</span>
            </button>
          ))}
        </div>
      </Field>

      <div className="tool-row">
        <label className="tool-check"><input type="checkbox" disabled={locked} checked={mic} onChange={(e) => setMic(e.target.checked)} /> Microfone</label>
        <label className="tool-check"><input type="checkbox" disabled={locked} checked={sysAudio} onChange={(e) => setSysAudio(e.target.checked)} /> Áudio do sistema (depende do SO)</label>
      </div>

      {phase === 'countdown' && <div className="rec-big">Começando em {count}…</div>}
      {phase === 'recording' && (
        <div className="tool-row between">
          <span className="rec-big rec-live">● {fmtTime(elapsed)}</span>
          <button type="button" className="btn danger" onClick={stop}>Parar</button>
        </div>
      )}
      {phase === 'saving' && <div className="hint">Salvando…</div>}
      {(phase === 'idle' || phase === 'done') && (
        <button type="button" className="btn primary" disabled={!selected} onClick={() => void start()}>
          ● Gravar
        </button>
      )}
      {status && <div className="hint">Salva em {status.outputDir}</div>}
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
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await api.sendVideoToHistory!(output.path);
                setBusy(false);
                onToast(r.ok ? 'Enviado ao histórico' : r.error || 'Falha ao enviar');
              }}
            >
              Enviar ao histórico
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                onToast('Convertendo para WhatsApp…');
                const r = await api.convertVideo!({ input: output.path, preset: 'balanced' });
                setBusy(false);
                if (r.ok && r.outputPath) {
                  setOutput({ path: r.outputPath, size: r.sizeBytes ?? 0 });
                  onToast('Convertido para MP4 (WhatsApp)');
                } else onToast(r.error || 'Falha na conversão');
              }}
            >
              Converter p/ WhatsApp
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
