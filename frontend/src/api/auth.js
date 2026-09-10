import apiFetch, { setAccessToken } from './client.js';

export async function register({ email, password, fullName }) {
  const data = await apiFetch('/auth/register', { method: 'POST', body: { email, password, fullName } });
  setAccessToken(data.accessToken);
  return data;
}

export async function login({ email, password }) {
  const data = await apiFetch('/auth/login', { method: 'POST', body: { email, password } });
  setAccessToken(data.accessToken);
  return data;
}

export async function logout({ everywhere = false } = {}) {
  try {
    await apiFetch('/auth/logout', { method: 'POST', body: { everywhere } });
  } finally {
    setAccessToken(null);
  }
}

export function me() {
  return apiFetch('/auth/me');
}

export function sessions() {
  return apiFetch('/auth/sessions');
}

export function changePassword({ currentPassword, newPassword }) {
  return apiFetch('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
}
