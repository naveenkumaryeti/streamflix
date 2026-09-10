import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../../config/env.js';
import logger from '../../config/logger.js';
import { assertSafeKey, contentTypeFor } from '../keys.js';

/**
 * S3 storage driver.
 *
 * Three buckets, because their access patterns and policies differ:
 *   raw        — private, receives large browser uploads, lifecycle to Glacier after 30 days
 *   processed  — private, CloudFront OAC origin for HLS
 *   thumbnails — private, CloudFront origin for artwork (cheap, cacheable, public-ish)
 *
 * Uploads are presigned PUTs so multi-GB files never traverse the API pods. That single
 * decision is what keeps the API stateless and horizontally scalable.
 */
const PRESIGN_TTL_SECONDS = 900;

export const name = 's3';

const client = new S3Client({ region: config.aws.region });

export function bucketFor(key) {
  const { rawBucket, processedBucket, thumbnailBucket } = config.s3;
  if (key.startsWith('sources/')) return rawBucket;
  if (key.startsWith('images/')) return thumbnailBucket || processedBucket;
  return processedBucket;
}

function required(bucket, key) {
  if (!bucket) {
    throw new Error(`No S3 bucket configured for "${key}" — set S3_BUCKET_RAW/PROCESSED/THUMBNAILS`);
  }
  return bucket;
}

export async function init() {
  const missing = Object.entries({
    S3_BUCKET_RAW: config.s3.rawBucket,
    S3_BUCKET_PROCESSED: config.s3.processedBucket,
  })
    .filter(([, value]) => !value)
    .map(([envName]) => envName);
  if (missing.length) logger.warn({ missing }, 's3 storage driver is missing bucket configuration');
}

/** Presigned PUT: the browser uploads straight to S3, the API only hands out the signature. */
export async function createUploadTarget({ key, contentType }) {
  assertSafeKey(key);
  const bucket = required(bucketFor(key), key);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || contentTypeFor(key),
  });
  const url = await getSignedUrl(client, command, { expiresIn: PRESIGN_TTL_SECONDS });
  return {
    driver: name,
    mode: 'presigned-put',
    key,
    bucket,
    url,
    headers: { 'content-type': contentType || contentTypeFor(key) },
    expiresIn: PRESIGN_TTL_SECONDS,
  };
}

export async function putObject({ key, body, contentType }) {
  assertSafeKey(key);
  const bucket = required(bucketFor(key), key);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || contentTypeFor(key),
      CacheControl: key.endsWith('.m3u8') ? 'public, max-age=10' : 'public, max-age=31536000, immutable',
    }),
  );
  return { key, bucket, contentType: contentType || contentTypeFor(key) };
}

export async function getObjectStream(key, { start, end } = {}) {
  assertSafeKey(key);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: required(bucketFor(key), key),
      Key: key,
      Range: start === undefined ? undefined : `bytes=${start}-${end ?? ''}`,
    }),
  );
  return response.Body;
}

export async function headObject(key) {
  assertSafeKey(key);
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: required(bucketFor(key), key), Key: key }));
    return {
      key,
      size: Number(response.ContentLength ?? 0),
      contentType: response.ContentType ?? contentTypeFor(key),
      lastModified: response.LastModified,
    };
  } catch {
    return null;
  }
}

export const exists = async (key) => Boolean(await headObject(key));

export async function list(prefix) {
  const bucket = required(bucketFor(prefix), prefix);
  const keys = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function deleteObject(key) {
  assertSafeKey(key);
  await client.send(
    new DeleteObjectsCommand({
      Bucket: required(bucketFor(key), key),
      Delete: { Objects: [{ Key: key }] },
    }),
  );
  return { key, deleted: true };
}

/** S3 has no directories, so a prefix delete is a paged list followed by batched deletes. */
export async function deletePrefix(prefix) {
  const bucket = required(bucketFor(prefix), prefix);
  const keys = await list(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    if (chunk.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk } }));
  }
  return { prefix, deleted: keys.length };
}

export default {
  name,
  init,
  bucketFor,
  createUploadTarget,
  putObject,
  getObjectStream,
  headObject,
  exists,
  list,
  deleteObject,
  deletePrefix,
};
