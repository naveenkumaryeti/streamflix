import config from '../../config/env.js';
import logger from '../../config/logger.js';

/** Transcoder factory — see storage/index.js for why the import is dynamic. */
const module_ =
  config.media.transcoderDriver === 'mediaconvert'
    ? await import('./mediaConvertTranscoder.js')
    : await import('./ffmpegTranscoder.js');

export const transcoder = module_.default;

logger.info({ driver: transcoder.name }, 'transcoder driver selected');

export default transcoder;
