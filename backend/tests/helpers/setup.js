import os from 'node:os';
import path from 'node:path';

/**
 * Test environment.
 *
 * This module is imported first by every test file, before anything that reads config —
 * ESM evaluates dependencies in declaration order, so setting `process.env` here still
 * happens before `src/config/env.js` parses it. `dotenv` never overrides values that are
 * already set, so a developer's `.env` cannot change what the tests assume.
 *
 * Connection strings are deliberately *not* forced: integration tests run against whatever
 * Postgres/Redis/DynamoDB the developer already has (docker compose up postgres redis
 * dynamodb), and skip themselves when there is none.
 */
const overrides = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  METRICS_ENABLED: 'false',

  // Deterministic, obviously-fake secrets. Long enough to satisfy the config schema.
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789',
  PLAYBACK_TOKEN_SECRET: 'test-playback-secret-0123456789',
  PAYMENTS_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',

  // Local drivers only: no test should ever reach for an AWS credential.
  STORAGE_DRIVER: 'local',
  TRANSCODER_DRIVER: 'ffmpeg',
  CDN_DRIVER: 'local',
  LOCAL_STORAGE_DIR: path.join(os.tmpdir(), 'streamflix-test-storage'),

  // Rate limits exist and are tested on their own; they must not make a suite flaky.
  RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',

  // A public sample manifest, so seeded titles are playable without transcoding anything.
  DEMO_HLS_URL: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
};

for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

export default overrides;
