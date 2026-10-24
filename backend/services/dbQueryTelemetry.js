const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SLOW_QUERY_LOG_THRESHOLD_MS = () => parseInt(process.env.DB_SLOW_QUERY_THRESHOLD_MS, 10) || 150;
const LOG_FILE = path.join(__dirname, '..', 'logs', 'slow-queries.log');

/** Replace literals so no user data (emails, tokens) reaches the log. */
function sanitizeSql(sql) {
  if (typeof sql !== 'string') return '';
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function shortStack() {
  return (new Error().stack || '')
    .split('\n')
    .slice(1)
    .filter((l) => !l.includes('node_modules') && !l.includes('dbQueryTelemetry'))
    .slice(0, 4)
    .map((l) => l.trim());
}

function writeSlowQueryLog(entry) {
  try {
    fs.mkdir(path.dirname(LOG_FILE), { recursive: true }, (mkErr) => {
      if (mkErr) return;
      fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {});
    });
  } catch (_) {
    /* logging must never throw */
  }
}

/**
 * Record a finished query. Non-blocking and never throws.
 */
function handleQueryFinished(sql, durationMs) {
  try {
    if (process.env.NODE_ENV === 'test') return false;
    if (durationMs < SLOW_QUERY_LOG_THRESHOLD_MS()) return false;
    const clean = sanitizeSql(sql);
    writeSlowQueryLog({
      time: new Date().toISOString(),
      durationMs: Math.round(durationMs * 100) / 100,
      sql: clean,
      stack: shortStack(),
    });
    try {
      const { recordSlowQuery } = require('./queryProfilerService');
      recordSlowQuery({ sql: clean, durationMs });
    } catch (_) {
      /* metric is best effort */
    }
    logger.warn('Slow query detected', { durationMs: Math.round(durationMs), sql: clean });
    return true;
  } catch (_) {
    return false;
  }
}

/** Attach beforeQuery/afterQuery hooks to a Sequelize instance. */
function attachSequelizeTelemetry(sequelize, onDuration) {
  sequelize.addHook('beforeQuery', (options) => {
    options.__hrStart = process.hrtime.bigint();
  });
  sequelize.addHook('afterQuery', (options, query) => {
    if (options.__hrStart === undefined) return;
    const ms = Number(process.hrtime.bigint() - options.__hrStart) / 1e6;
    if (onDuration) onDuration(ms);
    handleQueryFinished((query && query.sql) || options.sql, ms);
  });
}

module.exports = { sanitizeSql, handleQueryFinished, attachSequelizeTelemetry };
