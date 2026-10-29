/**
 * 诊断日志（SPEC §4.1 的 `--verbose` / `REBAL_LOG_LEVEL`）。
 *
 * 只写 stderr，不污染 stdout 的表格与 JSON。级别：error < warn < info < debug。
 * info：请求次数、缓存命中、耗时；debug：脱敏后的 URL 与响应前 200 字符。
 */

export const LOG_LEVELS = Object.freeze(['error', 'warn', 'info', 'debug']);

const RANK = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * @param {string} level
 * @param {(text: string) => void} write
 * @returns {{level: string, enabled: (name: string) => boolean, info: (msg: string) => void, debug: (msg: string) => void}}
 */
export function createLogger(level, write) {
  const rank = RANK[level] ?? RANK.warn;
  const enabled = (name) => RANK[name] <= rank;
  return {
    level,
    enabled,
    info: (message) => {
      if (enabled('info')) write(`[info] ${message}\n`);
    },
    debug: (message) => {
      if (enabled('debug')) write(`[debug] ${message}\n`);
    },
  };
}

/**
 * 一个什么都不做的 logger（测试与库调用默认用）。
 */
export function silentLogger() {
  return { level: 'error', enabled: () => false, info: () => {}, debug: () => {} };
}
