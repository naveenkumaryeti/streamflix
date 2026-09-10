import apiFetch from './client.js';

export const getAccount = () => apiFetch('/users/me');
export const updateProfile = (patch) => apiFetch('/users/me', { method: 'PATCH', body: patch });
export const closeAccount = () => apiFetch('/users/me', { method: 'DELETE', body: { confirm: true } });
