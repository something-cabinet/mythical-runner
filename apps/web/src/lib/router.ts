import { useSyncExternalStore } from 'react';

/**
 * A two-route router: `/` and `/r/:code`. Not worth a dependency.
 *
 * The server's asset config falls back to index.html for unknown paths, so a shared
 * `/r/K3PQ` link loads the app directly.
 */

const NAVIGATE = 'mr:navigate';

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE, listener);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export function navigate(path: string, replace = false): void {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE));
}

export type Route = { readonly name: 'home' } | { readonly name: 'room'; readonly code: string };

export function matchRoute(path: string): Route {
  const m = /^\/r\/([A-Za-z0-9]{4})\/?$/.exec(path);
  return m?.[1] ? { name: 'room', code: m[1].toUpperCase() } : { name: 'home' };
}

export function roomLink(code: string): string {
  return `${location.origin}/r/${code}`;
}
