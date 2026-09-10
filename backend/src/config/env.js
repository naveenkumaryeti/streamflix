/**
 * Single source of truth for configuration.
 *
 * Rules that keep this safe in production:
 *  - process env (EKS ConfigMap / Secrets Manager) always wins; .env files only fill gaps.
 *  - every value is validated and coerced once, at boot, so no module parses strings again.
 *  - development defaults exist for convenience, but booting production with one is fatal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '../..');
const repoRoot = path.resolve(BACKEND_ROOT, '..');

for (const file of [path.join(BACKEND_ROOT, '.env'), path.join(repoRoot, '.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

const asBool = (fallback) =>
  z.preprocess((v) => {
    if (v === undefined || v === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  }, z.boolean());

const asList = (fallback) =>
  z.preprocess((v) => {
    if (v === undefined || v === '') return fallback;
    return String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }, z.array(z.string()));

const DEV_SECRET = 'dev-only-insecure-secret-change-me-please';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),
  CORS_ORIGINS: asList(['http://localhost:5173', 'http://localhost:3000']),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  METRICS_ENABLED: asBool(true),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(15000),

  DATABASE_URL: z.string().default('postgres://streamflix:streamflix_local_pw@localhost:5432/streamflix'),
  DATABASE_SSL: asBool(false),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_SLOW_QUERY_MS: z.coerce.number().int().default(300),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  AWS_REGION: z.string().default('ap-south-1'),
  DYNAMODB_TABLE_WATCH_PROGRESS: z.string().default('streamflix-dev-watch-progress'),
  DYNAMODB_ENDPOINT: z.string().default(''),

  JWT_ACCESS_SECRET: z.string().min(16).default(DEV_SECRET),
  JWT_REFRESH_SECRET: z.string().min(16).default(`${DEV_SECRET}-refresh`),
  PLAYBACK_TOKEN_SECRET: z.string().min(16).default(`${DEV_SECRET}-playback`),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  PLAYBACK_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(21600),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  TRANSCODER_DRIVER: z.enum(['ffmpeg', 'mediaconvert']).default('ffmpeg'),
  CDN_DRIVER: z.enum(['local', 'cloudfront']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  PUBLIC_MEDIA_BASE_URL: z.string().default('http://localhost:8080/media'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024 * 1024),
  S3_BUCKET_RAW: z.string().default(''),
  S3_BUCKET_PROCESSED: z.string().default(''),
  S3_BUCKET_THUMBNAILS: z.string().default(''),
  MEDIACONVERT_ENDPOINT: z.string().default(''),
  MEDIACONVERT_ROLE_ARN: z.string().default(''),
  MEDIACONVERT_QUEUE_ARN: z.string().default(''),
  CLOUDFRONT_DOMAIN: z.string().default(''),
  CLOUDFRONT_KEY_PAIR_ID: z.string().default(''),
  CLOUDFRONT_PRIVATE_KEY: z.string().default(''),
  CLOUDFRONT_PRIVATE_KEY_PATH: z.string().default(''),
  DEMO_HLS_URL: z.string().default(''),

  PAYMENTS_PROVIDER: z.enum(['mock']).default('mock'),
  PAYMENTS_WEBHOOK_SECRET: z.string().min(8).default('dev-webhook-secret'),
  CURRENCY: z.string().length(3).default('INR'),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // Worker knobs. Concurrency is capped at 8 because each slot is a full ffmpeg process:
  // going wider than the pod's CPU limit makes every job slower, not the queue shorter.
  WORKER_PORT: z.coerce.number().int().positive().default(9090),
  TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  TRANSCODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  TRANSCODE_STALE_MINUTES: z.coerce.number().int().min(5).default(45),
  REMOTE_POLL_SECONDS: z.coerce.number().int().min(5).default(20),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@streamflix.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
  SEED_USER_EMAIL: z.string().email().default('demo@streamflix.local'),
  SEED_USER_PASSWORD: z.string().min(8).default('Demo@12345'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  // Logger depends on config, so this one message goes straight to stderr.
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(78); // EX_CONFIG
}

const e = parsed.data;
const isProduction = e.NODE_ENV === 'production';

if (isProduction) {
  const weak = Object.entries({
    JWT_ACCESS_SECRET: e.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: e.JWT_REFRESH_SECRET,
    PLAYBACK_TOKEN_SECRET: e.PLAYBACK_TOKEN_SECRET,
    PAYMENTS_WEBHOOK_SECRET: e.PAYMENTS_WEBHOOK_SECRET,
  }).filter(([, v]) => v.includes('change-me') || v.includes('dev-only') || v === 'dev-webhook-secret');
  if (weak.length) {
    console.error(`Refusing to start: development secrets in production -> ${weak.map(([k]) => k).join(', ')}`);
    process.exit(78);
  }
}

export const config = {
  env: e.NODE_ENV,
  isProduction,
  isTest: e.NODE_ENV === 'test',
  port: e.PORT,
  logLevel: e.LOG_LEVEL,
  apiPrefix: e.API_PREFIX,
  corsOrigins: e.CORS_ORIGINS,
  trustProxy: e.TRUST_PROXY,
  metricsEnabled: e.METRICS_ENABLED,
  shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  db: {
    url: e.DATABASE_URL,
    ssl: e.DATABASE_SSL,
    poolMax: e.PG_POOL_MAX,
    slowQueryMs: e.PG_SLOW_QUERY_MS,
  },
  redis: { url: e.REDIS_URL, defaultTtl: e.CACHE_TTL_SECONDS },
  aws: { region: e.AWS_REGION },
  dynamo: {
    watchProgressTable: e.DYNAMODB_TABLE_WATCH_PROGRESS,
    endpoint: e.DYNAMODB_ENDPOINT || undefined,
  },
  tokens: {
    accessSecret: e.JWT_ACCESS_SECRET,
    refreshSecret: e.JWT_REFRESH_SECRET,
    playbackSecret: e.PLAYBACK_TOKEN_SECRET,
    accessTtl: e.JWT_ACCESS_TTL,
    refreshTtl: e.JWT_REFRESH_TTL,
    playbackTtlSeconds: e.PLAYBACK_TOKEN_TTL_SECONDS,
    issuer: 'streamflix',
  },
  media: {
    storageDriver: e.STORAGE_DRIVER,
    transcoderDriver: e.TRANSCODER_DRIVER,
    cdnDriver: e.CDN_DRIVER,
    localDir: path.isAbsolute(e.LOCAL_STORAGE_DIR)
      ? e.LOCAL_STORAGE_DIR
      : path.resolve(BACKEND_ROOT, e.LOCAL_STORAGE_DIR),
    publicBaseUrl: e.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, ''),
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    demoHlsUrl: e.DEMO_HLS_URL,
    renditions: [
      { name: '1080p', height: 1080, videoBitrate: 5000, audioBitrate: 128, maxQuality: '1080p' },
      { name: '720p', height: 720, videoBitrate: 3000, audioBitrate: 128, maxQuality: '720p' },
      { name: '480p', height: 480, videoBitrate: 1200, audioBitrate: 96, maxQuality: '480p' },
    ],
  },
  s3: {
    rawBucket: e.S3_BUCKET_RAW,
    processedBucket: e.S3_BUCKET_PROCESSED,
    thumbnailBucket: e.S3_BUCKET_THUMBNAILS,
  },
  mediaConvert: {
    endpoint: e.MEDIACONVERT_ENDPOINT,
    roleArn: e.MEDIACONVERT_ROLE_ARN,
    queueArn: e.MEDIACONVERT_QUEUE_ARN,
  },
  cloudfront: {
    domain: e.CLOUDFRONT_DOMAIN,
    keyPairId: e.CLOUDFRONT_KEY_PAIR_ID,
    privateKey: e.CLOUDFRONT_PRIVATE_KEY,
    privateKeyPath: e.CLOUDFRONT_PRIVATE_KEY_PATH,
  },
  payments: { provider: e.PAYMENTS_PROVIDER, webhookSecret: e.PAYMENTS_WEBHOOK_SECRET, currency: e.CURRENCY },
  rateLimit: {
    windowSeconds: e.RATE_LIMIT_WINDOW_SECONDS,
    max: e.RATE_LIMIT_MAX,
    authMax: e.AUTH_RATE_LIMIT_MAX,
  },
  worker: {
    port: e.WORKER_PORT,
    concurrency: e.TRANSCODE_CONCURRENCY,
    maxAttempts: e.TRANSCODE_MAX_ATTEMPTS,
    staleMinutes: e.TRANSCODE_STALE_MINUTES,
    remotePollSeconds: e.REMOTE_POLL_SECONDS,
  },
  seed: {
    adminEmail: e.SEED_ADMIN_EMAIL,
    adminPassword: e.SEED_ADMIN_PASSWORD,
    userEmail: e.SEED_USER_EMAIL,
    userPassword: e.SEED_USER_PASSWORD,
  },
};

export default config;
