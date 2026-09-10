import fs from 'node:fs';
import { getSignedCookies, getSignedUrl } from '@aws-sdk/cloudfront-signer';
import config from '../../config/env.js';
import logger from '../../config/logger.js';

/**
 * CloudFront driver.
 *
 * Signed *cookies*, not signed URLs, for HLS. A movie is one playlist plus thousands of
 * segments; signing each segment URL would mean rewriting every playlist on the fly.
 * A wildcard cookie policy over `hls/<titleId>/*` authorises the whole tree once, and the
 * player behaves exactly as it would against an unprotected origin.
 *
 * Cookies are set on the API response for the CloudFront domain; the API and the CDN must
 * therefore share a registrable domain in production (api.example.com / cdn.example.com).
 */
export const name = 'cloudfront';
export const strategy = 'signed-cookies';

const { domain, keyPairId } = config.cloudfront;

function loadPrivateKey() {
  const { privateKey, privateKeyPath } = config.cloudfront;
  if (privateKey) return privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
  if (privateKeyPath && fs.existsSync(privateKeyPath)) return fs.readFileSync(privateKeyPath, 'utf8');
  return '';
}

const privateKey = loadPrivateKey();

if (!domain || !keyPairId || !privateKey) {
  logger.warn(
    { hasDomain: Boolean(domain), hasKeyPairId: Boolean(keyPairId), hasPrivateKey: Boolean(privateKey) },
    'cloudfront driver is not fully configured — playback will fail until it is',
  );
}

const httpsUrl = (key) => `https://${domain}/${String(key).replace(/^\//, '')}`;

/** Everything under the title's HLS prefix, so segments are covered by one signature. */
function wildcardPolicy(prefix, expiresAt) {
  return JSON.stringify({
    Statement: [
      {
        Resource: `${httpsUrl(prefix)}/*`,
        Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(expiresAt / 1000) } },
      },
    ],
  });
}

export function manifestUrl({ storageKey, prefix, expiresInSeconds = config.tokens.playbackTtlSeconds }) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const scope = prefix ?? storageKey.split('/').slice(0, -1).join('/');
  const signed = getSignedCookies({ keyPairId, privateKey, policy: wildcardPolicy(scope, expiresAt) });

  return {
    url: httpsUrl(storageKey),
    strategy,
    expiresAt: new Date(expiresAt).toISOString(),
    cookies: Object.entries(signed).map(([cookieName, value]) => ({ name: cookieName, value })),
  };
}

/** Single-object signature — used for the source download link in the admin UI. */
export function signedObjectUrl({ storageKey, expiresInSeconds = 300 }) {
  return getSignedUrl({
    url: httpsUrl(storageKey),
    keyPairId,
    privateKey,
    dateLessThan: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  });
}

export const publicUrl = (key) => (key?.startsWith('http') ? key : httpsUrl(key));

export default { name, strategy, manifestUrl, signedObjectUrl, publicUrl };
