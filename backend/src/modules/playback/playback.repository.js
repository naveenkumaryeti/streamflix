import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { documentClient, WATCH_PROGRESS_TABLE, userPk, titleSk } from '../../db/dynamodb.js';

/**
 * Watch progress lives in DynamoDB, not Postgres, because the player writes it every
 * ~15 seconds for every viewer: it is a high-volume, single-key, last-write-wins access
 * pattern with no joins — exactly what a key-value store is good at, and exactly the
 * traffic you do not want hitting a relational primary.
 *
 *   pk = USER#<uuid>   sk = TITLE#<uuid>   LSI updatedAtIndex = (pk, updatedAt)
 */

const YEAR_IN_SECONDS = 365 * 24 * 60 * 60;
const COMPLETE_RATIO = 0.95;

/** Anything past 95% counts as finished, so "continue watching" does not show credits. */
export function computePercent(positionSeconds, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.min(100, Math.round((positionSeconds / durationSeconds) * 1000) / 10);
}

function toProgress(item) {
  if (!item) return null;
  return {
    titleId: item.titleId,
    positionSeconds: Number(item.positionSeconds ?? 0),
    durationSeconds: Number(item.durationSeconds ?? 0),
    percent: Number(item.percent ?? 0),
    completed: Boolean(item.completed),
    updatedAt: item.updatedAt,
  };
}

export async function saveProgress({ userId, titleId, positionSeconds, durationSeconds = 0, completed }) {
  const position = Math.max(0, Math.round(positionSeconds));
  const duration = Math.max(0, Math.round(durationSeconds));
  const percent = computePercent(position, duration);
  const isComplete = completed ?? (duration > 0 && position / duration >= COMPLETE_RATIO);
  const now = new Date().toISOString();

  const { Attributes } = await documentClient.send(
    new UpdateCommand({
      TableName: WATCH_PROGRESS_TABLE,
      Key: { pk: userPk(userId), sk: titleSk(titleId) },
      UpdateExpression: `SET #userId = :userId, #titleId = :titleId, #position = :position,
                             #duration = if_not_exists(#duration, :zero),
                             #percent = :percent, #completed = :completed,
                             #updatedAt = :now, #expiresAt = :expiresAt,
                             #createdAt = if_not_exists(#createdAt, :now)
                         ADD #plays :one`,
      ExpressionAttributeNames: {
        '#userId': 'userId',
        '#titleId': 'titleId',
        '#position': 'positionSeconds',
        '#duration': 'durationSeconds',
        '#percent': 'percent',
        '#completed': 'completed',
        '#updatedAt': 'updatedAt',
        '#expiresAt': 'expiresAt',
        '#createdAt': 'createdAt',
        '#plays': 'pings',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':titleId': titleId,
        ':position': position,
        ':percent': percent,
        ':completed': isComplete,
        ':now': now,
        ':zero': 0,
        ':one': 1,
        // TTL: a year of inactivity and the row disappears on its own. No cleanup job.
        ':expiresAt': Math.floor(Date.now() / 1000) + YEAR_IN_SECONDS,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  // Duration is only written when we learn it (the player reports it once metadata loads).
  if (duration > 0 && Number(Attributes?.durationSeconds ?? 0) !== duration) {
    await documentClient.send(
      new UpdateCommand({
        TableName: WATCH_PROGRESS_TABLE,
        Key: { pk: userPk(userId), sk: titleSk(titleId) },
        UpdateExpression: 'SET durationSeconds = :d, #p = :percent',
        ExpressionAttributeNames: { '#p': 'percent' },
        ExpressionAttributeValues: { ':d': duration, ':percent': percent },
      }),
    );
    return toProgress({ ...Attributes, durationSeconds: duration, percent });
  }

  return toProgress(Attributes);
}

export async function getProgress(userId, titleId) {
  const { Item } = await documentClient.send(
    new GetCommand({ TableName: WATCH_PROGRESS_TABLE, Key: { pk: userPk(userId), sk: titleSk(titleId) } }),
  );
  return toProgress(Item);
}

/**
 * Continue watching: one partition, newest first, unfinished only.
 * The LSI gives the ordering; the filter runs after the read but the partition is tiny.
 */
export async function listRecent(userId, { limit = 20, includeCompleted = false } = {}) {
  const { Items = [] } = await documentClient.send(
    new QueryCommand({
      TableName: WATCH_PROGRESS_TABLE,
      IndexName: 'updatedAtIndex',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: includeCompleted
        ? { ':pk': userPk(userId) }
        : { ':pk': userPk(userId), ':done': true },
      ...(includeCompleted ? {} : { FilterExpression: 'attribute_not_exists(completed) OR completed <> :done' }),
      ScanIndexForward: false,
      Limit: Math.min(limit * 2, 100),
    }),
  );
  return Items.slice(0, limit).map(toProgress);
}

export async function deleteProgress(userId, titleId) {
  await documentClient.send(
    new DeleteCommand({ TableName: WATCH_PROGRESS_TABLE, Key: { pk: userPk(userId), sk: titleSk(titleId) } }),
  );
  return true;
}

export default { saveProgress, getProgress, listRecent, deleteProgress, computePercent };
