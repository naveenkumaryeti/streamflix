import apiFetch from './client.js';

const qs = (params = {}) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  const str = search.toString();
  return str ? `?${str}` : '';
};

export const browse = () => apiFetch('/browse');
export const listTitles = (params) => apiFetch(`/titles${qs(params)}`);
export const getTitle = (slug) => apiFetch(`/titles/${encodeURIComponent(slug)}`);
export const search = (q, params) => apiFetch(`/search${qs({ q, ...params })}`);
export const suggest = (q, limit = 8) => apiFetch(`/suggest${qs({ q, limit })}`);
export const genres = () => apiFetch('/genres');
export const facets = () => apiFetch('/facets');

export const continueWatching = () => apiFetch('/continue-watching');
export const myList = (params) => apiFetch(`/my-list${qs(params)}`);
export const addToMyList = (titleId) => apiFetch(`/my-list/${titleId}`, { method: 'PUT' });
export const removeFromMyList = (titleId) => apiFetch(`/my-list/${titleId}`, { method: 'DELETE' });
