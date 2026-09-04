import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExtensionApp } from './ExtensionApp';
import '../styles.css';

function applyTheme(theme: chrome.devtools.panels.Theme): void {
  document.documentElement.dataset.devtoolsTheme = theme;
}

applyTheme(chrome.devtools.panels.themeName);
chrome.devtools.panels.setThemeChangeHandler(applyTheme);

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

createRoot(root).render(
  <React.StrictMode>
    <ExtensionApp />
  </React.StrictMode>,
);