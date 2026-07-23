export type ItemType = 'text' | 'image' | 'file';

export interface ClipItem {
  id: string;
  type: ItemType;
  content: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number;
  pinned: boolean;
  label: string | null;
  deviceName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WsMessage {
  type: 'item_created' | 'item_updated' | 'item_deleted' | 'sync_request';
  item?: ClipItem;
  id?: string;
}
