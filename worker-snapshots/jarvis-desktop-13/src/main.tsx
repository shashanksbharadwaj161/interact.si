import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/views.css';
import './styles/avatar.css';
import './styles/responsive.css';
import { App } from './components/App';
import { AppProvider } from './ui/store';
import { FocusProvider } from './ui/focus';
import { createPreviewBridge } from './preview';

// Electron's preload exposes window.jarvis. Without it (plain browser) we install the clearly labelled
// preview bridge so the interface can be reviewed; it never simulates native, AI or voice features.
const isPreview = typeof window.jarvis === 'undefined';
if (isPreview) window.jarvis = createPreviewBridge();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <AppProvider api={window.jarvis} isPreview={isPreview}>
      <FocusProvider>
        <App />
      </FocusProvider>
    </AppProvider>
  </StrictMode>,
);
