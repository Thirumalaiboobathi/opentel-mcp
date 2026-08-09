import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './theme/ThemeProvider';
import { App } from './App';
import './theme/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('opentel-mcp-ui: #root element not found');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
