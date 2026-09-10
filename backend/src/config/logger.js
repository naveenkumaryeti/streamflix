import pino from 'pino';
import config from './env.js';

/**
 * Structured JSON logs — CloudWatch/Loki parse them without a custom pattern.
 * For readable local output: `npm run dev | npx pino-pretty`.
 */
export const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  base: { service: 'streamflix-api', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-webhook-signature"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.password_hash',
      '*.currentPassword',
      '*.newPassword',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.cardNumber',
      '*.cvv',
    ],
    censor: '[redacted]',
  },
});

export default logger;
