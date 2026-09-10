import apiFetch from './client.js';

export const startPlayback = (titleId, body = {}) => apiFetch(`/playback/${titleId}/start`, { method: 'POST', body });
export const pingProgress = (titleId, body) => apiFetch(`/playback/${titleId}/progress`, { method: 'POST', body });
export const stopPlayback = (titleId, body = {}) => apiFetch(`/playback/${titleId}/stop`, { method: 'POST', body });
export const history = (params) => {
  const search = new URLSearchParams();
  if (params?.limit) search.set('limit', params.limit);
  if (params?.includeCompleted !== undefined) search.set('includeCompleted', params.includeCompleted);
  const str = search.toString();
  return apiFetch(`/playback/history${str ? `?${str}` : ''}`);
};
export const activeStreams = () => apiFetch('/playback/streams');
export const forgetProgress = (titleId) => apiFetch(`/playback/progress/${titleId}`, { method: 'DELETE' });
