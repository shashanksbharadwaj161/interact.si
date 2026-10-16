import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceProvider } from '../src/ui/appearance-context';
import { Prototype } from './Prototype';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/components.css';
import '../src/styles/companion.css';
import './prototype.css';

// Experience prototype: an isolated design study of the desktop companion's form. It is not part of the production
// renderer build (see vite.prototype.config.mjs) and makes no AI, microphone or screen-capture calls.
document.documentElement.dataset.theme = 'dark';
document.documentElement.dataset.motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppearanceProvider>
      <Prototype />
    </AppearanceProvider>
  </StrictMode>,
);
