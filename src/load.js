/**
 * 一次运行的装载流水线：配置 → 持仓 → 缓存 → 行情 → 汇率 → 估值。
 * 任何一步失败都直接抛 RebalError；调用方负责输出与退出码。
 */

import { IssueList } from './errors.js';
import { loadConfig } from './config.js';
import { checkSymbolsKnown, readHoldings, resolveHoldingsPath } from './holdings.js';
import { ensureStateDir, readCache, writeCache } from './cache.js';
import { resolveQuotes } from './quotes/index.js';
import { resolveFx } from './fx/index.js';
import { neededCurrencies, valuate } from './portfolio.js';
import { createHttp } from './http.js';
import { formatIsoLocal } from './util.js';

/**
 * @typedef {object} App
 * @property {NodeJS.ProcessEnv} env
 * @property {string} cwd
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {typeof fetch} fetch
 * @property {(text: string) => void} stdout
 * @property {(text: string) => void} stderr
 * @property {boolean} isTty
 * @property {number|undefined} columns
 * @property {boolean} noColor
 * @property {'auto'|'always'|'never'} colorMode
 * @property {string} logLevel
 */

/**
 * 装载配置与持仓（不取行情）。
 * @param {{app: App, dir?: string, config?: string, holdings?: string, stateDir?: string}} context
 * @param {{skipAssetCheck?: boolean, ensureState?: boolean}} [options]
 */
export function loadBasics(context, options = {}) {
  const app = context.app;
  const { config, env: runtime, paths } = loadConfig({
    cwd: app.cwd,
    dir: context.dir,
    config: context.config,
    holdings: context.holdings,
    stateDir: context.stateDir,
    env: app.env,
  });
  const holdingsPath = resolveHoldingsPath({ paths, config });
  const holdings = readHoldings(holdingsPath, config.holdings);
  const issues = new IssueList();
  if (!options.skipAssetCheck) checkSymbolsKnown(holdings, config.assets, issues);
  issues.throwIfAny();
  if (options.ensureState !== false) ensureStateDir(paths.stateDir);
  return { config, runtime, paths, holdings, holdingsPath };
}

/**
 * 在 basics 之上取行情与汇率并估值。
 * @param {App} app
 * @param {object} basics loadBasics 的返回值
 * @param {{cash?: number, refresh?: boolean, offline?: boolean}} [options]
 */
export async function loadPrices(app, basics, options = {}) {
  const { config, runtime, paths, holdings } = basics;
  const offline = options.offline ?? runtime.offline;
  const cache = readCache(paths.stateDir);
  const persistCache = () => {
    writeCache(paths.stateDir, cache);
  };
  const http = createHttp({ fetchImpl: app.fetch, sleep: app.sleep });

  const quotesResult = await resolveQuotes({
    holdings,
    config,
    runtime,
    cache,
    http,
    now: app.now,
    sleep: app.sleep,
    offline,
    refresh: options.refresh ?? false,
    formatIso: (ms) => formatIsoLocal(new Date(ms)),
    persistCache,
    resolvePriceFile: () => (config.quotes.priceFile.startsWith('/') ? config.quotes.priceFile : `${paths.dir}/${config.quotes.priceFile}`),
  });

  const fxResult = await resolveFx({
    baseCurrency: config.portfolio.baseCurrency,
    currencies: neededCurrencies(holdings, config),
    config,
    runtime,
    cache,
    http,
    now: app.now,
    offline,
    refresh: options.refresh ?? false,
    formatIso: (ms) => formatIsoLocal(new Date(ms)),
    persistCache,
  });

  persistCache();
  const portfolio = valuate({
    holdings,
    config,
    quotes: quotesResult.quotes,
    fx: fxResult.fx,
    cash: options.cash ?? 0,
  });

  return {
    ...basics,
    cache,
    quotes: quotesResult.quotes,
    fx: fxResult.fx,
    portfolio,
    warnings: [...holdings.warnings, ...quotesResult.warnings, ...fxResult.warnings],
    offline,
  };
}
