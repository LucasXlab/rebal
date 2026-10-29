/**
 * `rebal.toml` 的解析与校验（SPEC §2.2、§2.3）。
 *
 * 设计要点：
 * 1. 一次报全：所有问题收集到 IssueList，最后一起抛，不在第一个错误处停下。
 * 2. 未知键视为错误：拼错的键被静默忽略比报错更糟。
 * 3. 环境变量覆盖在配置解析之后应用，并按同一套范围重新校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, TomlError } from 'smol-toml';
import { IssueList, RebalError } from './errors.js';
import { isCurrencyCode, isSymbolCode, parseAmount } from './util.js';

/** 包根目录（用来定位内置 fixtures）。 */
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

export const DEFAULT_QUOTE_URL = 'https://qt.gtimg.cn/q=';
export const DEFAULT_FX_URL = 'https://api.frankfurter.app';
export const DEFAULT_QUOTE_PROVIDERS = ['tencent', 'csv', 'mock'];
export const DEFAULT_FX_PROVIDERS = ['frankfurter', 'static', 'mock'];
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/** 每个表允许的键（规则 1）。 */
const TABLE_KEYS = Object.freeze({
  portfolio: ['name', 'base_currency'],
  contribution: ['amount'],
  policy: ['allow_sell', 'min_trade_value', 'max_orders'],
  quotes: ['provider', 'price_file', 'ttl_minutes', 'timeout_ms', 'retries'],
  fx: ['provider', 'static'],
  fees: ['per_order'],
  holdings: [
    'path',
    'account_column',
    'symbol_column',
    'quantity_column',
    'currency_column',
    'price_column',
    'name_column',
  ],
  targets: [],
  bands: [],
  classes: [],
  assets: [],
});

const TOP_LEVEL_KEYS = Object.keys(TABLE_KEYS);

/** 内置默认值（与 SPEC §2.2 的注释一一对应）。 */
export function defaults() {
  return {
    portfolio: { name: '我的组合', baseCurrency: 'CNY' },
    contribution: { amount: null },
    policy: { allowSell: false, minTradeValue: 100, maxOrders: 20 },
    quotes: {
      provider: 'tencent',
      priceFile: 'prices.csv',
      ttlMinutes: 720,
      timeoutMs: 8000,
      retries: 2,
    },
    fx: { provider: 'frankfurter', static: {} },
    fees: { perOrder: 0 },
    holdings: {
      path: 'holdings.csv',
      accountColumn: 'account',
      symbolColumn: 'symbol',
      quantityColumn: 'quantity',
      currencyColumn: 'currency',
      priceColumn: 'price',
      nameColumn: 'name',
    },
    targets: {},
    bands: { default: 0.03, byClass: {} },
    classes: {},
    assets: {},
  };
}

/**
 * 解析路径相关的选项：命令行 > 环境变量 > 默认。
 * @param {{dir?: string, config?: string, holdings?: string, stateDir?: string, env: NodeJS.ProcessEnv, cwd: string}} opts
 */
export function resolvePaths(opts) {
  const dir = path.resolve(opts.cwd, opts.dir ?? '.');
  const configPath = path.resolve(dir, opts.config ?? opts.env.REBAL_CONFIG ?? 'rebal.toml');
  const stateDir = path.resolve(dir, opts.stateDir ?? opts.env.REBAL_STATE_DIR ?? '.rebal');
  const holdingsOverride = opts.holdings ?? opts.env.REBAL_HOLDINGS ?? null;
  return { dir, configPath, stateDir, holdingsOverride };
}

/**
 * 读并解析 TOML。文件不存在 / 语法错误直接抛（不需要"一次报全"）。
 * @param {string} configPath
 * @returns {Record<string, unknown>}
 */
export function readTomlFile(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const reason = /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT' ? '不存在' : '读不了';
    throw new RebalError('config_not_found', `配置文件${reason}：${configPath}`, {
      issues: [{ path: configPath, message: '运行 rebal init 生成一份，或用 --config 指定路径' }],
    });
  }
  try {
    return /** @type {Record<string, unknown>} */ (parseToml(text));
  } catch (err) {
    if (err instanceof TomlError) {
      throw new RebalError('config_invalid', `配置文件不是合法的 TOML：${configPath}`, {
        issues: [{ path: configPath, message: err.message }],
      });
    }
    throw err;
  }
}

/**
 * 把 TOML 的原始对象 + 默认值合并成内部结构，并做结构校验。
 * @param {Record<string, any>} raw
 * @param {import('./errors.js').IssueList} issues
 * @param {string} [configPath]
 */
export function normalizeConfig(raw, issues, configPath = 'rebal.toml') {
  const at = (key) => (configPath ? `${configPath}:${key}` : key);
  const cfg = defaults();

  // 规则 1：顶层与每个表的键
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      issues.add('unknown_field', at(key), `未知的配置项 ${key}（允许：${TOP_LEVEL_KEYS.join('、')}）`);
    }
  }
  for (const [table, allowed] of Object.entries(TABLE_KEYS)) {
    const value = raw[table];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.add('config_invalid', at(table), `${table} 必须是一个表（[${table}]）`);
      continue;
    }
    const openKeys = allowed.length === 0 ? null : allowed;
    for (const key of Object.keys(value)) {
      if (table === 'targets' || table === 'bands' || table === 'classes' || table === 'assets') continue;
      if (openKeys !== null && !openKeys.includes(key)) {
        issues.add('unknown_field', at(`${table}.${key}`), `未知的配置项 ${table}.${key}（允许：${openKeys.join('、')}）`);
      }
    }
  }

  // portfolio
  if (raw.portfolio && typeof raw.portfolio === 'object') {
    const p = /** @type {Record<string, unknown>} */ (raw.portfolio);
    if (p.name !== undefined) {
      if (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 60) {
        issues.add('config_invalid', at('portfolio.name'), 'portfolio.name 必须是 1–60 个字符');
      } else {
        cfg.portfolio.name = p.name;
      }
    }
    if (p.base_currency !== undefined) {
      if (!isCurrencyCode(p.base_currency)) {
        issues.add('config_invalid', at('portfolio.base_currency'), 'portfolio.base_currency 必须是三个大写字母');
      } else {
        cfg.portfolio.baseCurrency = p.base_currency;
      }
    }
  }

  // contribution
  if (raw.contribution && typeof raw.contribution === 'object') {
    const c = /** @type {Record<string, unknown>} */ (raw.contribution);
    if (c.amount !== undefined) {
      const amount = parseAmount(c.amount);
      if (amount === null || amount < 0 || amount > 1e9) {
        issues.add('config_invalid', at('contribution.amount'), 'contribution.amount 必须是 0–1e9 的数字');
      } else {
        cfg.contribution.amount = amount;
      }
    }
  }

  // policy
  if (raw.policy && typeof raw.policy === 'object') {
    const p = /** @type {Record<string, unknown>} */ (raw.policy);
    if (p.allow_sell !== undefined) {
      if (typeof p.allow_sell !== 'boolean') {
        issues.add('config_invalid', at('policy.allow_sell'), 'policy.allow_sell 必须是 true 或 false');
      } else {
        cfg.policy.allowSell = p.allow_sell;
      }
    }
    if (p.min_trade_value !== undefined) {
      const v = parseAmount(p.min_trade_value);
      if (v === null || v < 0 || v > 1e9) {
        issues.add('config_invalid', at('policy.min_trade_value'), 'policy.min_trade_value 必须是 0–1e9 的数字');
      } else {
        cfg.policy.minTradeValue = v;
      }
    }
    if (p.max_orders !== undefined) {
      if (!Number.isInteger(p.max_orders) || p.max_orders < 1 || p.max_orders > 100) {
        issues.add('config_invalid', at('policy.max_orders'), 'policy.max_orders 必须是 1–100 的整数');
      } else {
        cfg.policy.maxOrders = p.max_orders;
      }
    }
  }

  // quotes
  if (raw.quotes && typeof raw.quotes === 'object') {
    const q = /** @type {Record<string, unknown>} */ (raw.quotes);
    if (q.provider !== undefined) {
      if (!DEFAULT_QUOTE_PROVIDERS.includes(/** @type {string} */ (q.provider))) {
        issues.add('config_invalid', at('quotes.provider'), `quotes.provider 只能是 ${DEFAULT_QUOTE_PROVIDERS.join('/')}`);
      } else {
        cfg.quotes.provider = /** @type {string} */ (q.provider);
      }
    }
    if (q.price_file !== undefined) {
      if (typeof q.price_file !== 'string' || q.price_file.length === 0) {
        issues.add('config_invalid', at('quotes.price_file'), 'quotes.price_file 必须是一个文件路径');
      } else {
        cfg.quotes.priceFile = q.price_file;
      }
    }
    if (q.ttl_minutes !== undefined) {
      if (!Number.isInteger(q.ttl_minutes) || q.ttl_minutes < 0 || q.ttl_minutes > 10080) {
        issues.add('config_invalid', at('quotes.ttl_minutes'), 'quotes.ttl_minutes 必须是 0–10080 的整数');
      } else {
        cfg.quotes.ttlMinutes = q.ttl_minutes;
      }
    }
    if (q.timeout_ms !== undefined) {
      if (!Number.isInteger(q.timeout_ms) || q.timeout_ms < 100 || q.timeout_ms > 60000) {
        issues.add('config_invalid', at('quotes.timeout_ms'), 'quotes.timeout_ms 必须是 100–60000 的整数');
      } else {
        cfg.quotes.timeoutMs = q.timeout_ms;
      }
    }
    if (q.retries !== undefined) {
      if (!Number.isInteger(q.retries) || q.retries < 0 || q.retries > 4) {
        issues.add('config_invalid', at('quotes.retries'), 'quotes.retries 必须是 0–4 的整数');
      } else {
        cfg.quotes.retries = q.retries;
      }
    }
  }

  // fx
  if (raw.fx && typeof raw.fx === 'object') {
    const f = /** @type {Record<string, unknown>} */ (raw.fx);
    if (f.provider !== undefined) {
      if (!DEFAULT_FX_PROVIDERS.includes(/** @type {string} */ (f.provider))) {
        issues.add('config_invalid', at('fx.provider'), `fx.provider 只能是 ${DEFAULT_FX_PROVIDERS.join('/')}`);
      } else {
        cfg.fx.provider = /** @type {string} */ (f.provider);
      }
    }
    if (f.static !== undefined) {
      if (f.static === null || typeof f.static !== 'object' || Array.isArray(f.static)) {
        issues.add('config_invalid', at('fx.static'), 'fx.static 必须是一个表（[fx.static]）');
      } else {
        for (const [currency, rate] of Object.entries(/** @type {Record<string, unknown>} */ (f.static))) {
          const value = parseAmount(rate);
          if (!isCurrencyCode(currency)) {
            issues.add('config_invalid', at(`fx.static.${currency}`), 'fx.static 的键必须是三个大写字母');
          } else if (value === null || value <= 0) {
            issues.add('config_invalid', at(`fx.static.${currency}`), 'fx.static 的值必须是正数（1 单位外币 = 多少本币）');
          } else {
            cfg.fx.static[currency] = value;
          }
        }
      }
    }
  }

  // fees
  if (raw.fees && typeof raw.fees === 'object') {
    const f = /** @type {Record<string, unknown>} */ (raw.fees);
    if (f.per_order !== undefined) {
      const v = parseAmount(f.per_order);
      if (v === null || v < 0 || v > 1e9) {
        issues.add('config_invalid', at('fees.per_order'), 'fees.per_order 必须是 0–1e9 的数字');
      } else {
        cfg.fees.perOrder = v;
      }
    }
  }

  // holdings（列名映射）
  if (raw.holdings && typeof raw.holdings === 'object') {
    const h = /** @type {Record<string, unknown>} */ (raw.holdings);
    const map = {
      path: 'path',
      account_column: 'accountColumn',
      symbol_column: 'symbolColumn',
      quantity_column: 'quantityColumn',
      currency_column: 'currencyColumn',
      price_column: 'priceColumn',
      name_column: 'nameColumn',
    };
    for (const [tomlKey, internal] of Object.entries(map)) {
      if (h[tomlKey] === undefined) continue;
      if (typeof h[tomlKey] !== 'string') {
        issues.add('config_invalid', at(`holdings.${tomlKey}`), `holdings.${tomlKey} 必须是字符串（空字符串表示不启用）`);
        continue;
      }
      cfg.holdings[internal] = /** @type {string} */ (h[tomlKey]);
    }
    if (cfg.holdings.symbolColumn === '' || cfg.holdings.quantityColumn === '') {
      issues.add('config_invalid', at('holdings'), 'holdings.symbol_column 与 holdings.quantity_column 不能是空字符串');
    }
    const enabled = ['accountColumn', 'symbolColumn', 'quantityColumn', 'currencyColumn', 'priceColumn', 'nameColumn']
      .map((k) => cfg.holdings[k])
      .filter((v) => v !== '');
    const dup = enabled.filter((v, i) => enabled.indexOf(v) !== i);
    if (dup.length > 0) {
      issues.add('config_invalid', at('holdings'), `holdings 的列名重复：${[...new Set(dup)].join('、')}`);
    }
  }

  // targets
  if (raw.targets && typeof raw.targets === 'object') {
    for (const [classId, weight] of Object.entries(/** @type {Record<string, unknown>} */ (raw.targets))) {
      if (!/^[a-z0-9_]{1,40}$/.test(classId)) {
        issues.add('invalid_class_id', at(`targets.${classId}`), `类别名 ${classId} 只能用小写字母、数字、下划线，1–40 个字符`);
        continue;
      }
      const value = typeof weight === 'number' ? weight : parseAmount(weight);
      if (value === null || value < 0 || value > 1) {
        issues.add('config_invalid', at(`targets.${classId}`), `targets.${classId} 必须是 0–1 的数字`);
        continue;
      }
      cfg.targets[classId] = value;
    }
    const ids = Object.keys(cfg.targets);
    if (ids.length === 0) {
      issues.add('config_invalid', at('targets'), '[targets] 至少要有一个类别');
    } else {
      const sum = ids.reduce((acc, id) => acc + cfg.targets[id], 0);
      if (Math.abs(sum - 1) > 1e-6) {
        issues.add(
          'targets_not_normalized',
          at('targets'),
          `[targets] 各项之和必须等于 1，当前是 ${sum.toFixed(6)}`,
        );
      }
    }
  } else {
    issues.add('config_invalid', at('targets'), '缺少 [targets] 表：至少要有一个资产类别与目标比例');
  }

  // bands
  if (raw.bands && typeof raw.bands === 'object') {
    const b = /** @type {Record<string, unknown>} */ (raw.bands);
    for (const [key, value] of Object.entries(b)) {
      const num = typeof value === 'number' ? value : parseAmount(value);
      if (num === null || num < 0.0001 || num > 0.5) {
        issues.add('config_invalid', at(`bands.${key}`), `bands.${key} 必须是 0.0001–0.5 的数字（0.03 = 3 个百分点）`);
        continue;
      }
      if (key === 'default') cfg.bands.default = num;
      else cfg.bands.byClass[key] = num;
    }
    if (cfg.bands.default === undefined) {
      issues.add('config_invalid', at('bands'), '[bands] 缺少 default');
    }
  }

  // classes
  if (raw.classes && typeof raw.classes === 'object') {
    for (const [classId, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw.classes))) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issues.add('config_invalid', at(`classes.${classId}`), `classes.${classId} 必须是一个表`);
        continue;
      }
      const entry = /** @type {Record<string, unknown>} */ (value);
      for (const key of Object.keys(entry)) {
        if (key !== 'preferred_symbol') {
          issues.add('unknown_field', at(`classes.${classId}.${key}`), `未知的配置项 classes.${classId}.${key}`);
        }
      }
      if (entry.preferred_symbol !== undefined) {
        if (!isSymbolCode(entry.preferred_symbol)) {
          issues.add('config_invalid', at(`classes.${classId}.preferred_symbol`), 'preferred_symbol 必须是证券代码');
        } else {
          cfg.classes[classId] = { preferredSymbol: /** @type {string} */ (entry.preferred_symbol).toUpperCase() };
        }
      } else {
        cfg.classes[classId] = { preferredSymbol: null };
      }
    }
  }

  // assets
  if (raw.assets && typeof raw.assets === 'object') {
    for (const [symbol, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw.assets))) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issues.add('config_invalid', at(`assets.${symbol}`), `assets.${symbol} 必须是一个表`);
        continue;
      }
      const entry = /** @type {Record<string, unknown>} */ (value);
      const allowed = ['class', 'name', 'currency', 'quote_id', 'lot_size'];
      for (const key of Object.keys(entry)) {
        if (!allowed.includes(key)) {
          issues.add('unknown_field', at(`assets.${symbol}.${key}`), `未知的配置项 assets.${symbol}.${key}（允许：${allowed.join('、')}）`);
        }
      }
      const upper = symbol.toUpperCase();
      const asset = { classId: null, name: '', currency: null, quoteId: upper, lotSize: 1 };
      if (entry.class !== undefined) {
        if (typeof entry.class !== 'string' || entry.class.length === 0) {
          issues.add('config_invalid', at(`assets.${symbol}.class`), 'assets.*.class 必须是类别名');
        } else {
          asset.classId = entry.class;
        }
      } else {
        issues.add('config_invalid', at(`assets.${symbol}.class`), 'assets.*.class 必填');
      }
      if (entry.name !== undefined) {
        if (typeof entry.name !== 'string' || entry.name.length > 80) {
          issues.add('config_invalid', at(`assets.${symbol}.name`), 'assets.*.name 必须是 0–80 个字符');
        } else {
          asset.name = entry.name;
        }
      }
      if (entry.currency === undefined) {
        issues.add('config_invalid', at(`assets.${symbol}.currency`), 'assets.*.currency 必填');
      } else if (!isCurrencyCode(entry.currency)) {
        issues.add('config_invalid', at(`assets.${symbol}.currency`), 'assets.*.currency 必须是三个大写字母');
      } else {
        asset.currency = /** @type {string} */ (entry.currency);
      }
      if (entry.quote_id !== undefined) {
        if (!isSymbolCode(entry.quote_id)) {
          issues.add('config_invalid', at(`assets.${symbol}.quote_id`), 'quote_id 只能用字母、数字、点、下划线、短横线，1–16 个字符');
        } else {
          asset.quoteId = /** @type {string} */ (entry.quote_id);
        }
      }
      if (entry.lot_size !== undefined) {
        if (!Number.isInteger(entry.lot_size) || entry.lot_size < 1 || entry.lot_size > 1000000) {
          issues.add('config_invalid', at(`assets.${symbol}.lot_size`), 'lot_size 必须是 1–1000000 的整数');
        } else {
          asset.lotSize = entry.lot_size;
        }
      }
      cfg.assets[upper] = asset;
    }
  }

  validateCrossReferences(cfg, issues, configPath);
  return cfg;
}

/**
 * 规则 3/4/8：类别、首选符号、资产之间的引用关系。
 * @param {ReturnType<typeof defaults>} cfg
 * @param {import('./errors.js').IssueList} issues
 * @param {string} configPath
 */
function validateCrossReferences(cfg, issues, configPath) {
  const at = (key) => `${configPath}:${key}`;
  const classIds = new Set(Object.keys(cfg.targets));

  // 规则 8：bands / classes 的键必须是 targets 的键
  for (const classId of Object.keys(cfg.bands.byClass)) {
    if (!classIds.has(classId)) {
      issues.add('unknown_class', at(`bands.${classId}`), `bands.${classId} 里的类别 ${classId} 不在 [targets] 里`);
    }
  }
  for (const classId of Object.keys(cfg.classes)) {
    if (!classIds.has(classId)) {
      issues.add('unknown_class', at(`classes.${classId}`), `classes.${classId} 里的类别 ${classId} 不在 [targets] 里`);
    }
  }

  // 规则 3：权重 > 0 的类别必须有 preferred_symbol，且该符号在 assets 里
  for (const classId of classIds) {
    const weight = cfg.targets[classId];
    const entry = cfg.classes[classId];
    if (weight > 0) {
      if (!entry || !entry.preferredSymbol) {
        issues.add(
          'missing_preferred_symbol',
          at(`classes.${classId}`),
          `类别 ${classId} 的目标比例是 ${weight}，必须有 [classes.${classId}] preferred_symbol`,
        );
        continue;
      }
      if (!cfg.assets[entry.preferredSymbol]) {
        issues.add(
          'missing_preferred_symbol',
          at(`classes.${classId}.preferred_symbol`),
          `首选符号 ${entry.preferredSymbol} 没有在 [assets.${entry.preferredSymbol}] 里定义`,
        );
      }
    }
  }

  // 规则 4：assets.*.class 必须是 targets 的键
  for (const [symbol, asset] of Object.entries(cfg.assets)) {
    if (asset.classId && !classIds.has(asset.classId)) {
      issues.add(
        'unknown_class',
        at(`assets.${symbol}.class`),
        `assets.${symbol}.class = ${asset.classId} 不在 [targets] 里`,
      );
    }
  }

  // 每个类别至少有一个资产（否则永远买不了）
  for (const classId of classIds) {
    if (cfg.targets[classId] <= 0) continue;
    const has = Object.values(cfg.assets).some((a) => a.classId === classId);
    if (!has) {
      issues.add('config_invalid', at(`targets.${classId}`), `类别 ${classId} 没有任何 [assets.*] 归属，无法下单`);
    }
  }
}

/**
 * 环境变量覆盖（SPEC §2.1）。非法值收进 issues，机器码 invalid_env。
 * @param {ReturnType<typeof defaults>} cfg
 * @param {NodeJS.ProcessEnv} env
 * @param {import('./errors.js').IssueList} issues
 * @returns {{offline: boolean, logLevel: string, quoteUrl: string, fxUrl: string, mockQuotesFile: string, mockFxFile: string, noColor: boolean}}
 */
export function applyEnv(cfg, env, issues) {
  const out = {
    offline: false,
    logLevel: 'warn',
    quoteUrl: DEFAULT_QUOTE_URL,
    fxUrl: DEFAULT_FX_URL,
    mockQuotesFile: path.join(PACKAGE_ROOT, 'fixtures', 'quotes.mock.json'),
    mockFxFile: path.join(PACKAGE_ROOT, 'fixtures', 'fx.mock.json'),
    noColor: env.NO_COLOR !== undefined,
  };
  const readInt = (name, min, max) => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw.trim())) {
      issues.add('invalid_env', name, `${name} 必须是 ${min}–${max} 的整数，当前是 ${JSON.stringify(raw)}`);
      return undefined;
    }
    const value = Number(raw.trim());
    if (value < min || value > max) {
      issues.add('invalid_env', name, `${name} 必须是 ${min}–${max} 的整数，当前是 ${value}`);
      return undefined;
    }
    return value;
  };

  if (env.REBAL_QUOTE_PROVIDER !== undefined) {
    if (!DEFAULT_QUOTE_PROVIDERS.includes(env.REBAL_QUOTE_PROVIDER)) {
      issues.add('invalid_env', 'REBAL_QUOTE_PROVIDER', `REBAL_QUOTE_PROVIDER 只能是 ${DEFAULT_QUOTE_PROVIDERS.join('/')}，当前是 ${env.REBAL_QUOTE_PROVIDER}`);
    } else {
      cfg.quotes.provider = env.REBAL_QUOTE_PROVIDER;
    }
  }
  if (env.REBAL_FX_PROVIDER !== undefined) {
    if (!DEFAULT_FX_PROVIDERS.includes(env.REBAL_FX_PROVIDER)) {
      issues.add('invalid_env', 'REBAL_FX_PROVIDER', `REBAL_FX_PROVIDER 只能是 ${DEFAULT_FX_PROVIDERS.join('/')}，当前是 ${env.REBAL_FX_PROVIDER}`);
    } else {
      cfg.fx.provider = env.REBAL_FX_PROVIDER;
    }
  }
  if (env.REBAL_OFFLINE !== undefined) {
    const raw = env.REBAL_OFFLINE.trim();
    if (raw === '1' || raw === 'true') out.offline = true;
    else if (raw === '0' || raw === 'false' || raw === '') out.offline = false;
    else issues.add('invalid_env', 'REBAL_OFFLINE', `REBAL_OFFLINE 只接受 0/1/true/false，当前是 ${JSON.stringify(raw)}`);
  }
  const timeout = readInt('REBAL_HTTP_TIMEOUT_MS', 100, 60000);
  if (timeout !== undefined) cfg.quotes.timeoutMs = timeout;
  const ttl = readInt('REBAL_CACHE_TTL_MINUTES', 0, 10080);
  if (ttl !== undefined) cfg.quotes.ttlMinutes = ttl;

  if (env.REBAL_LOG_LEVEL !== undefined) {
    if (!LOG_LEVELS.includes(env.REBAL_LOG_LEVEL)) {
      issues.add('invalid_env', 'REBAL_LOG_LEVEL', `REBAL_LOG_LEVEL 只能是 ${LOG_LEVELS.join('/')}，当前是 ${env.REBAL_LOG_LEVEL}`);
    } else {
      out.logLevel = env.REBAL_LOG_LEVEL;
    }
  }
  const urlCheck = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^https:\/\//.test(raw) && !/^http:\/\/127\.0\.0\.1/.test(raw)) {
      issues.add('invalid_env', name, `${name} 必须是 https:// 或 http://127.0.0.1 开头的地址，当前是 ${JSON.stringify(raw)}`);
      return fallback;
    }
    return raw;
  };
  out.quoteUrl = urlCheck('REBAL_QUOTE_URL', DEFAULT_QUOTE_URL);
  out.fxUrl = urlCheck('REBAL_FX_URL', DEFAULT_FX_URL);
  if (env.REBAL_MOCK_QUOTES_FILE !== undefined) out.mockQuotesFile = path.resolve(env.REBAL_MOCK_QUOTES_FILE);
  if (env.REBAL_MOCK_FX_FILE !== undefined) out.mockFxFile = path.resolve(env.REBAL_MOCK_FX_FILE);
  return out;
}

/**
 * 完整加载流程：路径 → TOML → 归一化 → 环境变量。
 * 有任一问题时抛 RebalError（带全部问题）。
 * @param {{dir?: string, config?: string, holdings?: string, stateDir?: string, env: NodeJS.ProcessEnv, cwd: string, issues?: import('./errors.js').IssueList}} opts
 */
export function loadConfig(opts) {
  const issues = opts.issues ?? new IssueList();
  const paths = resolvePaths(opts);
  const raw = readTomlFile(paths.configPath);
  const cfg = normalizeConfig(raw, issues, path.basename(paths.configPath));
  const env = applyEnv(cfg, opts.env, issues);
  issues.throwIfAny();
  return { config: cfg, env, paths };
}
