import { createRoot } from 'react-dom/client';
import '../../../../docs/design/system/station.ts';
import '../../../../docs/design/system/properties.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/line.css';
import './styles/canary.css';
import './styles/bird.css';
import './styles/reel.css';
import './styles/pictures.css';
import './styles/admin.css';
import './styles/controls.css';
import './styles/needs.css';
import './styles/flags.css';
import { App } from './App.tsx';

// Development only: Preact's checks on hooks, keys and markup. The build leaves it out.
if (import.meta.env.DEV) await import('preact/debug');

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
