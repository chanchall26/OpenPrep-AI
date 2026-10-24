import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

const { resolvePoolConfig } = require('../../config/poolConfig');
const telemetry = require('../../services/dbQueryTelemetry');
const poolManager = require('../../services/poolManagerService');
const { sequelize } = require('../../config/db');
const errorHandler = require('../../middleware/error');
const { getDatabaseHealth } = require('../../controllers/dbHealthController');

describe('resolvePoolConfig', () => {
  it('derives max from cpu count with a cap and env override', () => {
    expect(resolvePoolConfig({}, 2).max).toBe(8);
    expect(resolvePoolConfig({}, 64).max).toBe(20);
    expect(resolvePoolConfig({ DB_POOL_MAX: '35', DB_POOL_MIN: '8' }, 2)).toMatchObject({ max: 35, min: 8 });
    expect(resolvePoolConfig({ DB_POOL_MAX: '500' }, 2).max).toBe(50);
    expect(resolvePoolConfig({ DB_POOL_MAX: '3', DB_POOL_MIN: '9' }, 2).min).toBe(3);
    expect(resolvePoolConfig({}, 4)).toMatchObject({ acquire: 30000, idle: 10000 });
  });
});

describe('slow query logging', () => {
  let appendSpy;
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    vi.spyOn(fs, 'mkdir').mockImplementation((_p, _o, cb) => cb(null));
    appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation((_f, _d, cb) => cb && cb());
  });
  afterEach(() => {
    process.env.NODE_ENV = 'test';
    vi.restoreAllMocks();
  });

  it('logs a slow query with values stripped', () => {
    const logged = telemetry.handleQueryFinished("SELECT * FROM users WHERE email = 'a@b.com' AND id = 42", 200);
    expect(logged).toBe(true);
    const line = appendSpy.mock.calls[0][1];
    expect(line).not.toContain('a@b.com');
    expect(line).not.toContain('42');
  });

  it('ignores fast queries and test env', () => {
    expect(telemetry.handleQueryFinished('SELECT 1', 20)).toBe(false);
    process.env.NODE_ENV = 'test';
    expect(telemetry.handleQueryFinished('SELECT 1', 900)).toBe(false);
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('never throws on bad input', () => {
    expect(() => telemetry.handleQueryFinished(undefined, 500)).not.toThrow();
  });
});

describe('pool stats and health endpoint', () => {
  const fakePool = { size: 10, using: 4, available: 6, waiting: 2 };

  it('reads stats from the sequelize pool', () => {
    sequelize.connectionManager.pool = fakePool;
    const { pool } = poolManager.getPoolStats();
    expect(pool).toMatchObject({ totalCount: 10, activeCount: 4, idleCount: 6, queueLength: 2 });
  });

  it('responds with pool shape and latency', async () => {
    sequelize.connectionManager.pool = fakePool;
    vi.spyOn(poolManager, 'pingDatabase').mockResolvedValue({ status: 'healthy', latencyMs: 3 });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getDatabaseHealth({}, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.pool.queueLength).toBe(2);
    expect(body.latency).toHaveProperty('avg');
  });
});

describe('error handler', () => {
  it('maps acquire timeout to 503 with Retry-After', () => {
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), json: vi.fn() };
    const err = new Error('timeout');
    err.name = 'SequelizeConnectionAcquireTimeoutError';
    errorHandler(err, { method: 'GET', path: '/x' }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '5');
  });
});
