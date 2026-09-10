import { query, queryOne, queryMany } from '../../db/postgres.js';

/**
 * Every user read goes through this list of columns so a password hash can never
 * leak into an API response by accident. `passwordHashFor` is the one deliberate exception.
 */
const COLUMNS = `
  id,
  email::text            AS email,
  full_name              AS "fullName",
  role,
  status,
  email_verified         AS "emailVerified",
  last_login_at          AS "lastLoginAt",
  created_at             AS "createdAt",
  updated_at             AS "updatedAt"
`;

export function findById(id) {
  return queryOne(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
}

/** Login path: returns the hash alongside the profile so we only touch the table once. */
export function findByEmailWithSecret(email) {
  return queryOne(`SELECT ${COLUMNS}, password_hash AS "passwordHash" FROM users WHERE email = $1`, [email]);
}

export function findByEmail(email) {
  return queryOne(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email]);
}

export function passwordHashFor(id) {
  return queryOne('SELECT password_hash AS "passwordHash" FROM users WHERE id = $1', [id]);
}

export function create({ email, passwordHash, fullName, role = 'user', emailVerified = false }) {
  return queryOne(
    `INSERT INTO users (email, password_hash, full_name, role, email_verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [email, passwordHash, fullName, role, emailVerified],
  );
}

export function markLogin(id) {
  return query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

/** Partial update: undefined fields keep their current value (coalesce on the parameter). */
export function updateProfile(id, { fullName, email }) {
  return queryOne(
    `UPDATE users
        SET full_name = coalesce($2, full_name),
            email     = coalesce($3, email)
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, fullName ?? null, email ?? null],
  );
}

export function updatePasswordHash(id, passwordHash) {
  return queryOne(`UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, passwordHash]);
}

export function setStatus(id, status) {
  return queryOne(`UPDATE users SET status = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, status]);
}

export function setRole(id, role) {
  return queryOne(`UPDATE users SET role = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, role]);
}

/**
 * Admin user list. The subscription join is a lateral so a user with a long billing
 * history still produces exactly one row (the newest live subscription, if any).
 */
export async function list({ search = '', role = '', status = '', limit = 24, offset = 0 } = {}) {
  const filters = ['1 = 1'];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    filters.push(`(u.email::text ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
  }
  if (role) {
    params.push(role);
    filters.push(`u.role = $${params.length}::user_role`);
  }
  if (status) {
    params.push(status);
    filters.push(`u.status = $${params.length}::user_status`);
  }

  const where = filters.join(' AND ');
  const rows = await queryMany(
    `SELECT u.id,
            u.email::text          AS email,
            u.full_name            AS "fullName",
            u.role,
            u.status,
            u.created_at           AS "createdAt",
            u.last_login_at        AS "lastLoginAt",
            sub.status             AS "subscriptionStatus",
            sub.plan_name          AS "planName",
            sub.current_period_end AS "currentPeriodEnd"
       FROM users u
       LEFT JOIN LATERAL (
         SELECT s.status, p.name AS plan_name, s.current_period_end
           FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.user_id = u.id
            AND s.status IN ('trialing', 'active', 'past_due')
          ORDER BY s.created_at DESC
          LIMIT 1
       ) sub ON true
      WHERE ${where}
      ORDER BY u.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  const total = await queryOne(`SELECT count(*) AS total FROM users u WHERE ${where}`, params);
  return { rows, total: total?.total ?? 0 };
}

/** Signup counters for the admin dashboard. */
export function stats() {
  return queryOne(`
    SELECT count(*)                                                        AS total,
           count(*) FILTER (WHERE created_at > now() - interval '7 days')   AS new_last_7_days,
           count(*) FILTER (WHERE last_login_at > now() - interval '30 days') AS active_last_30_days,
           count(*) FILTER (WHERE role = 'admin')                          AS admins
      FROM users
  `);
}

/** Small numbers the account page shows next to the profile. */
export function counts(userId) {
  return queryOne(
    `SELECT (SELECT count(*) FROM my_list WHERE user_id = $1)                          AS "myListCount",
            (SELECT count(*) FROM payments WHERE user_id = $1 AND status = 'succeeded') AS "paymentCount",
            (SELECT count(*) FROM refresh_tokens
              WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now())        AS "activeSessions"`,
    [userId],
  );
}
