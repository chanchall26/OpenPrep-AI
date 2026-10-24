const os = require('os');

const HARD_MAX_POOL = 50;

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Resolve the Sequelize pool settings. Explicit env vars always win; the
 * default max is derived from the CPU count and capped so a big host cannot
 * open more connections than the database allows.
 */
function resolvePoolConfig(env = process.env, cpuCount = os.cpus().length) {
  const autoMax = Math.min(20, Math.max(5, cpuCount * 4));
  const max = Math.min(HARD_MAX_POOL, toInt(env.DB_POOL_MAX) || autoMax);
  const min = Math.min(toInt(env.DB_POOL_MIN) ?? 5, max);
  return {
    max,
    min,
    acquire: toInt(env.DB_POOL_ACQUIRE) || 30000,
    idle: toInt(env.DB_POOL_IDLE) || 10000,
  };
}

module.exports = { resolvePoolConfig, HARD_MAX_POOL };
