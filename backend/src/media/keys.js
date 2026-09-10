import path from 'node:path';

/**
 * Storage key conventions.
 *
 * Keys are identical in local mode and on S3 — only the driver in front of them changes.
 * That is what lets the same title row work against `./storage` on a laptop and against
 * three S3 buckets in production without a data migration.
 *
 *   sources/<titleId>/source.mp4          raw upload (private bucket, lifecycle → Glacier)
 *   hls/<titleId>/master.m3u8             ABR master playlist (processed bucket, CDN origin)
 *   hls/<titleId>/720p/index.m3u8         per-rendition playlist + segments
 *   images/<titleId>/poster.jpg           artwork (thumbnail bucket, public via CDN)
 */
const SAFE_EXT = /^[a-z0-9]{1,5}$/;

/** Never trust a client filename: keep the extension, drop everything else. */
export function safeExtension(filename, fallback = 'mp4') {
  const ext = path.extname(String(filename ?? '')).replace('.', '').toLowerCase();
  return SAFE_EXT.test(ext) ? ext : fallback;
}

export const sourceKey = (titleId, filename) => `sources/${titleId}/source.${safeExtension(filename)}`;
export const hlsPrefix = (titleId) => `hls/${titleId}`;
export const masterPlaylistKey = (titleId) => `${hlsPrefix(titleId)}/master.m3u8`;
export const renditionPlaylistKey = (titleId, rendition) => `${hlsPrefix(titleId)}/${rendition}/index.m3u8`;
export const imageKey = (titleId, kind, filename) =>
  `images/${titleId}/${kind}.${safeExtension(filename, 'jpg')}`;

/** The prefix that owns everything for one title — used when a title is deleted. */
export const titlePrefix = (titleId) => `${titleId}/`;

/**
 * Guard for any key that arrives from outside (media route, admin payload).
 * Rejects absolute paths, traversal and backslashes before they reach the filesystem.
 */
export function isSafeKey(key) {
  const value = String(key ?? '');
  if (!value || value.length > 512) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('..')) return false;
  return /^[A-Za-z0-9._\-/]+$/.test(value);
}

export function assertSafeKey(key) {
  if (!isSafeKey(key)) throw new Error(`unsafe storage key: ${key}`);
  return key;
}

const CONTENT_TYPES = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  vtt: 'text/vtt',
};

export const contentTypeFor = (key) => CONTENT_TYPES[safeExtension(key, '')] ?? 'application/octet-stream';

export default {
  safeExtension,
  sourceKey,
  hlsPrefix,
  masterPlaylistKey,
  renditionPlaylistKey,
  imageKey,
  titlePrefix,
  isSafeKey,
  assertSafeKey,
  contentTypeFor,
};
