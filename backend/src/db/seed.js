import { pathToFileURL } from 'node:url';
import config from '../config/env.js';
import logger from '../config/logger.js';
import { query, queryOne, closeDatabase } from './postgres.js';
import { waitForPostgres } from './migrate.js';
import { closeDynamo } from './dynamodb.js';
import { plans, genres, titles } from './seedData.js';
import { hashPassword } from '../utils/password.js';
import { saveProgress } from '../modules/playback/playback.repository.js';

const posterFor = (slug) => `https://picsum.photos/seed/streamflix-${slug}/480/720`;
const backdropFor = (slug) => `https://picsum.photos/seed/streamflix-${slug}-wide/1600/900`;

async function seedPlans() {
  for (const plan of plans) {
    await query(
      `INSERT INTO plans (code, name, description, price_cents, currency, max_streams, max_quality, features, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, price_cents = EXCLUDED.price_cents,
         currency = EXCLUDED.currency, max_streams = EXCLUDED.max_streams, max_quality = EXCLUDED.max_quality,
         features = EXCLUDED.features, sort_order = EXCLUDED.sort_order, is_active = true`,
      [
        plan.code,
        plan.name,
        plan.description,
        plan.priceCents,
        config.payments.currency,
        plan.maxStreams,
        plan.maxQuality,
        JSON.stringify(plan.features),
        plan.sortOrder,
      ],
    );
  }
  return plans.length;
}

async function seedGenres() {
  for (const genre of genres) {
    await query(
      `INSERT INTO genres (name, slug, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
      [genre.name, genre.slug, genre.sortOrder],
    );
  }
  return genres.length;
}

async function upsertUser({ email, password, fullName, role }) {
  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return existing.id;
  const row = await queryOne(
    `INSERT INTO users (email, password_hash, full_name, role, email_verified)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [email, await hashPassword(password), fullName, role],
  );
  logger.info({ email, role }, 'seed user created');
  return row.id;
}

async function seedTitles(adminId) {
  const ids = [];
  for (const item of titles) {
    const row = await queryOne(
      `INSERT INTO titles (
         slug, title, synopsis, type, status, release_year, runtime_seconds, maturity_rating, language,
         country, director, cast_members, tags, poster_url, backdrop_url, demo_manifest_url,
         popularity, average_rating, is_featured, published_at, created_by
       ) VALUES ($1,$2,$3,$4,'published',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),$19)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, synopsis = EXCLUDED.synopsis, type = EXCLUDED.type,
         release_year = EXCLUDED.release_year, runtime_seconds = EXCLUDED.runtime_seconds,
         maturity_rating = EXCLUDED.maturity_rating, language = EXCLUDED.language, country = EXCLUDED.country,
         director = EXCLUDED.director, cast_members = EXCLUDED.cast_members, tags = EXCLUDED.tags,
         poster_url = EXCLUDED.poster_url, backdrop_url = EXCLUDED.backdrop_url,
         demo_manifest_url = EXCLUDED.demo_manifest_url, popularity = EXCLUDED.popularity,
         average_rating = EXCLUDED.average_rating, is_featured = EXCLUDED.is_featured,
         status = CASE WHEN titles.status = 'draft' THEN 'published'::title_status ELSE titles.status END,
         published_at = coalesce(titles.published_at, now())
       RETURNING id, slug, runtime_seconds AS "runtimeSeconds"`,
      [
        item.slug,
        item.title,
        item.synopsis,
        item.type,
        item.releaseYear,
        Math.round(item.runtimeMinutes * 60),
        item.maturityRating,
        item.language,
        item.country,
        item.director,
        item.cast,
        item.tags,
        posterFor(item.slug),
        backdropFor(item.slug),
        config.media.demoHlsUrl || null,
        item.popularity,
        item.rating,
        item.featured,
        adminId,
      ],
    );

    await query(
      `INSERT INTO title_genres (title_id, genre_id)
       SELECT $1, g.id FROM genres g WHERE g.slug = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [row.id, item.genres],
    );
    ids.push(row);
  }
  return ids;
}

/**
 * Gives the demo account something to look at: a live Standard subscription.
 * The partial unique index means a second run cannot create a duplicate live row.
 */
async function seedSubscription(userId) {
  const plan = await queryOne("SELECT id, price_cents AS \"priceCents\", currency FROM plans WHERE code = 'standard'");
  if (!plan) return null;

  const inserted = await queryOne(
    `INSERT INTO subscriptions (
       user_id, plan_id, status, current_period_start, current_period_end, provider, provider_subscription_id
     ) VALUES ($1, $2, 'active', now() - interval '3 days', now() + interval '27 days', 'mock', $3)
     ON CONFLICT (user_id) WHERE status IN ('trialing', 'active', 'past_due') DO NOTHING
     RETURNING id`,
    [userId, plan.id, `sub_seed_${userId.slice(0, 8)}`],
  );

  const subscription =
    inserted ??
    (await queryOne(
      `SELECT id FROM subscriptions
        WHERE user_id = $1 AND status IN ('trialing', 'active', 'past_due')
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ));

  if (subscription) {
    await query(
      `INSERT INTO payments (
         user_id, subscription_id, plan_id, amount_cents, currency, status, provider,
         provider_payment_id, idempotency_key, method_brand, method_last4
       ) VALUES ($1, $2, $3, $4, $5, 'succeeded', 'mock', $6, $7, 'visa', '4242')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        userId,
        subscription.id,
        plan.id,
        plan.priceCents,
        plan.currency,
        `pay_seed_${userId.slice(0, 8)}`,
        `seed-${userId}`,
      ],
    );
  }

  return subscription?.id ?? null;
}

async function seedMyList(userId, titleRows) {
  const wanted = ['concrete-orchids', 'monsoon-signal', 'kite-season'];
  const chosen = titleRows.filter((row) => wanted.includes(row.slug));
  for (const row of chosen) {
    await query('INSERT INTO my_list (user_id, title_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, row.id]);
  }
  return chosen.length;
}

/**
 * Half-watched rows so "Continue watching" is populated on first login.
 * DynamoDB may legitimately be absent (someone running only Postgres locally), so a
 * failure here warns instead of failing the whole seed.
 */
async function seedProgress(userId, titleRows) {
  const plan = [
    { slug: 'blackout-protocol', ratio: 0.42 },
    { slug: 'nightshift', ratio: 0.18 },
    { slug: 'the-last-transmission', ratio: 0.73 },
  ];

  let written = 0;
  for (const entry of plan) {
    const row = titleRows.find((t) => t.slug === entry.slug);
    if (!row) continue;
    try {
      await saveProgress({
        userId,
        titleId: row.id,
        positionSeconds: Math.round(row.runtimeSeconds * entry.ratio),
        durationSeconds: row.runtimeSeconds,
      });
      written += 1;
    } catch (err) {
      logger.warn({ err: err.message }, 'skipping watch-progress seed (dynamodb unavailable)');
      return written;
    }
  }
  return written;
}

/**
 * Idempotent by design: every statement is an upsert, so `npm run seed` can be run
 * against a database that already has data (or twice in a row by a Helm hook).
 */
export async function runSeed() {
  await waitForPostgres();

  const planCount = await seedPlans();
  const genreCount = await seedGenres();

  const adminId = await upsertUser({
    email: config.seed.adminEmail,
    password: config.seed.adminPassword,
    fullName: 'StreamFlix Admin',
    role: 'admin',
  });
  const userId = await upsertUser({
    email: config.seed.userEmail,
    password: config.seed.userPassword,
    fullName: 'Demo Viewer',
    role: 'user',
  });

  const titleRows = await seedTitles(adminId);
  const subscriptionId = await seedSubscription(userId);
  const listCount = await seedMyList(userId, titleRows);
  const progressCount = await seedProgress(userId, titleRows);

  const summary = {
    plans: planCount,
    genres: genreCount,
    titles: titleRows.length,
    myList: listCount,
    watchProgress: progressCount,
    subscription: subscriptionId ? 'standard (active)' : 'none',
    adminEmail: config.seed.adminEmail,
    userEmail: config.seed.userEmail,
  };
  logger.info(summary, 'seed complete');
  return summary;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runSeed()
    .then(async (summary) => {
      /* eslint-disable no-console */
      console.log('\nSeed complete.');
      console.log(`  plans:          ${summary.plans}`);
      console.log(`  genres:         ${summary.genres}`);
      console.log(`  titles:         ${summary.titles}`);
      console.log(`  my list:        ${summary.myList}`);
      console.log(`  watch progress: ${summary.watchProgress}`);
      console.log('\nSign in with:');
      console.log(`  admin  ${config.seed.adminEmail} / ${config.seed.adminPassword}`);
      console.log(`  viewer ${config.seed.userEmail} / ${config.seed.userPassword}`);
      /* eslint-enable no-console */
      closeDynamo();
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'seed failed');
      // eslint-disable-next-line no-console
      console.error(`Seed failed: ${err.message}`);
      closeDynamo();
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}

