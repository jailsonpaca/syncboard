import type { WebSocket } from 'ws';
import type { ClipItem, WsMessage } from './types.js';

export class Hub {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
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
