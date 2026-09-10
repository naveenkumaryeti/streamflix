import config from '../../config/env.js';
import logger from '../../config/logger.js';

/** CDN driver factory — see storage/index.js for why the import is dynamic. */
const module_ =
  config.media.cdnDriver === 'cloudfront' ? await import('./cloudfrontCdn.js') : await import('./localCdn.js');

export const cdn = module_.default;

logger.info({ driver: cdn.name, strategy: cdn.strategy }, 'cdn driver selected');

export default cdn;
