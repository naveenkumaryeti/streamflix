import apiFetch from './client.js';

export const listPlans = () => apiFetch('/subscriptions/plans');
export const currentSubscription = () => apiFetch('/subscriptions/me');
export const subscribe = ({ planCode, card, idempotencyKey }) =>
  apiFetch('/subscriptions', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    body: { planCode, card, idempotencyKey },
  });
export const cancelSubscription = ({ immediate = false, reason } = {}) =>
  apiFetch('/subscriptions/cancel', { method: 'POST', body: { immediate, reason } });
export const resumeSubscription = () => apiFetch('/subscriptions/resume', { method: 'POST' });
export const payments = (params) => {
  const search = new URLSearchParams();
  if (params?.page) search.set('page', params.page);
  if (params?.limit) search.set('limit', params.limit);
  const str = search.toString();
  return apiFetch(`/subscriptions/payments${str ? `?${str}` : ''}`);
};
