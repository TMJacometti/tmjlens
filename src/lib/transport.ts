import { invoke as bridgeInvoke } from '@tauri-apps/api/core';
import { listen as bridgeListen } from '@tauri-apps/api/event';

/**
 * The one place the frontend decides how a command travels.
 *
 * With the Tauri bridge present (the desktop shell, or the preview stub that
 * fakes it for Playwright fixtures) commands go through IPC exactly as before.
 * Without it — the web build — the same names and arguments go to the axum
 * server as `POST /api/invoke/{command}`, and errors come back as the same
 * plain strings the screens already know how to show.
 */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (hasBridge()) return bridgeInvoke<T>(command, args);
  if (command === 'save_to_downloads' || command === 'save_bytes_to_downloads') {
    return browserDownload(command, args) as T;
  }
  const response = await fetch(`/api/invoke/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(args ?? {}),
  });
  if (response.status === 401) {
    // The session is gone; only the IdP can mint a new one. The throw keeps
    // the caller's error path coherent during the moment before navigation.
    window.location.href = '/auth/login';
    throw 'Your session expired — signing you in again.';
  }
  if (!response.ok) {
    throw await response.text();
  }
  return (await response.json()) as T;
}

/**
 * Event subscription. The web build has no event bus yet (streams return when
 * SSE/WebSockets land), so subscribing is a harmless no-op: screens render,
 * and stream-driven features surface their own "not available" errors.
 */
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (hasBridge()) return bridgeListen<T>(event, handler);
  return () => undefined;
}

/**
 * The desktop wrote exports into the OS Downloads folder; a browser already
 * owns that flow. Same command names, same arguments, so no call site changes.
 */
function browserDownload(command: string, args: Record<string, unknown>): string {
  const pick = (snake: string, camel: string): string =>
    String(args[snake] ?? args[camel] ?? '');
  const stem = (pick('file_name', 'fileName') || 'export').replace(/[\\/]/g, '-');

  let blob: Blob;
  let name: string;
  if (command === 'save_bytes_to_downloads') {
    const raw = atob(pick('base64_contents', 'base64Contents'));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    blob = new Blob([bytes], { type: 'application/octet-stream' });
    name = `${stem}.${pick('extension', 'extension') || 'bin'}`;
  } else {
    const pad = (value: number) => String(value).padStart(2, '0');
    const now = new Date();
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const extension = pick('extension', 'extension') || 'log';
    blob = new Blob([pick('contents', 'contents')], { type: 'text/plain;charset=utf-8' });
    name = `${stem}-${stamp}.${extension}`;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
  return name;
}
