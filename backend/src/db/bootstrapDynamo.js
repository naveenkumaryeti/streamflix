import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { pathToFileURL } from 'node:url';
import { dynamoClient, WATCH_PROGRESS_TABLE, closeDynamo } from './dynamodb.js';
import logger from '../config/logger.js';

/**
 * Creates the watch-progress table for local development / CI.
 * In AWS the table is owned by Terraform (infra/terraform/modules/dynamodb) — this script
 * then finds it already present and exits without touching it.
 */
export async function bootstrapDynamo() {
  try {
    await dynamoClient.send(new DescribeTableCommand({ TableName: WATCH_PROGRESS_TABLE }));
    logger.info({ table: WATCH_PROGRESS_TABLE }, 'dynamodb table already exists');
    return { created: false };
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }

  await dynamoClient.send(
    new CreateTableCommand({
      TableName: WATCH_PROGRESS_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'updatedAt', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      // "Continue watching" is a query on one partition sorted by recency — an LSI is the
      // cheapest way to get that ordering without a scan.
      LocalSecondaryIndexes: [
        {
          IndexName: 'updatedAtIndex',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  await waitUntilTableExists({ client: dynamoClient, maxWaitTime: 60 }, { TableName: WATCH_PROGRESS_TABLE });

  // Progress rows expire after a year so the table does not grow forever.
  await dynamoClient
    .send(
      new UpdateTimeToLiveCommand({
        TableName: WATCH_PROGRESS_TABLE,
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' },
      }),
    )
    .catch((err) => logger.warn({ err: err.message }, 'could not enable TTL (harmless locally)'));

  logger.info({ table: WATCH_PROGRESS_TABLE }, 'dynamodb table created');
  return { created: true };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  bootstrapDynamo()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(result.created ? `Created table ${WATCH_PROGRESS_TABLE}` : `Table ${WATCH_PROGRESS_TABLE} already present`);
      closeDynamo();
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`DynamoDB bootstrap failed: ${err.message}`);
      closeDynamo();
      process.exit(1);
    });
}
