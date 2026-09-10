import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import config from '../config/env.js';
import logger from '../config/logger.js';

/**
 * DynamoDB holds watch progress: a tiny, extremely hot key/value workload
 * (one write every few seconds per viewer) that we do not want hitting Postgres.
 *
 *   pk = USER#<userId>            sk = TITLE#<titleId>
 *   LSI updatedAtIndex (pk, updatedAt)  -> "continue watching", newest first
 *   TTL attribute expiresAt             -> progress self-expires after a year
 *
 * In development DYNAMODB_ENDPOINT points at DynamoDB Local; in EKS the pod gets
 * real credentials from IRSA and the endpoint is left empty.
 */
const usingLocal = Boolean(config.dynamo.endpoint);

export const dynamoClient = new DynamoDBClient({
  region: config.aws.region,
  ...(usingLocal
    ? {
        endpoint: config.dynamo.endpoint,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'localdev',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'localdev',
        },
      }
    : {}),
  maxAttempts: 4,
});

export const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
});

export const WATCH_PROGRESS_TABLE = config.dynamo.watchProgressTable;

export const userPk = (userId) => `USER#${userId}`;
export const titleSk = (titleId) => `TITLE#${titleId}`;

export async function checkDynamo() {
  const started = Date.now();
  await dynamoClient.send(new DescribeTableCommand({ TableName: WATCH_PROGRESS_TABLE }));
  return { ok: true, latencyMs: Date.now() - started };
}

export function closeDynamo() {
  dynamoClient.destroy();
  logger.debug('dynamodb client destroyed');
}

export default { documentClient, dynamoClient, WATCH_PROGRESS_TABLE, userPk, titleSk };
