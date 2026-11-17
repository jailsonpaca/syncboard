import { useState } from 'react';
import { TOOLS } from './registry';
import type { ToolProps } from './common';
import './tools.css';

const STORAGE_KEY = 'syncboard.tools.last';

function loadLast(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && TOOLS.some((t) => t.id === v)) return v;
  } catch {
    /* sem storage */
  }
  return TOOLS[0].id;
}

export function ToolsTab({ onToast }: ToolProps) {
  const [active, setActive] = useState(loadLast);
  const tool = TOOLS.find((t) => t.id === active) ?? TOOLS[0];
  const Active = tool.component;
  const groups = Array.from(new Set(TOOLS.map((t) => t.group)));

  const select = (id: string) => {
    setActive(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignora */
    }
  };

  return (
    <section className="tools-tab">
      <nav className="tools-nav" aria-label="Ferramentas">
        {groups.map((g) => (
          <div key={g} className="tools-group">
            <span className="tools-group-label">{g}</span>
            {TOOLS.filter((t) => t.group === g).map((t) => (
              <button key={t.id} type="button" className={t.id === tool.id ? 'chip active' : 'chip'} onClick={() => select(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="tools-body">
        <h2 className="tools-title">{tool.label}</h2>
        <Active key={tool.id} onToast={onToast} />
      </div>
    </section>
  );
}
