import apiFetch, { API_BASE, getAccessToken } from './client.js';

const qs = (params = {}) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  const str = search.toString();
  return str ? `?${str}` : '';
};

export const dashboard = () => apiFetch('/admin/dashboard');
export const formOptions = () => apiFetch('/admin/options');

export const listTitles = (params) => apiFetch(`/admin/titles${qs(params)}`);
export const getTitle = (id) => apiFetch(`/admin/titles/${id}`);
export const createTitle = (payload) => apiFetch('/admin/titles', { method: 'POST', body: payload });
export const updateTitle = (id, patch) => apiFetch(`/admin/titles/${id}`, { method: 'PATCH', body: patch });
export const deleteTitle = (id) => apiFetch(`/admin/titles/${id}`, { method: 'DELETE' });
export const publishTitle = (id) => apiFetch(`/admin/titles/${id}/publish`, { method: 'POST' });
export const unpublishTitle = (id, status) =>
  apiFetch(`/admin/titles/${id}/unpublish`, { method: 'POST', body: status ? { status } : {} });

export const mediaFor = (id) => apiFetch(`/admin/titles/${id}/media`);
export const startTranscode = (id) => apiFetch(`/admin/titles/${id}/transcode`, { method: 'POST' });

/**
 * The video upload pipeline. Every step is its own request, mirroring how the backend was
 * designed (see media.service.js): a browser upload of several GB must never sit inside one
 * request/response cycle that a proxy or a flaky connection can kill outright.
 *
 *   1. ask for an upload target (works the same whether storage is local or S3)
 *   2. PUT the raw bytes at that target, reporting progress via XHR
 *   3. tell the API the object arrived, so it can HEAD it and create the source asset
 *   4. kick off the transcode job — the worker picks it up from the queue
 *
 * onProgress receives a 0-100 number during the PUT.
 */
export async function requestUploadTarget(titleId, { filename, contentType, sizeBytes }) {
  return apiFetch(`/admin/titles/${titleId}/upload-url`, {
    method: 'POST',
    body: { filename, contentType, sizeBytes },
  });
}

export function uploadToTarget(target, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = target.url.startsWith('http') ? target.url : `${API_BASE.replace(/\/api\/v1$/, '')}${target.url}`;
    xhr.open('PUT', url, true);

    Object.entries(target.headers || {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    // Local-mode uploads land on an admin-only API route, so the same bearer token is needed
    // here as everywhere else — a presigned S3 URL (production) needs no such header.
    if (target.mode === 'api-put') {
      const token = getAccessToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error'));
    xhr.send(file);
  });
}

export function registerSource(titleId, key) {
  return apiFetch(`/admin/titles/${titleId}/source`, { method: 'POST', body: { key } });
}

/** High-level helper the UI calls: upload target -> PUT bytes -> register -> transcode. */
export async function uploadAndTranscode(titleId, file, onProgress) {
  const target = await requestUploadTarget(titleId, {
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  });
  await uploadToTarget(target, file, onProgress);
  await registerSource(titleId, target.key);
  return startTranscode(titleId);
}

export function uploadArtwork(titleId, kind, file) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch(`/admin/titles/${titleId}/artwork/${kind}`, { method: 'POST', body: form });
}

export const listUsers = (params) => apiFetch(`/admin/users${qs(params)}`);
export const setUserStatus = (id, status) =>
  apiFetch(`/admin/users/${id}/status`, { method: 'PATCH', body: { status } });
export const setUserRole = (id, role) => apiFetch(`/admin/users/${id}/role`, { method: 'PATCH', body: { role } });

export const listPayments = (params) => apiFetch(`/admin/payments${qs(params)}`);
export const listAudit = (params) => apiFetch(`/admin/audit${qs(params)}`);
