import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './state/store';
import { App } from './App';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('root element not found');

createRoot(el).render(
  <React.StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </React.StrictMode>,
);
