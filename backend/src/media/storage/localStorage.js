import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import config from '../../config/env.js';
import logger from '../../config/logger.js';
import { assertSafeKey, contentTypeFor } from '../keys.js';

/**
 * Local filesystem storage — the no-AWS-account path.
 *
 * It implements exactly the same interface as the S3 driver, including "upload targets":
 * instead of a presigned S3 URL the browser gets a URL on this API that accepts the same
 * PUT. The frontend therefore has one upload code path for both modes.
 */
const ROOT = config.media.localDir;

const resolve = (key) => path.join(ROOT, assertSafeKey(key));

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export const name = 'local';

export async function init() {
  await fs.mkdir(ROOT, { recursive: true });
  logger.debug({ dir: ROOT }, 'local storage ready');
}

/**
 * Direct PUT against the API rather than a presigned S3 URL. The upload route is admin-only
 * and validates the key, so the "signature" is the admin's access token.
 */
export async function createUploadTarget({ key, contentType }) {
  await init();
  return {
    driver: name,
    mode: 'api-put',
    key,
    url: `${config.apiPrefix}/admin/media/upload?key=${encodeURIComponent(key)}`,
    headers: { 'content-type': contentType || contentTypeFor(key) },
    expiresIn: null,
  };
}

export async function putObject({ key, body, contentType }) {
  const target = resolve(key);
  await ensureDir(target);
  if (typeof body?.pipe === 'function') {
    await pipeline(body, createWriteStream(target));
  } else {
    await fs.writeFile(target, body);
  }
  const stat = await fs.stat(target);
  return { key, size: stat.size, contentType: contentType || contentTypeFor(key) };
}

export function getObjectStream(key, { start, end } = {}) {
  return createReadStream(resolve(key), start === undefined ? undefined : { start, end });
}

export async function headObject(key) {
  try {
    const stat = await fs.stat(resolve(key));
    return { key, size: stat.size, contentType: contentTypeFor(key), lastModified: stat.mtime };
  } catch {
    return null;
  }
}

export const exists = async (key) => Boolean(await headObject(key));

export async function deleteObject(key) {
  await fs.rm(resolve(key), { force: true });
  return { key, deleted: true };
}

export async function deletePrefix(prefix) {
  await fs.rm(resolve(prefix), { recursive: true, force: true });
  return { prefix, deleted: true };
}

export async function list(prefix) {
  const dir = resolve(prefix);
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => `${prefix.replace(/\/$/, '')}/${path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name))}`.replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

/** Only the local driver can hand back a filesystem path; ffmpeg and res.sendFile need it. */
export const localPath = (key) => resolve(key);

export default {
  name,
  init,
  createUploadTarget,
  putObject,
  getObjectStream,
  headObject,
  exists,
  deleteObject,
  deletePrefix,
  list,
  localPath,
};
