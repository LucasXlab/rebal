/**
 * 行情解析编排（SPEC §5.2）：
 *   CSV 覆盖价 → 缓存 → 离线 → 请求行情源，逐符号落缓存。
 */

import { RebalError } from '../errors.js';
import { lookup, store } from '../cache.js';
import { fetchTencent, quoteNotFound } from './tencent.js';
import { readPriceFile } from './csv.js';
import { readMockQuotes } from './mock.js';

export const MAX_SYMBOLS = 200;
export const BATCH_SIZE = 50;
export const BATCH_INTERVAL_MS = 1000;

/**
 * @typedef {object} ResolvedQuote
 * @property {number} price
 * @property {string} currency
 * @property {string} source 'tencent'|'csv'|'mock'|'override'|'cache'
 * @property {string} provider
 * @property {string} fetchedAt ISO 串
 * @property {number} fetchedAtMs
 * @property {boolean} stale
 */

/**
 * @param {object} options
 * @param {import('../holdings.js').Holdings} options.holdings
 * @param {ReturnType<typeof import('../config.js').defaults>} options.config
 * @param {{quoteUrl: string, mockQuotesFile: string}} options.runtime
 * @param {ReturnType<typeof import('../cache.js').emptyCache>} options.cache
 * @param {{requestText: Function}} options.http
 * @param {() => number} options.now
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {boolean} options.offline
 * @param {boolean} options.refresh
 * @param {(ms: number, entry: any) => string} options.formatIso
 * @returns {Promise<{quotes: Map<string, ResolvedQuote>, warnings: string[]}>}
 */
export async function resolveQuotes(options) {
  const { holdings, config, runtime, cache, http, now, sleep, offline, refresh } = options;
  const ttlMs = config.quotes.ttlMinutes * 60_000;
  /** @type {Map<string, ResolvedQuote>} */
  const quotes = new Map();
  /** @type {string[]} */
  const warnings = [];

  /** 需要联网取的符号（quoteId → symbols[]，多个符号可共用一个 quote_id） */
  /** @type {Map<string, string[]>} */
  const pending = new Map();

  for (const [symbol, row] of holdings.bySymbol) {
    const asset = config.assets[symbol];
    if (!asset) continue; // 由 unknown_symbol 校验负责

    // 1. CSV 覆盖价：不查缓存、不发请求
    if (row.price !== null) {
      quotes.set(symbol, {
        price: row.price,
        currency: row.currency ?? asset.currency,
        source: 'override',
        provider: 'override',
        fetchedAt: options.formatIso(now()),
        fetchedAtMs: now(),
        stale: false,
      });
      continue;
    }

    // 2. 缓存命中（换 provider 或 quote_id 都不算命中）
    if (!refresh) {
      const hit = lookup(cache, {
        group: 'quotes',
        key: symbol,
        provider: config.quotes.provider,
        quoteId: asset.quoteId,
        ttlMs,
        now: now(),
        offline,
      });
      if (hit) {
        quotes.set(symbol, {
          price: hit.entry.price,
          currency: asset.currency,
          source: hit.entry.source,
          provider: hit.entry.provider,
          fetchedAt: hit.entry.fetchedAt,
          fetchedAtMs: hit.entry.fetchedAtMs,
          stale: hit.stale,
        });
        if (hit.stale) warnings.push(`${symbol} 使用缓存价格，缓存截至 ${hit.entry.fetchedAt}`);
        continue;
      }
    } else {
      // --refresh 时也允许 --offline 报错路径一致：先看有没有缓存
      const hit = lookup(cache, {
        group: 'quotes',
        key: symbol,
        provider: config.quotes.provider,
        quoteId: asset.quoteId,
        ttlMs,
        now: now(),
        offline,
      });
      if (hit && offline) {
        quotes.set(symbol, {
          price: hit.entry.price,
          currency: asset.currency,
          source: hit.entry.source,
          provider: hit.entry.provider,
          fetchedAt: hit.entry.fetchedAt,
          fetchedAtMs: hit.entry.fetchedAtMs,
          stale: true,
        });
        warnings.push(`${symbol} 使用缓存价格，缓存截至 ${hit.entry.fetchedAt}`);
        continue;
      }
    }

    // 离线只拦"要联网"的行情源；csv/mock 都是本地数据，离线照样能用
    if (offline && config.quotes.provider === 'tencent') {
      throw new RebalError('quote_not_found', `离线模式下没有 ${symbol} 的缓存价格`, {
        issues: [{ path: symbol, message: '先联网跑一次 rebal status 建立缓存，或在持仓里填 price 列自报价' }],
      });
    }

    const list = pending.get(asset.quoteId) ?? [];
    list.push(symbol);
    pending.set(asset.quoteId, list);
  }

  if (pending.size > 0) {
    const quoteIds = [...pending.keys()];
    if (quoteIds.length > MAX_SYMBOLS) {
      throw new RebalError('too_many_symbols', `一次运行最多 ${MAX_SYMBOLS} 个不同标的，当前 ${quoteIds.length} 个`, {
        issues: [{ path: 'holdings.csv', message: `分两次运行，或用 provider=csv 自报价` }],
      });
    }

    if (config.quotes.provider === 'tencent') {
      for (let start = 0; start < quoteIds.length; start += BATCH_SIZE) {
        if (start > 0) await sleep(BATCH_INTERVAL_MS);
        const batch = quoteIds.slice(start, start + BATCH_SIZE);
        const prices = await fetchTencent(http, {
          url: runtime.quoteUrl,
          quoteIds: batch,
          timeoutMs: config.quotes.timeoutMs,
          retries: config.quotes.retries,
        });
        for (const quoteId of batch) {
          const hit = prices.get(quoteId);
          const symbols = pending.get(quoteId) ?? [];
          if (!hit) {
            for (const symbol of symbols) quoteNotFound(symbol, quoteId);
          }
          const fetchedAtMs = now();
          const fetchedAt = options.formatIso(fetchedAtMs);
          for (const symbol of symbols) {
            const asset = config.assets[symbol];
            quotes.set(symbol, {
              price: hit.price,
              currency: asset.currency,
              source: 'tencent',
              provider: 'tencent',
              fetchedAt,
              fetchedAtMs,
              stale: false,
            });
            store(cache, 'quotes', symbol, {
              price: hit.price,
              currency: asset.currency,
              fetchedAt,
              fetchedAtMs,
              source: 'tencent',
              provider: 'tencent',
              quoteId,
            });
            // 逐符号落盘：中途失败时已取到的部分下次仍可用
            options.persistCache?.();
          }
        }
      }
    } else if (config.quotes.provider === 'csv') {
      const priceFile = options.resolvePriceFile?.();
      const table = readPriceFile(priceFile);
      for (const [quoteId, symbols] of pending) {
        for (const symbol of symbols) {
          const hit = table.get(symbol) ?? table.get(quoteId);
          if (!hit || !(hit.price > 0)) {
            throw new RebalError('quote_not_found', `自报价文件里没有 ${symbol}`, {
              issues: [{ path: symbol, message: `在 ${priceFile} 里加一行 ${symbol},<价格>,<货币>,<日期>` }],
            });
          }
          const asset = config.assets[symbol];
          const fetchedAtMs = now();
          const fetchedAt = options.formatIso(fetchedAtMs);
          quotes.set(symbol, {
            price: hit.price,
            currency: hit.currency || asset.currency,
            source: 'csv',
            provider: 'csv',
            fetchedAt,
            fetchedAtMs,
            stale: false,
          });
        }
      }
    } else {
      const mock = readMockQuotes(runtime.mockQuotesFile);
      for (const [quoteId, symbols] of pending) {
        const hit = mock.quotes.get(quoteId);
        for (const symbol of symbols) {
          if (!hit) quoteNotFound(symbol, quoteId);
          const asset = config.assets[symbol];
          // mock 数据的时间固定，stale 由 TTL 判定（演示时也会显示"缓存"）
          const fetchedAtMs = Date.parse(mock.fetchedAt);
          quotes.set(symbol, {
            price: hit.price,
            currency: asset.currency,
            source: 'mock',
            provider: 'mock',
            fetchedAt: mock.fetchedAt,
            fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : now(),
            stale: now() - (Number.isFinite(fetchedAtMs) ? fetchedAtMs : now()) > ttlMs,
          });
        }
      }
    }
  }

  return { quotes, warnings };
}
