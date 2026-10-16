import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {AppearanceProvider} from '../ui/appearance-context';
import {CompanionApp} from './CompanionApp';
import {RegionOverlay} from './RegionOverlay';
import '../styles/tokens.css';
import '../styles/companion.css';
import '../styles/island.css';

document.documentElement.dataset.theme = 'dark';
document.documentElement.dataset.motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full';

const overlay = location.hash === '#overlay';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppearanceProvider>{overlay ? <RegionOverlay /> : <CompanionApp />}</AppearanceProvider>
  </StrictMode>,
);
