import '@mantine/core/styles.css';
import './theme/focus.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/index.js';

const container = document.getElementById('root');
if (container === null) throw new Error('index.html has no #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
