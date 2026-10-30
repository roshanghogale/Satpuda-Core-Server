import { useState } from 'react';

// Blue (the panel's own colours) is the default; the choice is kept in this browser. The master list check
// (its own app, shown in an iframe on the same site) reads the same key and is told when it changes.
const THEME_KEY = 'satpuda_admin_theme';
const THEMES = [
  ['blue', 'Blue'],
  ['dark', 'Dark'],
  ['light', 'Light'],
];

export function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.some(([k]) => k === t) ? t : 'blue';
  } catch (e) {
    return 'blue';
  }
}

export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('iframe').forEach((f) => {
    try {
      f.contentWindow.postMessage({ theme: t }, window.location.origin);
    } catch (e) {
      /* not loaded yet: it reads the saved theme itself */
    }
  });
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState(savedTheme);
  function pick(t) {
    setTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch (e) {
      /* private window: applies to this page only */
    }
    applyTheme(t);
  }
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {THEMES.map(([k, label]) => (
        <button key={k} type="button" className={theme === k ? 'on' : ''} aria-pressed={theme === k} onClick={() => pick(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}
