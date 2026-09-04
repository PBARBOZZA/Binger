export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function apiUrl(path: string) {
  return `${API_URL}/api${path}`;
}

function requestHeaders(options: RequestInit) {
  const headers = new Headers(options.headers);
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return headers;
}

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
}

/** JSON API helper. Session cookies are deliberately included for every request. */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    credentials: 'include',
    headers: requestHeaders(options)
  });
  if (!response.ok) throw await responseError(response, 'Não foi possível concluir.');
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

/** Uploads private image bytes through HTTP rather than Socket.IO. */
export async function uploadPrivateImage<T>(conversationId: string, image: File): Promise<T> {
  return api<T>(`/private-conversations/${encodeURIComponent(conversationId)}/images`, {
    method: 'POST',
    body: image,
    headers: { 'Content-Type': image.type || 'application/octet-stream' }
  });
}

/** Fetches protected media as a short-lived browser object URL source. */
export async function fetchPrivateImage(mediaId: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/private-images/${encodeURIComponent(mediaId)}`), {
    credentials: 'include',
    headers: { Accept: 'image/*' }
  });
  // Keep unavailable, deleted, expired, and unauthorized media indistinguishable in the UI.
  if (!response.ok) throw new Error('Imagem indisponível.');
  return response.blob();
}

export async function deletePrivateMessage(messageId: string): Promise<void> {
  await api<void>(`/private-messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
}
