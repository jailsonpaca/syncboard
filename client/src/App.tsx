import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import QRCode from 'qrcode';
import type { ClipItem, TypeFilter } from './types';
import {
  blobUrl,
  connectWebSocket,
  copyItemToClipboard,
  createText,
  deleteItem,
  fetchItemsPage,
  fetchPairInfo,
  fetchUpdateStatus,
  formatSize,
  formatTime,
  getDeviceName,
  getServerUrl,
  isUsingLocalFallback,
  itemDisplayKind,
  itemKindLabel,
  discoverLanServers,
  fetchDevices,
  joinWithCodeWeb,
  regeneratePairCode,
  setDeviceName,
  setServerUrl,
  touchItem,
  updateItem,
  type DeviceInfo,
  type DiscoveredServer,
  type PairInfo,
  type UpdateStatus,
} from './api';

type Tab = 'history' | 'pinned';

type ContextMenuState = {
  item: ClipItem;
  x: number;
  y: number;
};

const PAGE_SIZE = 20;
const isCompactView = new URLSearchParams(window.location.search).get('view') === 'compact';
const CONTEXT_MENU_WIDTH = 168;
const CONTEXT_MENU_HEIGHT = 132;

const FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'text', label: 'Texto' },
  { id: 'image', label: 'Imagem' },
  { id: 'video', label: 'Vídeo' },
  { id: 'file', label: 'Arquivo' },
];

function mergeItem(list: ClipItem[], item: ClipItem): ClipItem[] {
  const filtered = list.filter((i) => i.id !== item.id);
  return [item, ...filtered];
}

function removeItem(list: ClipItem[], id: string): ClipItem[] {
  return list.filter((i) => i.id !== id);
}

function matchesFilter(
  item: ClipItem,
  filter: TypeFilter,
  query: string,
  device?: string
): boolean {
  if (filter !== 'all') {
    const kind = itemDisplayKind(item);
    if (kind !== filter) return false;
  }
  if (device?.trim() && (item.deviceName || '') !== device.trim()) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.content, item.filename, item.label, item.deviceName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/** Cor estável por nome de dispositivo (badge). */
function deviceAccent(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 55% 58%)`;
}

function shortDeviceLabel(name: string): string {
  const cleaned = name.replace(/\.local$/i, '').trim();
  if (cleaned.length <= 22) return cleaned;
  return `${cleaned.slice(0, 20)}…`;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('history');
  const [history, setHistory] = useState<ClipItem[]>([]);
  const [pinned, setPinned] = useState<ClipItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [pinnedTotal, setPinnedTotal] = useState(0);
  const [connected, setConnected] = useState(false);
  const [localMode, setLocalMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [deviceFilter, setDeviceFilter] = useState<string>('');
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceName, setDeviceNameState] = useState(getDeviceName());
  const [serverInput, setServerInput] = useState(getServerUrl());
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pinModal, setPinModal] = useState<{ item: ClipItem } | null>(null);
  const [pinModalLabel, setPinModalLabel] = useState('');
  const [createFixedModal, setCreateFixedModal] = useState(false);
  const [createFixedLabel, setCreateFixedLabel] = useState('');
  const [createFixedContent, setCreateFixedContent] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pairInfo, setPairInfo] = useState<PairInfo | null>(null);
  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [lanServers, setLanServers] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<{
    version: string;
    downloaded: boolean;
    releaseNotes?: string;
    phase?: string;
    progress?: number;
    error?: string | null;
  } | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [whatsNewNotes, setWhatsNewNotes] = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    const onClose = () => closeContextMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [contextMenu, closeContextMenu]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const loadPage = useCallback(
    async (opts: { reset: boolean; pinnedTab: boolean }) => {
      const offset = opts.reset ? 0 : opts.pinnedTab ? pinned.length : history.length;
      if (opts.reset) setLoading(true);
      else setLoadingMore(true);

      try {
        const page = await fetchItemsPage({
          pinned: opts.pinnedTab,
          limit: PAGE_SIZE,
          offset,
          q: debouncedSearch,
          type: typeFilter,
          device: deviceFilter || undefined,
        });

        if (opts.pinnedTab) {
          setPinned((prev) => (opts.reset ? page.items : [...prev, ...page.items]));
          setPinnedTotal(page.total);
        } else {
          setHistory((prev) => (opts.reset ? page.items : [...prev, ...page.items]));
          setHistoryTotal(page.total);
        }
      } catch {
        showToast('Sem servidor — usando dados locais');
        setLocalMode(true);
      } finally {
        setLocalMode(isUsingLocalFallback());
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [debouncedSearch, typeFilter, deviceFilter, history.length, pinned.length, showToast]
  );

  const reloadBoth = useCallback(async () => {
    setLoading(true);
    try {
      const [h, p, deviceList] = await Promise.all([
        fetchItemsPage({
          pinned: false,
          limit: PAGE_SIZE,
          offset: 0,
          q: debouncedSearch,
          type: typeFilter,
          device: deviceFilter || undefined,
        }),
        fetchItemsPage({
          pinned: true,
          limit: PAGE_SIZE,
          offset: 0,
          q: debouncedSearch,
          type: typeFilter,
          device: deviceFilter || undefined,
        }),
        fetchDevices(),
      ]);
      setHistory(h.items);
      setHistoryTotal(h.total);
      setPinned(p.items);
      setPinnedTotal(p.total);
      if (deviceList.length) setDevices(deviceList);
      setLocalMode(isUsingLocalFallback());
    } catch {
      showToast('Sem servidor — modo local (clipboard neste aparelho)');
      setLocalMode(true);
    } finally {
      setLocalMode(isUsingLocalFallback());
      setLoading(false);
    }
  }, [debouncedSearch, typeFilter, deviceFilter, showToast]);

  useEffect(() => {
    void reloadBoth();
  }, [reloadBoth]);

  useEffect(() => {
    // Deep link ?join=CODE
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join');
    if (join) setJoinCode(join.toUpperCase());
  }, []);

  const refreshPairInfo = useCallback(async () => {
    try {
      const info = await fetchPairInfo();
      setPairInfo(info);
    } catch {
      setPairInfo(null);
      setPairQrDataUrl(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshPairInfo();
      try {
        const st = await fetchUpdateStatus(false);
        setUpdateStatus(st);
      } catch {
        /* ok */
      }
    })();
  }, [connected, refreshPairInfo]);

  const scanLanServers = useCallback(async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const list = await discoverLanServers();
      setLanServers(list);
      if (!list.length) setDiscoverError('Nenhum SyncBoard encontrado na rede local');
    } catch (err) {
      setLanServers([]);
      setDiscoverError((err as Error).message || 'Falha na busca');
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    void refreshPairInfo();
    void scanLanServers();
  }, [showSettings, refreshPairInfo, scanLanServers]);

  const selectLanServer = useCallback(
    (serverUrl: string) => {
      setServerInput(serverUrl.replace(/\/$/, ''));
      showToast(`Selecionado: ${serverUrl}`);
    },
    [showToast]
  );

  useEffect(() => {
    if (!pairInfo?.qrPayload) {
      setPairQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairInfo.qrPayload, {
      width: 180,
      margin: 1,
      color: { dark: '#0f0f12', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setPairQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPairQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pairInfo?.qrPayload]);

  useEffect(() => {
    if (!window.syncboard?.onUpdateStatus) return;
    return window.syncboard.onUpdateStatus((data) => {
      if (data.updateAvailable && data.version) {
        const phase = data.phase || 'idle';
        setDesktopUpdate({
          version: data.version,
          downloaded: Boolean(data.downloaded),
          releaseNotes: data.releaseNotes || '',
          phase,
          progress: data.progress ?? 0,
          error: data.error ?? null,
        });
        setUpdateBusy(phase === 'downloading' || phase === 'installing');
      } else {
        setDesktopUpdate(null);
        setUpdateBusy(false);
      }
    });
  }, []);

  // No Electron: se o servidor avisou update, força check do auto-updater
  useEffect(() => {
    if (!window.syncboard?.checkUpdate) return;
    if (!updateStatus?.updateAvailable) return;
    if (desktopUpdate) return;
    void window.syncboard.checkUpdate().then((res) => {
      if (res?.updateAvailable && res.version) {
        setDesktopUpdate({
          version: res.version,
          downloaded: false,
          releaseNotes: res.releaseNotes || '',
          phase: 'idle',
          progress: 0,
        });
      }
    });
  }, [updateStatus?.updateAvailable, desktopUpdate]);

  useEffect(() => {
    const disconnect = connectWebSocket({
      onSync: (h, p) => {
        // Sync inicial: aplica filtros locais se houver busca/filtro ativo
        const fh = h.filter((i) => matchesFilter(i, typeFilter, debouncedSearch, deviceFilter));
        const fp = p.filter((i) => matchesFilter(i, typeFilter, debouncedSearch, deviceFilter));
        setHistory(fh.slice(0, PAGE_SIZE));
        setHistoryTotal(fh.length);
        setPinned(fp.slice(0, PAGE_SIZE));
        setPinnedTotal(fp.length);
        const names = new Set<string>();
        for (const i of [...h, ...p]) if (i.deviceName) names.add(i.deviceName);
        if (names.size) {
          setDevices((prev) => {
            const online = new Set(prev.filter((d) => d.online).map((d) => d.name));
            return [...names]
              .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
              .map((name) => ({ name, online: online.has(name) }));
          });
        }
        setLoading(false);
        void fetchDevices().then((list) => {
          if (list.length) setDevices(list);
        });
      },
      onCreated: (item) => {
        if (item.deviceName) {
          setDevices((prev) => {
            if (prev.some((d) => d.name === item.deviceName)) return prev;
            return [...prev, { name: item.deviceName!, online: false }].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
            );
          });
        }
        if (!matchesFilter(item, typeFilter, debouncedSearch, deviceFilter)) return;
        if (item.pinned) {
          setPinned((prev) => mergeItem(prev, item).slice(0, Math.max(prev.length, PAGE_SIZE)));
          setPinnedTotal((t) => t + 1);
        } else {
          setHistory((prev) => mergeItem(prev, item).slice(0, Math.max(prev.length, PAGE_SIZE)));
          setHistoryTotal((t) => Math.min(t + 1, 100));
        }
      },
      onUpdated: (item) => {
        if (item.pinned) {
          setPinned((prev) => {
            if (!matchesFilter(item, typeFilter, debouncedSearch, deviceFilter)) {
              return removeItem(prev, item.id);
            }
            return mergeItem(prev, item);
          });
          setHistory((prev) => removeItem(prev, item.id));
        } else {
          setHistory((prev) => {
            if (!matchesFilter(item, typeFilter, debouncedSearch, deviceFilter)) {
              return removeItem(prev, item.id);
            }
            return mergeItem(prev, item);
          });
          setPinned((prev) => removeItem(prev, item.id));
        }
      },
      onDeleted: (id) => {
        setHistory((prev) => removeItem(prev, id));
        setPinned((prev) => removeItem(prev, id));
        setHistoryTotal((t) => Math.max(0, t - 1));
        setPinnedTotal((t) => Math.max(0, t - 1));
      },
      onConnectionChange: (ok) => {
        setConnected(ok);
        if (ok) {
          setLocalMode(isUsingLocalFallback());
          void fetchDevices().then((list) => {
            if (list.length) setDevices(list);
          });
        } else setLocalMode(true);
      },
    });
    return disconnect;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers usam filtros atuais via closure intencional no sync
  }, [debouncedSearch, typeFilter, deviceFilter]);

  const applyItemUpdate = useCallback((updated: ClipItem) => {
    if (updated.pinned) {
      setPinned((prev) => mergeItem(prev, updated));
      setHistory((prev) => removeItem(prev, updated.id));
    } else {
      setHistory((prev) => mergeItem(prev, updated));
      setPinned((prev) => removeItem(prev, updated.id));
    }
  }, []);

  const bumpAndCopy = useCallback(
    async (item: ClipItem) => {
      let target = item;

      // Clique no nome-texto do WhatsApp → usa o item Arquivo correspondente
      if (item.type === 'text' && item.content) {
        const match = [...history, ...pinned].find(
          (i) =>
            i.type === 'file' &&
            (i.filename === item.content || i.filename === `${item.content}.mp4`)
        );
        if (match) target = match;
      }

      try {
        // App Electron: o main process faz bump + clipboard + paste
        if (window.syncboard?.pasteItem) {
          const result = await window.syncboard.pasteItem(target);
          if (result?.pasted) return;
          if (target.type === 'file') {
            showToast('Salvo em Downloads/SyncBoard (pasta aberta)');
            return;
          }
          showToast(result?.ok ? 'Copiado — cole com Ctrl/Cmd+V' : 'Não foi possível colar');
          return;
        }

        // Web/Android: bump no histórico + clipboard
        if (!target.pinned) {
          const bumped = await touchItem(target.id);
          applyItemUpdate(bumped);
          target = bumped;
        }

        await copyItemToClipboard(target);
        showToast('Copiado para a área de transferência');
      } catch {
        showToast('Não foi possível copiar — tente baixar');
      }
    },
    [history, pinned, applyItemUpdate, showToast]
  );

  const handleCopy = async (item: ClipItem) => {
    await bumpAndCopy(item);
  };

  const handleSelectItem = (item: ClipItem) => {
    // Clique: move para o topo + cola no clipboard (popup cola no app focado)
    void bumpAndCopy(item);
  };

  const openPinModal = (item: ClipItem) => {
    setPinModalLabel(item.label || '');
    setPinModal({ item });
  };

  const confirmPin = async () => {
    if (!pinModal) return;
    try {
      const updated = await updateItem(pinModal.item.id, {
        pinned: true,
        label: pinModalLabel.trim() || undefined,
      });
      applyItemUpdate(updated);
      setTab('pinned');
      setPinModal(null);
      showToast('Fixado em Fixo');
    } catch {
      showToast('Erro ao fixar');
    }
  };

  const handleCreatePin = async () => {
    const label = createFixedLabel.trim();
    const content = createFixedContent.trim();
    if (!label || !content) return;
    try {
      const created = await createText(content, { pinned: true, label });
      setPinned((prev) => mergeItem(prev, created));
      setPinnedTotal((t) => t + 1);
      setCreateFixedLabel('');
      setCreateFixedContent('');
      setCreateFixedModal(false);
      setTab('pinned');
      showToast('Item fixo criado');
    } catch {
      showToast('Erro ao criar');
    }
  };

  const handleUnpin = async (item: ClipItem) => {
    try {
      const updated = await updateItem(item.id, { pinned: false });
      applyItemUpdate(updated);
      showToast('Removido de Fixo');
    } catch {
      showToast('Erro');
    }
  };

  const handleDelete = async (item: ClipItem, opts?: { skipConfirm?: boolean }) => {
    // No popup do atalho, confirm() nativo tira o foco e a janela some
    const skip = opts?.skipConfirm || isCompactView;
    if (!skip && !confirm('Excluir este item?')) return;
    try {
      await deleteItem(item.id);
      showToast('Excluído');
    } catch {
      showToast('Erro ao excluir');
    }
  };

  const openItemContextMenu = (item: ClipItem, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - 8));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - 8));
    setContextMenu({ item, x, y });
  };

  const saveSettings = () => {
    setServerUrl(serverInput.trim());
    setDeviceName(deviceName.trim() || getDeviceName());
    setDeviceNameState(getDeviceName());
    setShowSettings(false);
    window.location.reload();
  };

  const handleJoinCode = async () => {
    if (!joinCode.trim()) return;
    setJoining(true);
    try {
      const { serverUrl } = await joinWithCodeWeb(joinCode.trim());
      setServerInput(serverUrl);
      showToast(`Conectado a ${serverUrl}`);
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      showToast((err as Error).message || 'Falha ao parear');
    } finally {
      setJoining(false);
    }
  };

  const handleRegeneratePair = async () => {
    try {
      const info = await regeneratePairCode();
      setPairInfo(info);
      showToast('Novo código gerado');
    } catch {
      showToast('Erro ao regenerar');
    }
  };

  const updateVersion = desktopUpdate?.version || updateStatus?.latest || '';
  const showUpdateBanner = Boolean(
    !isCompactView && (desktopUpdate || updateStatus?.updateAvailable)
  );
  const canAutoUpdate = Boolean(window.syncboard?.downloadUpdate);
  const updatePhase = desktopUpdate?.phase || 'idle';
  const updateProgress = desktopUpdate?.progress ?? 0;

  const startAutoUpdate = async () => {
    if (!window.syncboard?.downloadUpdate) return;
    setUpdateBusy(true);
    try {
      if (!desktopUpdate && window.syncboard.checkUpdate) {
        await window.syncboard.checkUpdate();
      }
      const result = await window.syncboard.downloadUpdate();
      if (result && result.ok === false) {
        showToast(result.error || 'Falha ao atualizar');
        setUpdateBusy(false);
      }
      // sucesso: o app reinicia via quitAndInstall
    } catch (err) {
      showToast((err as Error).message || 'Falha ao atualizar');
      setUpdateBusy(false);
    }
  };

  const openWhatsNew = async () => {
    setShowWhatsNew(true);
    let notes = desktopUpdate?.releaseNotes || updateStatus?.releaseNotes || '';
    if (!notes && window.syncboard?.getUpdateNotes) {
      const res = await window.syncboard.getUpdateNotes();
      notes = res?.releaseNotes || '';
      if (res?.releaseNotes && desktopUpdate) {
        setDesktopUpdate({ ...desktopUpdate, releaseNotes: res.releaseNotes });
      }
    }
    setWhatsNewNotes(notes.trim() || 'Nenhuma nota de versão disponível para este release.');
  };

  const items = tab === 'pinned' ? pinned : history;
  const total = tab === 'pinned' ? pinnedTotal : historyTotal;
  const hasMore = items.length < total;

  const countLabel = useMemo(() => {
    if (debouncedSearch || typeFilter !== 'all') {
      return `${total}`;
    }
    return `${total}`;
  }, [debouncedSearch, typeFilter, total]);

  return (
    <div className={`app${isCompactView ? ' compact' : ''}`}>
      <header className="header">
        <div className="header-left">
          <div className="logo">SyncBoard</div>
          <span
            className={`status ${connected && !localMode ? 'online' : 'offline'}`}
            title={
              connected && !localMode
                ? 'Conectado ao servidor'
                : 'Modo local — clipboard neste aparelho (histórico e Fixo em cache)'
            }
          >
            {connected && !localMode ? '●' : '○ local'}
          </span>
        </div>
        {!isCompactView && (
          <button className="icon-btn" onClick={() => setShowSettings(!showSettings)} title="Configurações">
            ⚙
          </button>
        )}
      </header>

      {showUpdateBanner && (
        <div className="update-banner">
          <div className="update-banner-main">
            <div>
              <strong>Nova versão disponível</strong>
              <span>
                {desktopUpdate
                  ? `App ${desktopUpdate.version}`
                  : `v${updateStatus?.latest} (atual: ${updateStatus?.current})`}
              </span>
            </div>
            <div className="update-actions">
              <button className="btn sm" type="button" onClick={() => void openWhatsNew()}>
                O que há de novo
              </button>
              {canAutoUpdate ? (
                <button
                  className="btn sm primary"
                  type="button"
                  disabled={updateBusy || updatePhase === 'installing'}
                  onClick={() => void startAutoUpdate()}
                >
                  {updatePhase === 'downloading'
                    ? `Baixando ${updateProgress}%`
                    : updatePhase === 'installing'
                      ? 'Instalando…'
                      : desktopUpdate?.downloaded
                        ? 'Instalar e reiniciar'
                        : 'Baixar e instalar'}
                </button>
              ) : (
                <a
                  className="btn sm primary"
                  href={updateStatus?.downloadPage || updateStatus?.assets?.macDmg || '#'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Baixar
                </a>
              )}
            </div>
          </div>
          {(updatePhase === 'downloading' || updatePhase === 'installing') && (
            <div className="update-progress-block">
              <div className="update-progress-label">
                {updatePhase === 'downloading' ? 'Download' : 'Instalação'}
                <span>{Math.round(updateProgress)}%</span>
              </div>
              <div className="update-progress-track" role="progressbar" aria-valuenow={updateProgress} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className={`update-progress-fill${updatePhase === 'installing' ? ' installing' : ''}`}
                  style={{ width: `${Math.max(4, Math.min(100, updateProgress))}%` }}
                />
              </div>
            </div>
          )}
          {desktopUpdate?.error && (
            <p className="update-error">{desktopUpdate.error}</p>
          )}
        </div>
      )}

      {showWhatsNew && (
        <div className="modal-overlay" onClick={() => setShowWhatsNew(false)}>
          <div className="modal modal-form" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="whats-new-title">
            <h3 id="whats-new-title">O que há de novo{updateVersion ? ` · v${updateVersion}` : ''}</h3>
            <pre className="whats-new-body">{whatsNewNotes}</pre>
            <div className="modal-footer">
              <button className="btn" type="button" onClick={() => setShowWhatsNew(false)}>Fechar</button>
              {canAutoUpdate && (
                <button
                  className="btn primary"
                  type="button"
                  disabled={updateBusy}
                  onClick={() => {
                    setShowWhatsNew(false);
                    void startAutoUpdate();
                  }}
                >
                  Baixar e instalar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="settings-panel">
          {pairInfo ? (
            <div className="pair-panel">
              <div className="pair-title">Conectar dispositivos</div>
              <p className="hint">Na mesma Wi‑Fi: escaneie o QR ou digite o código no outro aparelho.</p>
              <div className="pair-code">{pairInfo.code}</div>
              {pairQrDataUrl ? (
                <img className="pair-qr" alt={`QR ${pairInfo.code}`} src={pairQrDataUrl} />
              ) : (
                <p className="hint">Gerando QR…</p>
              )}
              <p className="hint mono">{pairInfo.url}</p>
              {pairInfo.urls?.length > 1 && (
                <p className="hint mono">{pairInfo.urls.slice(1).join(' · ')}</p>
              )}
              <button className="btn sm" type="button" onClick={() => void handleRegeneratePair()}>
                Regenerar código
              </button>
            </div>
          ) : (
            <div className="pair-panel">
              <div className="pair-title">Código / QR indisponível</div>
              <p className="hint">
                O servidor conectado não expõe pareamento. Se este Mac for o host, reinicie o SyncBoard
                (ou o processo na porta 8787) e abra as configurações de novo.
              </p>
            </div>
          )}

          <div className="discover-panel">
            <div className="discover-head">
              <div className="pair-title">Servidores na rede</div>
              <button
                className="btn sm"
                type="button"
                disabled={discovering}
                onClick={() => void scanLanServers()}
              >
                {discovering ? 'Buscando…' : 'Buscar de novo'}
              </button>
            </div>
            <p className="hint">Dispositivos com SyncBoard aberto na mesma Wi‑Fi.</p>
            {discovering && !lanServers.length && (
              <p className="hint">Procurando na rede…</p>
            )}
            {!discovering && discoverError && !lanServers.length && (
              <p className="hint">{discoverError}</p>
            )}
            {lanServers.length > 0 && (
              <ul className="discover-list">
                {lanServers.map((s) => {
                  const current = serverInput.replace(/\/$/, '') === s.serverUrl;
                  const label = s.hostname || s.serverUrl.replace(/^https?:\/\//, '');
                  return (
                    <li key={s.serverUrl}>
                      <button
                        type="button"
                        className={`discover-item${current ? ' active' : ''}`}
                        onClick={() => selectLanServer(s.serverUrl)}
                      >
                        <span className="discover-name">{label}</span>
                        <span className="discover-meta mono">
                          {s.serverUrl}
                          {s.code ? ` · ${s.code}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <label>
            Entrar com código do servidor
            <div className="join-row">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="Ex: A3K9P2"
                maxLength={8}
              />
              <button
                className="btn primary"
                type="button"
                disabled={joining || !joinCode.trim()}
                onClick={() => void handleJoinCode()}
              >
                {joining ? '…' : 'Parear'}
              </button>
            </div>
          </label>

          <label>
            URL do servidor
            <input
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
              placeholder="http://192.168.1.10:8787"
            />
          </label>
          <label>
            Nome deste dispositivo
            <input
              value={deviceName}
              onChange={(e) => setDeviceNameState(e.target.value)}
              placeholder="MacBook, Windows-PC, Linux..."
            />
          </label>
          <button className="btn primary" onClick={saveSettings}>Salvar e reconectar</button>
          <p className="hint">No Android, escaneie o QR ou digite o código na tela de pareamento do app.</p>
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'history' ? 'tab active' : 'tab'} onClick={() => setTab('history')}>
          Histórico ({tab === 'history' ? countLabel : historyTotal})
        </button>
        <button className={tab === 'pinned' ? 'tab active' : 'tab'} onClick={() => setTab('pinned')}>
          Fixo ({tab === 'pinned' ? countLabel : pinnedTotal})
        </button>
      </div>

      {tab === 'pinned' && !isCompactView && (
        <div className="pin-create">
          <button className="btn" onClick={() => setCreateFixedModal(true)}>+ Novo item fixo</button>
        </div>
      )}

      <div className="search-zone">
        <input
          className="search-input"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar no histórico..."
          autoFocus={isCompactView}
        />
        <div className="filter-row" role="group" aria-label="Filtros por tipo">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`filter-chip${typeFilter === f.id ? ' active' : ''}`}
              onClick={() => setTypeFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {devices.length > 0 && (
          <div className="filter-row device-filter-row" role="group" aria-label="Filtros por dispositivo">
            <button
              type="button"
              className={`filter-chip${deviceFilter === '' ? ' active' : ''}`}
              onClick={() => setDeviceFilter('')}
            >
              Todos dispositivos
            </button>
            {devices.map((d) => (
              <button
                key={d.name}
                type="button"
                className={`filter-chip device-chip${deviceFilter === d.name ? ' active' : ''}`}
                style={{ ['--device-accent' as string]: deviceAccent(d.name) }}
                onClick={() => setDeviceFilter(d.name)}
                title={d.name}
              >
                <span className={`device-dot${d.online ? ' online' : ''}`} aria-hidden />
                {shortDeviceLabel(d.name)}
              </button>
            ))}
          </div>
        )}
      </div>

      <main className="items-grid">
        {loading && <div className="empty">Carregando...</div>}
        {!loading && items.length === 0 && (
          <div className="empty">
            {debouncedSearch || typeFilter !== 'all' || deviceFilter
              ? 'Nenhum item corresponde à busca/filtro.'
              : tab === 'pinned'
                ? 'Nenhum item fixo. Fixe algo do histórico ou crie um novo.'
                : localMode
                  ? 'Nada no histórico local. Copie algo neste aparelho — fica disponível aqui mesmo offline.'
                  : 'Nada no histórico. Copie algo para sincronizar.'}
          </div>
        )}
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            onCopy={() => handleCopy(item)}
            onSelect={() => handleSelectItem(item)}
            onPin={() => openPinModal(item)}
            onUnpin={() => handleUnpin(item)}
            onDelete={() => handleDelete(item)}
            onContextMenu={(e) => openItemContextMenu(item, e)}
            isPinnedTab={tab === 'pinned'}
            compact={isCompactView}
          />
        ))}
      </main>

      {contextMenu && (
        <>
          <div className="ctx-backdrop" onClick={closeContextMenu} onContextMenu={(e) => {
            e.preventDefault();
            closeContextMenu();
          }} />
          <div
            className="ctx-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              className="ctx-item"
              onClick={() => {
                const item = contextMenu.item;
                closeContextMenu();
                void handleCopy(item);
              }}
            >
              Copiar
            </button>
            {contextMenu.item.pinned || tab === 'pinned' ? (
              <button
                type="button"
                role="menuitem"
                className="ctx-item"
                onClick={() => {
                  const item = contextMenu.item;
                  closeContextMenu();
                  void handleUnpin(item);
                }}
              >
                Desfixar
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="ctx-item"
                onClick={() => {
                  const item = contextMenu.item;
                  closeContextMenu();
                  openPinModal(item);
                }}
              >
                Fixar
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="ctx-item danger"
              onClick={() => {
                const item = contextMenu.item;
                closeContextMenu();
                void handleDelete(item, { skipConfirm: true });
              }}
            >
              Excluir
            </button>
          </div>
        </>
      )}

      {!loading && hasMore && (
        <div className="pagination">
          <button
            className="btn"
            disabled={loadingMore}
            onClick={() => void loadPage({ reset: false, pinnedTab: tab === 'pinned' })}
          >
            {loadingMore ? 'Carregando...' : `Carregar mais (${items.length}/${total})`}
          </button>
        </div>
      )}

      {pinModal && (
        <div className="modal-overlay" onClick={() => setPinModal(null)}>
          <div className="modal modal-form" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Fixar item</h2>
              <button className="icon-btn" onClick={() => setPinModal(null)}>✕</button>
            </div>
            <label className="form-label">
              Nome (ex: Senha Wi-Fi)
              <input
                className="form-input"
                value={pinModalLabel}
                onChange={(e) => setPinModalLabel(e.target.value)}
                placeholder="Opcional"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && confirmPin()}
              />
            </label>
            <div className="modal-footer">
              <button className="btn" onClick={() => setPinModal(null)}>Cancelar</button>
              <button className="btn primary" onClick={confirmPin}>Fixar</button>
            </div>
          </div>
        </div>
      )}

      {createFixedModal && (
        <div className="modal-overlay" onClick={() => setCreateFixedModal(false)}>
          <div className="modal modal-form" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Novo item fixo</h2>
              <button className="icon-btn" onClick={() => setCreateFixedModal(false)}>✕</button>
            </div>
            <label className="form-label">
              Nome
              <input
                className="form-input"
                value={createFixedLabel}
                onChange={(e) => setCreateFixedLabel(e.target.value)}
                placeholder="Senha Wi-Fi, Código 2FA..."
                autoFocus
              />
            </label>
            <label className="form-label">
              Conteúdo
              <textarea
                className="form-input"
                value={createFixedContent}
                onChange={(e) => setCreateFixedContent(e.target.value)}
                placeholder="Texto, senha ou código..."
                rows={3}
              />
            </label>
            <div className="modal-footer">
              <button className="btn" onClick={() => setCreateFixedModal(false)}>Cancelar</button>
              <button className="btn primary" onClick={handleCreatePin}>Criar</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ItemCard({
  item,
  onCopy,
  onSelect,
  onPin,
  onUnpin,
  onDelete,
  onContextMenu,
  isPinnedTab,
  compact,
}: {
  item: ClipItem;
  onCopy: () => void;
  onSelect: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onDelete: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  isPinnedTab: boolean;
  compact?: boolean;
}) {
  const kind = itemDisplayKind(item);

  const from = item.deviceName?.trim() || '';

  return (
    <article className={`card type-${kind}`} onClick={onSelect} onContextMenu={onContextMenu}>
      <div className="card-header">
        <div className="card-badges">
          <span className="badge">{itemKindLabel(item)}</span>
          {from && (
            <span
              className="device-badge"
              style={{ ['--device-accent' as string]: deviceAccent(from) }}
              title={`De ${from}`}
            >
              {shortDeviceLabel(from)}
            </span>
          )}
        </div>
        <span className="time">{formatTime(item.updatedAt)}</span>
      </div>

      {item.label && <div className="card-label">{item.label}</div>}

      {item.type === 'text' && (
        <p className="card-text">{item.content?.slice(0, 200)}{(item.content?.length ?? 0) > 200 ? '…' : ''}</p>
      )}

      {item.type === 'image' && (
        <img className="card-image" src={blobUrl(item)} alt={item.filename || 'imagem'} loading="lazy" />
      )}

      {item.type === 'file' && (
        <div className="card-file">
          <span className="file-icon">{kind === 'video' ? '🎬' : '📎'}</span>
          <span>{item.filename}</span>
          <span className="file-size">{formatSize(item.size)}</span>
        </div>
      )}

      {!compact && (
        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn sm primary" onClick={onCopy}>Copiar</button>
          {isPinnedTab ? (
            <button className="btn sm" onClick={onUnpin}>Desfixar</button>
          ) : (
            <button className="btn sm" onClick={onPin}>Fixar</button>
          )}
          <button className="btn sm danger" onClick={onDelete}>Excluir</button>
        </div>
      )}
    </article>
  );
}
