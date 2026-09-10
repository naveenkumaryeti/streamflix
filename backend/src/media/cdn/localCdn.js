import config from '../../config/env.js';

/**
 * Local CDN stand-in.
 *
 * The playback token goes in the *path prefix*, not the query string:
 *
 *   /media/t/<token>/hls/<titleId>/master.m3u8
 *
 * HLS playlists reference their segments with relative URIs, so every segment the player
 * requests inherits the same authorised prefix automatically. That is the same reason real
 * deployments use CloudFront signed *cookies* instead of signed URLs — one authorisation
 * covers the whole tree, and the player needs no rewriting.
 */
export const name = 'local';
export const strategy = 'path-token';

const base = config.media.publicBaseUrl;

export function manifestUrl({ storageKey, playbackToken }) {
  return {
    url: `${base}/t/${playbackToken}/${storageKey}`,
    cookies: [],
    strategy,
  };
}

/** Artwork is not access-controlled — posters are as public as the marketing site. */
export const publicUrl = (key) => (key?.startsWith('http') ? key : `${base}/public/${key}`);

export const signedObjectUrl = ({ storageKey, playbackToken }) => `${base}/t/${playbackToken}/${storageKey}`;

export default { name, strategy, manifestUrl, publicUrl, signedObjectUrl };
