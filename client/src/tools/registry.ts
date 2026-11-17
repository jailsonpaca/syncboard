import type { ComponentType } from 'react';
import type { ToolProps } from './common';
import {
  Base64Tool, BaseTool, CaseTool, ColorTool, DiffTool, HashTool, HtmlTool, JsonTool, JwtTool,
  LoremTool, PasswordTool, RegexTool, TimestampTool, UrlTool, UuidTool,
} from './tools';
import { RecorderTool } from './RecorderTool';
import { VideoTool } from './VideoTool';

export type ToolDef = { id: string; label: string; group: string; component: ComponentType<ToolProps> };

/** Para adicionar uma ferramenta: crie o componente e registre uma linha aqui. */
export const TOOLS: ToolDef[] = [
  { id: 'video', label: 'Vídeo → MP4 (WhatsApp)', group: 'Mídia', component: VideoTool },
  { id: 'recorder', label: 'Gravador de tela', group: 'Mídia', component: RecorderTool },
  { id: 'json', label: 'JSON', group: 'Formatadores', component: JsonTool },
  { id: 'base64', label: 'Base64', group: 'Encoders', component: Base64Tool },
  { id: 'url', label: 'URL', group: 'Encoders', component: UrlTool },
  { id: 'html', label: 'HTML', group: 'Encoders', component: HtmlTool },
  { id: 'jwt', label: 'JWT', group: 'Encoders', component: JwtTool },
  { id: 'hash', label: 'Hash', group: 'Geradores', component: HashTool },
  { id: 'uuid', label: 'UUID', group: 'Geradores', component: UuidTool },
  { id: 'password', label: 'Senha', group: 'Geradores', component: PasswordTool },
  { id: 'lorem', label: 'Lorem Ipsum', group: 'Geradores', component: LoremTool },
  { id: 'timestamp', label: 'Timestamp', group: 'Conversores', component: TimestampTool },
  { id: 'base', label: 'Base numérica', group: 'Conversores', component: BaseTool },
  { id: 'color', label: 'Cores', group: 'Conversores', component: ColorTool },
  { id: 'case', label: 'Maiúsc./minúsc.', group: 'Texto', component: CaseTool },
  { id: 'diff', label: 'Diff', group: 'Texto', component: DiffTool },
  { id: 'regex', label: 'Regex', group: 'Texto', component: RegexTool },
];
