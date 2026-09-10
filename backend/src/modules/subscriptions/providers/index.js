import config from '../../../config/env.js';
import mockProvider from './mockProvider.js';

/**
 * Payment provider registry. One entry today; the point is that the service layer talks to
 * `provider.charge(...)` and never to a vendor SDK, so adding Razorpay or Stripe is a new
 * file here plus one env value — not a rewrite of the billing service.
 */
const providers = { mock: mockProvider };

export const provider = providers[config.payments.provider] ?? mockProvider;

export default provider;
