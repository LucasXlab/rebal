/**
 * 行情与汇率缓存（SPEC §3.7）。
 *
 * 一个 JSON 文件，整体原子替换。命中条件是"同一 provider + 同一 quote_id + 未过 TTL"，
 * 所以换 provider 或改 quote_id 不会误用旧价。
 */

import fs from 'node:fs';
import path from 'node:path';
import { RebalError } from './errors.js';

export const CACHE_SCHEMA_VERSION = 1;

/**
 * @typedef {object} CacheEntry
 * @property {number} price
 * @property {string} currency
 * @property {string} fetchedAt ISO 8601 带时区
 * @property {number} fetchedAtMs 毫秒时间戳（判 TTL 用，避免依赖日期解析）
 * @property {string} source
 * @property {string} provider
 * @property {string} quoteId
 */

/** @returns {{schemaVersion: number, quotes: Record<string, CacheEntry>, fx: Record<string, CacheEntry>}} */
export function emptyCache() {
  return { schemaVersion: CACHE_SCHEMA_VERSION, quotes: {}, fx: {} };
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function cachePath(stateDir) {
  return path.join(stateDir, 'cache.json');
}

/**
 * 读缓存。文件不存在 / 损坏 / 版本不对 → 返回空缓存（不报错）。
 * @param {string} stateDir
 */
export function readCache(stateDir) {
  const file = cachePath(stateDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyCache();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyCache();
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return emptyCache();
  }
  const cache = emptyCache();
  for (const group of ['quotes', 'fx']) {
    const source = parsed[group];
    if (!source || typeof source !== 'object') continue;
    for (const [key, entry] of Object.entries(source)) {
      if (isValidEntry(entry)) cache[group][key] = entry;
    }
  }
  return cache;
}

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
function isValidEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const e = /** @type {Record<string, unknown>} */ (entry);
  return (
    typeof e.price === 'number' &&
    Number.isFinite(e.price) &&
    e.price > 0 &&
    typeof e.fetchedAtMs === 'number' &&
    Number.isFinite(e.fetchedAtMs) &&
    typeof e.currency === 'string'
  );
}

/**
 * 写缓存（原子替换）。写失败不抛：缓存写不了不该让整次运行失败。
 * @param {string} stateDir
 * @param {ReturnType<typeof emptyCache>} cache
 * @returns {{ok: boolean, message?: string}}
 */
export function writeCache(stateDir, cache) {
  const file = cachePath(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 忽略清理失败
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 查一条缓存。
 * @param {ReturnType<typeof emptyCache>} cache
 * @param {{group: 'quotes'|'fx', key: string, provider?: string, quoteId?: string, currency?: string, ttlMs: number, now: number, offline?: boolean}} query
 * @returns {{entry: CacheEntry, stale: boolean}|null}
 */
export function lookup(cache, query) {
  const entry = cache[query.group][query.key];
  if (!entry) return null;
  if (query.group === 'quotes') {
    if (query.provider !== undefined && entry.provider !== query.provider) return null;
    if (query.quoteId !== undefined && entry.quoteId !== query.quoteId) return null;
  } else if (query.currency !== undefined && entry.currency !== query.currency) {
    return null;
  }
  const age = query.now - entry.fetchedAtMs;
  const expired = age > query.ttlMs;
  if (query.offline) return { entry, stale: true };
  if (expired) return null;
  return { entry, stale: false };
}

/**
 * @param {ReturnType<typeof emptyCache>} cache
 * @param {'quotes'|'fx'} group
 * @param {string} key
 * @param {CacheEntry} entry
 */
export function store(cache, group, key, entry) {
  cache[group][key] = entry;
}

/**
 * 确认状态目录可写（SPEC §4.1 的 state_dir_unwritable）。
 * @param {string} stateDir
 */
export function ensureStateDir(stateDir) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const probe = path.join(stateDir, '.write-probe');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    throw new RebalError('state_dir_unwritable', `状态目录不可写：${stateDir}`, {
      issues: [{ path: stateDir, message: err instanceof Error ? err.message : String(err) }],
    });
  }
}
