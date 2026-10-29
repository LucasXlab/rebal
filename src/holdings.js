/**
 * 持仓 CSV 的读取与校验（SPEC §2.4）。
 *
 * 用 csv-parse 的同步接口：文件有 5 MB / 5000 行上限，整读到内存是安全的，
 * 而且同步实现让"先判大小再解析"的顺序可用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { IssueList, RebalError } from './errors.js';
import { isCurrencyCode, isSymbolCode, parseAmount } from './util.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;

/**
 * @typedef {object} HoldingRow
 * @property {string} symbol 已转大写
 * @property {number} quantity
 * @property {string} account
 * @property {string|null} currency CSV 覆盖的币种
 * @property {number|null} price CSV 覆盖的价格
 * @property {string} name
 * @property {number} line 原始行号（1 基，含表头）
 */

/**
 * @typedef {object} Holdings
 * @property {HoldingRow[]} items 逐行（多账户不合并）
 * @property {Map<string, {symbol: string, quantity: number, currency: string|null, price: number|null, name: string, accounts: Map<string, number>}>} bySymbol 合并后的持仓
 * @property {string[]} warnings
 */

/**
 * 读持仓文件并解析。
 * @param {string} filePath
 * @param {ReturnType<typeof import('./config.js').defaults>['holdings']} mapping
 * @returns {Holdings}
 */
export function readHoldings(filePath, mapping) {
  const issues = new IssueList();
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new RebalError('holdings_not_found', `持仓文件不存在：${filePath}`, {
      issues: [{ path: filePath, message: '检查配置里的 holdings.path 或环境变量 REBAL_HOLDINGS' }],
    });
  }
  if (!stat.isFile()) {
    throw new RebalError('holdings_not_found', `持仓路径不是文件：${filePath}`, {
      issues: [{ path: filePath, message: 'holdings.path 必须指向一个 CSV 文件' }],
    });
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new RebalError('holdings_too_large', `持仓文件超过 5 MB：${filePath}`, {
      issues: [{ path: filePath, message: `实际 ${(stat.size / 1024 / 1024).toFixed(2)} MB，上限 5 MB` }],
    });
  }

  const text = fs.readFileSync(filePath, 'utf8');
  /** @type {string[][]} */
  let rows;
  try {
    rows = parse(text, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    });
  } catch (err) {
    throw new RebalError('holdings_invalid', `持仓 CSV 解析失败：${filePath}`, {
      issues: [{ path: filePath, message: err instanceof Error ? err.message : String(err) }],
    });
  }
  if (rows.length === 0) {
    throw new RebalError('holdings_invalid', `持仓文件是空的：${filePath}`, {
      issues: [{ path: filePath, message: '至少要有表头行（symbol,quantity）' }],
    });
  }

  const header = rows[0].map((h) => h.trim());
  const columns = indexOfColumns(header, mapping, issues, filePath);
  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_ROWS) {
    throw new RebalError('holdings_too_large', `持仓文件超过 ${MAX_ROWS} 行：${filePath}`, {
      issues: [{ path: filePath, message: `实际 ${dataRows.length} 行数据` }],
    });
  }

  /** @type {HoldingRow[]} */
  const items = [];
  dataRows.forEach((cells, index) => {
    const line = index + 2;
    const get = (column) => (column === null ? undefined : (cells[columns[column]] ?? '').trim());

    const rawSymbol = get('symbol');
    if (!rawSymbol) {
      issues.add('holdings_invalid', `${path.basename(filePath)}:${line}`, 'symbol 不能为空');
      return;
    }
    if (!isSymbolCode(rawSymbol)) {
      issues.add(
        'holdings_invalid',
        `${path.basename(filePath)}:${line}`,
        `symbol ${JSON.stringify(rawSymbol)} 只能用字母、数字、点、下划线、短横线，1–16 个字符`,
      );
      return;
    }
    const symbol = rawSymbol.toUpperCase();

    const rawQuantity = get('quantity');
    const quantity = parseAmount(rawQuantity);
    if (quantity === null || quantity <= 0 || quantity > 1e12) {
      issues.add(
        'holdings_invalid',
        `${path.basename(filePath)}:${line}`,
        `${symbol} 的 quantity 必须是 0–1e12 之间的正数，当前是 ${JSON.stringify(rawQuantity)}`,
      );
      return;
    }
    const rawAccount = get('account');
    const account = rawAccount && rawAccount.length > 0 ? rawAccount : 'default';
    if (account.length > 40) {
      issues.add('holdings_invalid', `${path.basename(filePath)}:${line}`, 'account 最长 40 个字符');
      return;
    }

    const rawCurrency = get('currency');
    let currency = null;
    if (rawCurrency) {
      const upper = rawCurrency.toUpperCase();
      if (!isCurrencyCode(upper)) {
        issues.add('holdings_invalid', `${path.basename(filePath)}:${line}`, `currency ${JSON.stringify(rawCurrency)} 必须是三个大写字母`);
        return;
      }
      currency = upper;
    }

    const rawPrice = get('price');
    let price = null;
    if (rawPrice) {
      const value = parseAmount(rawPrice);
      if (value === null || value <= 0) {
        issues.add('holdings_invalid', `${path.basename(filePath)}:${line}`, `price ${JSON.stringify(rawPrice)} 必须是正数`);
        return;
      }
      price = value;
    }

    const name = get('name') ?? '';
    if (name.length > 80) {
      issues.add('holdings_invalid', `${path.basename(filePath)}:${line}`, 'name 最长 80 个字符');
      return;
    }

    items.push({ symbol, quantity, account, currency, price, name, line });
  });

  issues.throwIfAny();

  const { bySymbol, warnings } = mergeBySymbol(items);
  return { items, bySymbol, warnings };
}

/**
 * 表头 → 列下标。必需列缺失直接报错；可选列名非空但 CSV 里没有 → 视为未提供。
 * @param {string[]} header
 * @param {ReturnType<typeof import('./config.js').defaults>['holdings']} mapping
 * @param {import('./errors.js').IssueList} issues
 * @param {string} filePath
 * @returns {Record<string, number|null>}
 */
function indexOfColumns(header, mapping, issues, filePath) {
  const find = (columnName) => {
    if (columnName === '') return null;
    const index = header.indexOf(columnName);
    return index === -1 ? null : index;
  };
  const symbolIndex = find(mapping.symbolColumn);
  const quantityIndex = find(mapping.quantityColumn);
  if (symbolIndex === null) {
    issues.add(
      'holdings_missing_column',
      path.basename(filePath),
      `表头里没有 symbol 列（配置 holdings.symbol_column = ${JSON.stringify(mapping.symbolColumn)}），实际表头：${header.join(',')}`,
    );
  }
  if (quantityIndex === null) {
    issues.add(
      'holdings_missing_column',
      path.basename(filePath),
      `表头里没有 quantity 列（配置 holdings.quantity_column = ${JSON.stringify(mapping.quantityColumn)}），实际表头：${header.join(',')}`,
    );
  }
  return {
    symbol: symbolIndex,
    quantity: quantityIndex,
    account: find(mapping.accountColumn),
    currency: find(mapping.currencyColumn),
    price: find(mapping.priceColumn),
    name: find(mapping.nameColumn),
  };
}

/**
 * 同一符号多行合并：数量求和、账户分别记、币种冲突报错、价格不一致只警告。
 * @param {HoldingRow[]} items
 */
function mergeBySymbol(items) {
  /** @type {Holdings['bySymbol']} */
  const bySymbol = new Map();
  /** @type {string[]} */
  const warnings = [];
  for (const item of items) {
    const existing = bySymbol.get(item.symbol);
    if (!existing) {
      bySymbol.set(item.symbol, {
        symbol: item.symbol,
        quantity: item.quantity,
        currency: item.currency,
        price: item.price,
        name: item.name,
        accounts: new Map([[item.account, item.quantity]]),
      });
      continue;
    }
    if (existing.currency && item.currency && existing.currency !== item.currency) {
      throw new RebalError('currency_conflict', `${item.symbol} 在不同行填了不同币种：${existing.currency} 与 ${item.currency}`, {
        issues: [
          {
            path: item.symbol,
            message: `第 ${item.line} 行是 ${item.currency}，之前是 ${existing.currency}；同一标的的币种必须一致`,
          },
        ],
      });
    }
    if (existing.price !== null && item.price !== null && existing.price !== item.price) {
      warnings.push(`${item.symbol} 多行价格不一致，取第一行 ${existing.price}`);
    }
    existing.quantity += item.quantity;
    existing.currency = existing.currency ?? item.currency;
    existing.price = existing.price ?? item.price;
    existing.name = existing.name || item.name;
    existing.accounts.set(item.account, (existing.accounts.get(item.account) ?? 0) + item.quantity);
  }
  return { bySymbol, warnings };
}

/**
 * 持仓里出现的符号必须在 assets 里定义（`check` 例外，见 SPEC §2.4）。
 * @param {Holdings} holdings
 * @param {Record<string, unknown>} assets
 * @param {import('./errors.js').IssueList} issues
 */
export function checkSymbolsKnown(holdings, assets, issues) {
  for (const item of holdings.items) {
    if (!assets[item.symbol]) {
      issues.add(
        'unknown_symbol',
        `${item.symbol}`,
        `持仓里的 ${item.symbol}（第 ${item.line} 行）没有在 [assets.${item.symbol}] 里定义；补一段 [assets.${item.symbol}] 或从持仓里删掉它`,
      );
    }
  }
}

/**
 * 从配置解析持仓文件路径。
 * @param {{paths: {dir: string, holdingsOverride: string|null}, config: {holdings: {path: string}}}} ctx
 * @returns {string}
 */
export function resolveHoldingsPath({ paths, config }) {
  if (paths.holdingsOverride) {
    return path.resolve(paths.dir, paths.holdingsOverride);
  }
  return path.resolve(paths.dir, config.holdings.path);
}
