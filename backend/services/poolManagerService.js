const { sequelize } = require('../config/db');

class PoolManagerService {
  constructor() {
    this.queryLatencyHistory = [];
    this.maxLatencyHistorySize = 100;
    this.failureCount = 0;
    this.failureThreshold = 5;
    this.circuitState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.lastStateChange = Date.now();
  }

  /**
   * Records execution latency of queries for rolling statistical analysis
   */
  recordLatency(durationMs) {
    if (this.queryLatencyHistory.length >= this.maxLatencyHistorySize) {
      this.queryLatencyHistory.shift();
    }
    this.queryLatencyHistory.push(durationMs);
  }

  /**
   * Calculates p50, p95, and average latency metrics
   */
  getLatencyMetrics() {
    if (this.queryLatencyHistory.length === 0) {
      return { p50: 0, p95: 0, avg: 0, samples: 0 };
    }

    const sorted = [...this.queryLatencyHistory].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const avg = parseFloat(
      (this.queryLatencyHistory.reduce((acc, curr) => acc + curr, 0) / this.queryLatencyHistory.length).toFixed(2)
    );

    return { p50, p95, avg, samples: sorted.length };
  }

  /**
   * Inspects current connection pool state
   */
  getPoolStats() {
    // Sequelize's pool is the one real queries use (pgPool is migrations only)
    const sp = sequelize.connectionManager && sequelize.connectionManager.pool;
    const total = sp ? sp.size || 0 : 0;
    const active = sp ? sp.using || 0 : 0;
    const idle = sp ? sp.available || 0 : 0;
    const waiting = sp ? sp.waiting || 0 : 0;
    const max = (sequelize.options.pool && sequelize.options.pool.max) || 0;
    try {
      require('./metricsService').openprepDbPoolActiveConnections.set(active);
    } catch (_) {
      /* gauge is best effort */
    }
    return {
      pool: {
        totalCount: total,
        activeCount: active,
        idleCount: idle,
        waitingCount: waiting,
        queueLength: waiting,
        maxCount: max,
        saturated: max > 0 && active >= max && waiting > 0,
      },
      circuitBreaker: {
        state: this.circuitState,
        failureCount: this.failureCount,
        lastStateChange: new Date(this.lastStateChange).toISOString(),
      },
      latency: this.getLatencyMetrics(),
    };
  }

  /**
   * Health ping probe returning connection status and latency
   */
  async pingDatabase() {
    const start = Date.now();
    try {
      if (this.circuitState === 'OPEN') {
        const cooldownMs = 30000;
        if (Date.now() - this.lastStateChange > cooldownMs) {
          this.circuitState = 'HALF_OPEN';
          this.lastStateChange = Date.now();
        } else {
          throw new Error('Circuit breaker is OPEN. Connection probe suspended.');
        }
      }

      await sequelize.authenticate();
      const duration = Date.now() - start;
      this.recordLatency(duration);

      if (this.circuitState === 'HALF_OPEN') {
        this.circuitState = 'CLOSED';
        this.failureCount = 0;
        this.lastStateChange = Date.now();
      }

      return { status: 'healthy', latencyMs: duration };
    } catch (error) {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        this.circuitState = 'OPEN';
        this.lastStateChange = Date.now();
      }
      return { status: 'degraded', error: error.message, latencyMs: Date.now() - start };
    }
  }
}

module.exports = new PoolManagerService();
