// ════════════════════════════════════════════════════════════
// YORRO Studio — Accès PostgreSQL
// Remplace Mongoose/MongoDB. Requêtes explicites (pas d'ORM lourd)
// pour rester simple à auditer et à faire évoluer.
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Le réseau privé Railway (*.railway.internal) n'exige pas TLS.
  // Si un jour vous pointez vers une base publique (ex: Supabase), mettez
  // DATABASE_SSL=true dans les variables d'environnement.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => console.error('❌ Erreur pool PostgreSQL (connexion inactive):', err.message));

async function query(text, params) {
  return pool.query(text, params);
}

// ════════════════════
// INITIALISATION DU SCHÉMA
// ════════════════════
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id                    SERIAL PRIMARY KEY,
      yorro_id              TEXT UNIQUE NOT NULL,
      email                 TEXT UNIQUE,
      password_hash         TEXT,
      google_id             TEXT UNIQUE,
      display_name          TEXT,
      plan                  TEXT NOT NULL DEFAULT 'free',
      credits               DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_spent           DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_minutes         DOUBLE PRECISION NOT NULL DEFAULT 0,
      email_verified        BOOLEAN NOT NULL DEFAULT FALSE,
      email_verify_token    TEXT,
      email_verify_expires  TIMESTAMPTZ,
      two_factor_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
      two_factor_secret     TEXT,
      two_factor_temp_secret TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS calls (
      id          SERIAL PRIMARY KEY,
      yorro_id    TEXT NOT NULL,
      "to"        TEXT NOT NULL,
      "from"      TEXT,
      call_sid    TEXT,
      status      TEXT NOT NULL DEFAULT 'initiated',
      duration    DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost        DOUBLE PRECISION NOT NULL DEFAULT 0,
      billed      DOUBLE PRECISION NOT NULL DEFAULT 0,
      type        TEXT NOT NULL DEFAULT 'outbound',
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id                SERIAL PRIMARY KEY,
      yorro_id          TEXT NOT NULL,
      type              TEXT,
      amount            DOUBLE PRECISION,
      minutes           DOUBLE PRECISION,
      paypal_order_id   TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      pack              TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS phone_numbers (
      id           SERIAL PRIMARY KEY,
      number       TEXT UNIQUE NOT NULL,
      provider     TEXT NOT NULL,
      assigned_to  TEXT,
      assigned_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_calls_yorro_id ON calls(yorro_id);
    CREATE INDEX IF NOT EXISTS idx_calls_call_sid ON calls(call_sid);
    CREATE INDEX IF NOT EXISTS idx_transactions_yorro_id ON transactions(yorro_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_paypal_order ON transactions(paypal_order_id);
  `);
  console.log('✅ Schéma PostgreSQL prêt (users, calls, transactions, phone_numbers)');
}

// ════════════════════
// MAPPING snake_case (SQL) <-> camelCase (JS), fidèle aux anciens modèles Mongoose
// ════════════════════
function rowToUser(row) {
  if (!row) return null;
  const user = {
    id: row.id,
    yorroId: row.yorro_id,
    email: row.email,
    passwordHash: row.password_hash,
    googleId: row.google_id,
    displayName: row.display_name,
    plan: row.plan,
    credits: Number(row.credits),
    totalSpent: Number(row.total_spent),
    totalMinutes: Number(row.total_minutes),
    emailVerified: row.email_verified,
    emailVerifyToken: row.email_verify_token,
    emailVerifyExpires: row.email_verify_expires,
    twoFactorEnabled: row.two_factor_enabled,
    twoFactorSecret: row.two_factor_secret,
    twoFactorTempSecret: row.two_factor_temp_secret,
    createdAt: row.created_at,
  };
  user.save = () => saveUser(user);
  return user;
}

function rowToCall(row) {
  if (!row) return null;
  const call = {
    id: row.id,
    yorroId: row.yorro_id,
    to: row.to,
    from: row.from,
    callSid: row.call_sid,
    status: row.status,
    duration: Number(row.duration),
    cost: Number(row.cost),
    billed: Number(row.billed),
    type: row.type,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
  call.save = () => saveCall(call);
  return call;
}

function rowToTransaction(row) {
  if (!row) return null;
  const tx = {
    id: row.id,
    yorroId: row.yorro_id,
    type: row.type,
    amount: row.amount === null ? null : Number(row.amount),
    minutes: row.minutes === null ? null : Number(row.minutes),
    paypalOrderId: row.paypal_order_id,
    status: row.status,
    pack: row.pack,
    createdAt: row.created_at,
  };
  tx.save = () => saveTransaction(tx);
  return tx;
}

function rowToPhoneNumber(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    provider: row.provider,
    assignedTo: row.assigned_to,
    assignedAt: row.assigned_at,
    createdAt: row.created_at,
  };
}

// ════════════════════
// USERS
// ════════════════════
async function getUserByYorroId(yorroId) {
  const res = await query('SELECT * FROM users WHERE yorro_id = $1', [yorroId]);
  return rowToUser(res.rows[0]);
}

async function getUserByEmail(email) {
  const res = await query('SELECT * FROM users WHERE email = $1', [email]);
  return rowToUser(res.rows[0]);
}

async function getUserByGoogleId(googleId) {
  const res = await query('SELECT * FROM users WHERE google_id = $1', [googleId]);
  return rowToUser(res.rows[0]);
}

async function getUserByValidVerifyToken(token) {
  const res = await query(
    'SELECT * FROM users WHERE email_verify_token = $1 AND email_verify_expires > now()',
    [token]
  );
  return rowToUser(res.rows[0]);
}

async function createUser(data) {
  const res = await query(
    `INSERT INTO users (yorro_id, email, password_hash, google_id, display_name, plan, email_verified, email_verify_token, email_verify_expires)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      data.yorroId,
      data.email || null,
      data.passwordHash || null,
      data.googleId || null,
      data.displayName || null,
      data.plan || 'free',
      data.emailVerified || false,
      data.emailVerifyToken || null,
      data.emailVerifyExpires || null,
    ]
  );
  return rowToUser(res.rows[0]);
}

// Réécrit toutes les colonnes modifiables — reproduit le comportement simple
// de user.save() de Mongoose sans avoir à suivre finement les champs changés.
async function saveUser(user) {
  await query(
    `UPDATE users SET
       email = $1, password_hash = $2, google_id = $3, display_name = $4, plan = $5,
       credits = $6, total_spent = $7, total_minutes = $8,
       email_verified = $9, email_verify_token = $10, email_verify_expires = $11,
       two_factor_enabled = $12, two_factor_secret = $13, two_factor_temp_secret = $14
     WHERE yorro_id = $15`,
    [
      user.email || null, user.passwordHash || null, user.googleId || null, user.displayName || null, user.plan,
      user.credits || 0, user.totalSpent || 0, user.totalMinutes || 0,
      user.emailVerified || false, user.emailVerifyToken || null, user.emailVerifyExpires || null,
      user.twoFactorEnabled || false, user.twoFactorSecret || null, user.twoFactorTempSecret || null,
      user.yorroId,
    ]
  );
  return user;
}

async function countUsers() {
  const res = await query('SELECT COUNT(*)::int AS count FROM users');
  return res.rows[0].count;
}

// ════════════════════
// CALLS
// ════════════════════
async function createCall(data) {
  const res = await query(
    `INSERT INTO calls (yorro_id, "to", "from", call_sid, status, type)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [data.yorroId, data.to, data.from || null, data.callSid || null, data.status || 'initiated', data.type || 'outbound']
  );
  return rowToCall(res.rows[0]);
}

async function getCallBySid(callSid) {
  const res = await query('SELECT * FROM calls WHERE call_sid = $1', [callSid]);
  return rowToCall(res.rows[0]);
}

async function getCallsByYorroId(yorroId, limit = 50) {
  const res = await query(
    'SELECT * FROM calls WHERE yorro_id = $1 ORDER BY started_at DESC LIMIT $2',
    [yorroId, limit]
  );
  return res.rows.map(rowToCall);
}

async function saveCall(call) {
  await query(
    `UPDATE calls SET status=$1, duration=$2, cost=$3, billed=$4, ended_at=$5 WHERE id=$6`,
    [call.status, call.duration || 0, call.cost || 0, call.billed || 0, call.endedAt || null, call.id]
  );
  return call;
}

async function countCompletedCalls() {
  const res = await query("SELECT COUNT(*)::int AS count FROM calls WHERE status = 'completed'");
  return res.rows[0].count;
}

async function getRecentCompletedCalls(limit = 10) {
  const res = await query(
    "SELECT * FROM calls WHERE status = 'completed' ORDER BY started_at DESC LIMIT $1",
    [limit]
  );
  return res.rows.map(rowToCall);
}

async function sumCompletedCallMinutes() {
  const res = await query("SELECT COALESCE(SUM(duration),0)/60.0 AS minutes FROM calls WHERE status = 'completed'");
  return Number(res.rows[0].minutes) || 0;
}

async function getCompletedCallStats() {
  const res = await query(
    "SELECT COALESCE(SUM(duration),0)/60.0 AS minutes, COALESCE(SUM(cost),0) AS cost FROM calls WHERE status = 'completed'"
  );
  return { totalMinutes: Number(res.rows[0].minutes) || 0, totalCost: Number(res.rows[0].cost) || 0 };
}

// ════════════════════
// TRANSACTIONS
// ════════════════════
async function createTransaction(data) {
  const res = await query(
    `INSERT INTO transactions (yorro_id, type, amount, minutes, paypal_order_id, status, pack)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [data.yorroId, data.type || null, data.amount ?? null, data.minutes ?? null, data.paypalOrderId || null, data.status || 'pending', data.pack || null]
  );
  return rowToTransaction(res.rows[0]);
}

async function getPendingTransactionByOrderId(orderId) {
  const res = await query(
    "SELECT * FROM transactions WHERE paypal_order_id = $1 AND status = 'pending'",
    [orderId]
  );
  return rowToTransaction(res.rows[0]);
}

async function saveTransaction(tx) {
  await query('UPDATE transactions SET status=$1 WHERE id=$2', [tx.status, tx.id]);
  return tx;
}

async function countCompletedTransactions() {
  const res = await query("SELECT COUNT(*)::int AS count FROM transactions WHERE status = 'completed'");
  return res.rows[0].count;
}

async function getRecentCompletedTransactions(limit = 10) {
  const res = await query(
    "SELECT * FROM transactions WHERE status = 'completed' ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return res.rows.map(rowToTransaction);
}

async function sumCompletedTransactionAmount() {
  const res = await query("SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE status = 'completed'");
  return Number(res.rows[0].total) || 0;
}

// ════════════════════
// PHONE NUMBERS (pool)
// ════════════════════
async function getPhoneNumberByAssignee(yorroId) {
  const res = await query('SELECT * FROM phone_numbers WHERE assigned_to = $1', [yorroId]);
  return rowToPhoneNumber(res.rows[0]);
}

// Attribution atomique : prend un numéro libre et le marque assigné en une seule
// opération (évite qu'un numéro soit distribué deux fois si deux requêtes arrivent en même temps).
async function claimFreePhoneNumber(yorroId) {
  const res = await query(
    `UPDATE phone_numbers SET assigned_to = $1, assigned_at = now()
     WHERE id = (SELECT id FROM phone_numbers WHERE assigned_to IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [yorroId]
  );
  return rowToPhoneNumber(res.rows[0]);
}

async function createPhoneNumber(data) {
  const res = await query(
    'INSERT INTO phone_numbers (number, provider, assigned_to, assigned_at) VALUES ($1,$2,$3,$4) RETURNING *',
    [data.number, data.provider, data.assignedTo || null, data.assignedTo ? new Date() : null]
  );
  return rowToPhoneNumber(res.rows[0]);
}

module.exports = {
  pool, query, initSchema,
  getUserByYorroId, getUserByEmail, getUserByGoogleId, getUserByValidVerifyToken, createUser, saveUser, countUsers,
  createCall, getCallBySid, getCallsByYorroId, saveCall, countCompletedCalls, getRecentCompletedCalls, sumCompletedCallMinutes, getCompletedCallStats,
  createTransaction, getPendingTransactionByOrderId, saveTransaction, countCompletedTransactions, getRecentCompletedTransactions, sumCompletedTransactionAmount,
  getPhoneNumberByAssignee, claimFreePhoneNumber, createPhoneNumber,
};
