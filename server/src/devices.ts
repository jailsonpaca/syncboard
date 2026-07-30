export type DeviceInfo = { name: string; online: boolean };

/** Agrupa variantes tipo "Pixel-a1b2" / "Pixel-c3d4" geradas em reconexões. */
function deviceBaseKey(name: string): string {
  const trimmed = name.trim();
  const m = /^(.*)-([a-z0-9]{4})$/i.exec(trimmed);
  if (m) return m[1].toLowerCase();
  return trimmed.toLowerCase();
}

/**
 * Deduplica dispositivos:
 * 1) mesmo nome (case-insensitive)
 * 2) variantes com sufixo aleatório de 4 chars — mantém online(s) ou um só
 */
export function dedupeDevices(devices: DeviceInfo[]): DeviceInfo[] {
  const byExact = new Map<string, DeviceInfo>();
  for (const d of devices) {
    const name = (d.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const prev = byExact.get(key);
    if (!prev || (d.online && !prev.online)) {
      byExact.set(key, { name, online: Boolean(d.online) });
    } else if (d.online) {
      byExact.set(key, { ...prev, online: true });
    }
  }

  const groups = new Map<string, DeviceInfo[]>();
  for (const d of byExact.values()) {
    const base = deviceBaseKey(d.name);
    const list = groups.get(base) || [];
    list.push(d);
    groups.set(base, list);
  }

  const result: DeviceInfo[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const online = group.filter((d) => d.online);
    if (online.length) {
      result.push(...online);
    } else {
      // Mantém só um offline (nome mais curto / estável)
      group.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
      result.push(group[0]);
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
