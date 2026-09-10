import config from '../../config/env.js';
import logger from '../../config/logger.js';

/**
 * Storage driver factory.
 *
 * The driver is chosen once, at boot, with a dynamic import — so a laptop running
 * STORAGE_DRIVER=local never loads (or pays the cold-start cost of) the AWS SDK, and a
 * pod running STORAGE_DRIVER=s3 never touches the filesystem. Every caller imports this
 * module and gets the same interface either way.
 */
const module_ = config.media.storageDriver === 's3' ? await import('./s3Storage.js') : await import('./localStorage.js');

export const storage = module_.default;

await storage.init?.().catch((err) => logger.error({ err: err.message }, 'storage init failed'));

logger.info({ driver: storage.name }, 'storage driver selected');

export default storage;
