import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { bootstrapDesktopConfig, installDesktopBridge } from './desktopBridge';
import './index.css';

installDesktopBridge();

void bootstrapDesktopConfig().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
