// ════════════════════════════════════════════════════════════
// YORRO Studio — Redis
// Cache (utilisateurs authentifiés), quotas IA quotidiens, et
// magasin partagé pour le rate-limiting (persiste les compteurs
// même si le serveur redémarre, contrairement à une mémoire locale).
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════

const Redis = require('ioredis');

let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => console.warn('⚠️  Redis:', err.message));
  redis.on('connect', () => console.log('✅ Redis connecté'));
} else {
  console.log('ℹ️  REDIS_URL non configurée — cache et quotas fonctionneront sans Redis (repli mémoire locale, moins performant à grande échelle)');
}

// ── Repli mémoire locale si Redis est absent (dev, ou variable pas encore configurée) ──
const localFallback = new Map();
function localGet(key) { const v = localFallback.get(key); if (!v) return null; if (v.exp && v.exp < Date.now()) { localFallback.delete(key); return null; } return v.val; }
function localSet(key, val, ttlSec) { localFallback.set(key, { val, exp: ttlSec ? Date.now() + ttlSec * 1000 : null }); }

// ════════════════════
// QUOTAS IA QUOTIDIENS (compteurs Redis, expiration automatique à 25h)
// ════════════════════
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function getQuotaCounts(yorroId) {
  const key = `quota:${yorroId}:${todayStr()}`;
  if (redis) {
    const [chat, vision] = await redis.hmget(key, 'chat', 'vision');
    return { chatCount: parseInt(chat || '0', 10), visionCount: parseInt(vision || '0', 10) };
  }
  const local = localGet(key) || { chatCount: 0, visionCount: 0 };
  return local;
}

async function incrementQuota(yorroId, kind) {
  const key = `quota:${yorroId}:${todayStr()}`;
  const field = kind === 'chat' ? 'chat' : 'vision';
  if (redis) {
    const newVal = await redis.hincrby(key, field, 1);
    await redis.expire(key, 25 * 60 * 60); // expire ~1 jour après minuit, se réinitialise tout seul
    return newVal;
  }
  const local = localGet(key) || { chatCount: 0, visionCount: 0 };
  if (kind === 'chat') local.chatCount++; else local.visionCount++;
  localSet(key, local, 25 * 60 * 60);
  return kind === 'chat' ? local.chatCount : local.visionCount;
}

// ════════════════════
// CACHE UTILISATEUR (évite une requête PostgreSQL à chaque appel authentifié)
// ════════════════════
async function cacheUser(yorroId, user) {
  const key = `user:${yorroId}`;
  const payload = JSON.stringify(user);
  if (redis) return redis.set(key, payload, 'EX', 60); // 60s : assez court pour rester cohérent après une modification
  return localSet(key, payload, 60);
}

async function getCachedUser(yorroId) {
  const key = `user:${yorroId}`;
  const raw = redis ? await redis.get(key) : localGet(key);
  return raw ? JSON.parse(raw) : null;
}

async function invalidateUserCache(yorroId) {
  const key = `user:${yorroId}`;
  if (redis) return redis.del(key);
  localFallback.delete(key);
}

module.exports = {
  redis,
  getQuotaCounts, incrementQuota,
  cacheUser, getCachedUser, invalidateUserCache,
};
