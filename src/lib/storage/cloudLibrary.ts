import { ADMIN_PASSWORD } from '../adminAuth';

export function cloudLibraryBaseUrl(): string | undefined {
  const value = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim();
  if (!value) return undefined;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function hasCloudLibrary(): boolean {
  return !!cloudLibraryBaseUrl();
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // Fall back to the HTTP status below.
  }
  return `HTTP ${response.status}`;
}

export async function cloudLibraryRequest(
  path: string,
  init: RequestInit = {},
  authenticate = false,
): Promise<Response> {
  const base = cloudLibraryBaseUrl();
  if (!base) throw new Error('공유 라이브러리 서버가 연결되지 않았습니다.');
  const headers = new Headers(init.headers);
  if (authenticate) headers.set('Authorization', `Bearer ${ADMIN_PASSWORD}`);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(await errorDetail(response));
  return response;
}

export async function cloudLibraryJson<T>(
  path: string,
  init: RequestInit = {},
  authenticate = false,
): Promise<T> {
  const response = await cloudLibraryRequest(path, init, authenticate);
  return (await response.json()) as T;
}
