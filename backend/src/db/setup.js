import { pathToFileURL } from 'node:url';
import logger from '../config/logger.js';
import { runMigrations } from './migrate.js';
import { bootstrapDynamo } from './bootstrapDynamo.js';
import { runSeed } from './seed.js';
import { closeDatabase } from './postgres.js';
import { closeDynamo } from './dynamodb.js';

/**
 * One command that makes an empty environment usable: schema, DynamoDB table, demo data.
 *
 * This is what docker-compose's `migrate` service runs before the API starts, and what
 * the Helm pre-install/pre-upgrade hook runs in EKS (with SEED_DEMO_DATA=false in prod —
 * see values.yaml). Safe to run repeatedly: migrations are tracked, seeds are upserts.
 */
export async function setupDatabase({ seed = true } = {}) {
  const applied = await runMigrations();
  const dynamo = await bootstrapDynamo().catch((err) => {
    // A missing DynamoDB should not block the relational schema; playback progress is
    // the only feature that degrades, and the health endpoint will report it.
    logger.error({ err: err.message }, 'dynamodb bootstrap failed');
    return { created: false, error: err.message };
  });
  const seeded = seed ? await runSeed() : null;
  return { migrations: applied, dynamo, seeded };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const seed = !['false', '0', 'no'].includes(String(process.env.SEED_DEMO_DATA ?? 'true').toLowerCase());
  setupDatabase({ seed })
    .then(async (result) => {
      /* eslint-disable no-console */
      console.log(
        result.migrations.length
          ? `Applied ${result.migrations.length} migration(s): ${result.migrations.join(', ')}`
          : 'Schema already up to date',
      );
      console.log(result.dynamo.created ? 'DynamoDB table created' : 'DynamoDB table already present');
      console.log(seed ? 'Demo data seeded' : 'Seeding skipped (SEED_DEMO_DATA=false)');
      /* eslint-enable no-console */
      closeDynamo();
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'database setup failed');
      // eslint-disable-next-line no-console
      console.error(`Database setup failed: ${err.message}`);
      closeDynamo();
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}

export default setupDatabase;
