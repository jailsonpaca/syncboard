import type { WebSocket } from 'ws';
import type { ClipItem, WsMessage } from './types.js';

export type ConnectedDevice = {
  name: string;
  online: boolean;
};

export class Hub {
  private clients = new Set<WebSocket>();
  private deviceByWs = new Map<WebSocket, string>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      this.deviceByWs.delete(ws);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; deviceName?: string };
        if (msg?.type === 'hello' && msg.deviceName) {
          const name = String(msg.deviceName).trim();
          if (name) this.deviceByWs.set(ws, name);
        }
      } catch {
        /* ignore */
      }
    });
  }

  onlineDeviceNames(): string[] {
    return [...new Set([...this.deviceByWs.values()].filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }

  broadcast(message: WsMessage, exclude?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client !== exclude && client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  notifyItemCreated(item: ClipItem): void {
    this.broadcast({ type: 'item_created', item });
  }

  notifyItemUpdated(item: ClipItem): void {
    this.broadcast({ type: 'item_updated', item });
  }

  notifyItemDeleted(id: string): void {
    this.broadcast({ type: 'item_deleted', id });
  }
}
