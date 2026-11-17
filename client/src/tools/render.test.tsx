import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TOOLS } from './registry';
import { ToolsTab } from './ToolsTab';

// Ambiente node: simula o mínimo do browser usado na primeira renderização.
(globalThis as unknown as { window: unknown }).window = {};

describe('ToolsTab', () => {
  it('renderiza a aba com o seletor de todas as ferramentas', () => {
    const html = renderToString(<ToolsTab onToast={() => undefined} />);
    for (const t of TOOLS) expect(html).toContain(t.label.replace('→', '→'));
  });

  it.each(TOOLS.map((t) => [t.id, t] as const))('ferramenta %s renderiza sem erro', (_id, t) => {
    const C = t.component;
    expect(() => renderToString(<C onToast={() => undefined} />)).not.toThrow();
  });

  it('vídeo mostra aviso fora do app desktop', () => {
    const video = TOOLS.find((t) => t.id === 'video')!;
    const C = video.component;
    expect(renderToString(<C onToast={() => undefined} />)).toContain('apenas no app desktop');
  });
});
