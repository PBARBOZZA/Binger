export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}/api${path}`, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Não foi possível concluir.'); }
  return response.status === 204 ? undefined as T : response.json();
}
