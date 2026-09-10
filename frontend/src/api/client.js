export const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api/v1';
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'StreamFlix';

/**
 * Everything below the /api/v1 prefix flows through here. Two things make this more than a
 * fetch wrapper:
 *
 *  - The access token lives in memory only (never localStorage) and is attached as a Bearer
 *    header. It is short-lived on purpose, so losing it on a hard refresh is fine — `boot()`
 *    below trades the httpOnly refresh cookie for a new one before the app renders.
 *  - A single 401 triggers exactly one refresh-and-retry. Concurrent requests share the same
 *    in-flight refresh instead of each racing the endpoint, which is what would otherwise
 *    revoke each other's rotated refresh token.
 */
let accessToken = null;
let refreshPromise = null;
let onAuthChange = () => {};

export function setAccessToken(token) {
  accessToken = token || null;
}

export function getAccessToken() {
  return accessToken;
}

/** Called by AuthContext so this module can clear app state on a hard sign-out. */
export function onAuthLost(handler) {
  onAuthChange = handler;
}

class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message || 'Something went wrong');
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

async function parseError(res) {
  try {
    const body = await res.json();
    const err = body?.error || {};
    return new ApiError(res.status, err.code || 'UNKNOWN', err.message, err.details, err.requestId);
  } catch {
    return new ApiError(res.status, 'UNKNOWN', res.statusText || 'Request failed');
  }
}

async function doRefresh() {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  setAccessToken(data.accessToken);
  return data;
}

/** Exported so the app shell can silently resume a session on first paint. */
export async function refreshSession() {
  if (!refreshPromise) refreshPromise = doRefresh().finally(() => (refreshPromise = null));
  return refreshPromise;
}

/**
 * @param {string} path e.g. '/catalog/browse' — joined onto API_BASE.
 * @param {object} opts fetch-like options, plus `raw` (skip JSON parse/stringify) and
 *   `skipAuthRetry` (used by the refresh call itself to avoid recursing).
 */
export async function apiFetch(path, opts = {}) {
  const { raw = false, skipAuthRetry = false, headers = {}, body, ...rest } = opts;

  const doRequest = () => {
    const finalHeaders = { ...headers };
    if (!raw && body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) {
      finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    }
    if (accessToken) finalHeaders.Authorization = `Bearer ${accessToken}`;

    return fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      ...rest,
      headers: finalHeaders,
      body:
        body === undefined || raw || body instanceof FormData || body instanceof Blob
          ? body
          : JSON.stringify(body),
    });
  };

  let res = await doRequest();

  if (res.status === 401 && !skipAuthRetry && !path.startsWith('/auth/refresh')) {
    try {
      await refreshSession();
      res = await doRequest();
    } catch {
      setAccessToken(null);
      onAuthChange();
    }
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (raw || !contentType.includes('application/json')) return res;
  return res.json();
}

export { ApiError };
export default apiFetch;
