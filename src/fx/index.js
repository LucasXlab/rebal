/**
 * 汇率解析（SPEC §5.5）。
 *
 * 统一口径：`rateToBase(CUR)` = 1 单位 CUR 等于多少本币。
 * - static / mock 文件里直接就是这个数；
 * - Frankfurter 返回的是 "1 BASE = x CUR"，所以要取倒数。
 */

import { RebalError } from '../errors.js';
import { lookup, store } from '../cache.js';
import { readMockFx } from './mock.js';

/**
 * @typedef {object} ResolvedFx
 * @property {number} rateToBase
 * @property {string} source
 * @property {string} fetchedAt
 * @property {number} fetchedAtMs
 * @property {boolean} stale
 */

/**
 * 从 Frankfurter 的响应体解析出 rateToBase 表。
 * @param {string} body
 * @param {string} base
 * @param {string[]} currencies
 * @returns {Map<string, number>}
 */
export function parseFrankfurter(body, base, currencies) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RebalError('fx_invalid', '汇率接口返回的不是合法 JSON', {
      issues: [{ path: 'frankfurter', message: String(body).slice(0, 200) }],
    });
  }
  const rates = parsed?.rates;
  if (!rates || typeof rates !== 'object') {
    throw new RebalError('fx_invalid', '汇率接口返回里没有 rates', {
      issues: [{ path: 'frankfurter', message: String(body).slice(0, 200) }],
    });
  }
  /** @type {Map<string, number>} */
  const result = new Map();
  for (const currency of currencies) {
    const rate = rates[currency];
    if (typeof rate !== 'number' || !(rate > 0)) {
      throw new RebalError('fx_not_found', `汇率接口没有 ${currency} 对 ${base} 的报价`, {
        issues: [{ path: currency, message: `返回：${JSON.stringify(rates).slice(0, 200)}` }],
      });
    }
    result.set(currency, 1 / rate);
  }
  return result;
}

/**
 * 解析本次需要的所有汇率。
 * @param {object} options
 * @param {string} options.baseCurrency
 * @param {string[]} options.currencies 除本币外需要换算的货币
 * @param {ReturnType<typeof import('../config.js').defaults>} options.config
 * @param {{fxUrl: string, mockFxFile: string}} options.runtime
 * @param {ReturnType<typeof import('../cache.js').emptyCache>} options.cache
 * @param {{requestText: Function}} options.http
 * @param {() => number} options.now
 * @param {boolean} options.offline
 * @param {boolean} options.refresh
 * @param {(ms: number) => string} options.formatIso
 * @returns {Promise<{fx: Map<string, ResolvedFx>, warnings: string[]}>}
 */
export async function resolveFx(options) {
  const { baseCurrency, config, runtime, cache, http, now, offline, refresh } = options;
  const ttlMs = config.quotes.ttlMinutes * 60_000;
  /** @type {Map<string, ResolvedFx>} */
  const fx = new Map();
  /** @type {string[]} */
  const warnings = [];
  const log = options.log ?? { info: () => {}, debug: () => {} };
  const needed = options.currencies.filter((c) => c !== baseCurrency);

  fx.set(baseCurrency, {
    rateToBase: 1,
    source: 'base',
    fetchedAt: options.formatIso(now()),
    fetchedAtMs: now(),
    stale: false,
  });

  if (needed.length === 0) return { fx, warnings };

  if (config.fx.provider === 'static') {
    for (const currency of needed) {
      const rate = config.fx.static[currency];
      if (rate === undefined) {
        throw new RebalError('fx_not_found', `[fx.static] 里没有 ${currency} 的汇率`, {
          issues: [
            {
              path: `fx.static.${currency}`,
              message: `在 [fx.static] 里加一行 ${currency} = <1 单位 ${currency} 等于多少 ${baseCurrency}>`,
            },
          ],
        });
      }
      fx.set(currency, {
        rateToBase: rate,
        source: 'static',
        fetchedAt: options.formatIso(now()),
        fetchedAtMs: now(),
        stale: false,
      });
    }
    return { fx, warnings };
  }

  if (config.fx.provider === 'mock') {
    const mock = readMockFx(runtime.mockFxFile);
    for (const currency of needed) {
      const rate = mock.rates.get(currency);
      if (rate === undefined) {
        throw new RebalError('fx_not_found', `mock 汇率里没有 ${currency}`, {
          issues: [{ path: runtime.mockFxFile, message: `在 rates 里加 "${currency}"` }],
        });
      }
      // stale 与 mock 行情同口径：示例数据的时间是固定的，超过 TTL 就该显示"缓存"。
      // 之前这里硬写 false，导致同一份示例数据里行情显示"缓存"、汇率显示"新"，
      // 读者会以为汇率不会过期。
      const fetchedAtMs = Date.parse(mock.fetchedAt);
      const effectiveMs = Number.isFinite(fetchedAtMs) ? fetchedAtMs : now();
      fx.set(currency, {
        rateToBase: rate,
        source: 'mock',
        fetchedAt: mock.fetchedAt,
        fetchedAtMs: effectiveMs,
        stale: now() - effectiveMs > ttlMs,
      });
    }
    return { fx, warnings };
  }

  // frankfurter：一次请求取全部货币
  if (!refresh) {
    let allCached = true;
    for (const currency of needed) {
      const hit = lookup(cache, {
        group: 'fx',
        key: currency,
        currency,
        ttlMs,
        now: now(),
        offline,
      });
      if (hit) {
        log.info(`汇率缓存命中 ${currency}（${hit.entry.fetchedAt}）`);
        fx.set(currency, {
          rateToBase: hit.entry.price,
          source: hit.entry.source,
          fetchedAt: hit.entry.fetchedAt,
          fetchedAtMs: hit.entry.fetchedAtMs,
          stale: hit.stale,
        });
        if (hit.stale) warnings.push(`汇率 ${currency} 使用缓存，缓存截至 ${hit.entry.fetchedAt}`);
      } else {
        allCached = false;
      }
    }
    if (allCached) return { fx, warnings };
    if (offline) {
      throw new RebalError('fx_not_found', `离线模式下没有 ${needed.join('、')} 的缓存汇率`, {
        issues: [{ path: 'fx', message: '先联网跑一次建立缓存，或用 [fx.static] 写明汇率' }],
      });
    }
    // 有部分命中时只补请求缺的那些
    const missing = needed.filter((c) => !fx.has(c));
    const rates = await requestFrankfurter(http, {
      url: runtime.fxUrl,
      base: baseCurrency,
      currencies: missing,
      timeoutMs: config.quotes.timeoutMs,
      retries: config.quotes.retries,
    });
    const fetchedAtMs = now();
    const fetchedAt = options.formatIso(fetchedAtMs);
    for (const [currency, rateToBase] of rates) {
      fx.set(currency, { rateToBase, source: 'frankfurter', fetchedAt, fetchedAtMs, stale: false });
      store(cache, 'fx', currency, {
        price: rateToBase,
        currency,
        fetchedAt,
        fetchedAtMs,
        source: 'frankfurter',
        provider: 'frankfurter',
        quoteId: currency,
      });
    }
    options.persistCache?.();
    return { fx, warnings };
  }

  const rates = await requestFrankfurter(http, {
    url: runtime.fxUrl,
    base: baseCurrency,
    currencies: needed,
    timeoutMs: config.quotes.timeoutMs,
    retries: config.quotes.retries,
  });
  const fetchedAtMs = now();
  const fetchedAt = options.formatIso(fetchedAtMs);
  for (const [currency, rateToBase] of rates) {
    fx.set(currency, { rateToBase, source: 'frankfurter', fetchedAt, fetchedAtMs, stale: false });
    store(cache, 'fx', currency, {
      price: rateToBase,
      currency,
      fetchedAt,
      fetchedAtMs,
      source: 'frankfurter',
      provider: 'frankfurter',
      quoteId: currency,
    });
  }
  options.persistCache?.();
  return { fx, warnings };
}

/**
 * 请求 Frankfurter 并解析。
 * @param {{requestText: Function}} http
 * @param {{url: string, base: string, currencies: string[], timeoutMs: number, retries: number}} options
 * @returns {Promise<Map<string, number>>}
 */
async function requestFrankfurter(http, options) {
  const url = `${options.url}/latest?from=${encodeURIComponent(options.base)}&to=${options.currencies.join(',')}`;
  const response = await http.requestText(url, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    provider: 'fx',
  });
  return parseFrankfurter(response.body, options.base, options.currencies);
}
