/**
 * 自报价行情源（`quotes.provider = "csv"`）。
 * 表头固定 symbol,price,currency,as_of；缺失符号报 quote_not_found。
 */

import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { RebalError } from '../errors.js';
import { parseAmount } from '../util.js';

export const REQUIRED_COLUMNS = ['symbol', 'price', 'currency', 'as_of'];

/**
 * 读自报价文件。
 * @param {string} filePath
 * @returns {Map<string, {price: number, currency: string, asOf: string}>}
 */
export function readPriceFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new RebalError('config_invalid', `自报价文件读不了：${filePath}`, {
      issues: [{ path: filePath, message: '检查配置 quotes.price_file' }],
    });
  }
  /** @type {string[][]} */
  let rows;
  try {
    rows = parse(text, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (err) {
    throw new RebalError('config_invalid', `自报价文件不是合法 CSV：${filePath}`, {
      issues: [{ path: filePath, message: err instanceof Error ? err.message : String(err) }],
    });
  }
  if (rows.length === 0) {
    throw new RebalError('config_invalid', `自报价文件是空的：${filePath}`, {
      issues: [{ path: filePath, message: `表头必须是 ${REQUIRED_COLUMNS.join(',')}` }],
    });
  }
  const header = rows[0].map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new RebalError('config_invalid', `自报价文件缺列：${missing.join('、')}`, {
      issues: [{ path: filePath, message: `实际表头：${header.join(',')}` }],
    });
  }
  const index = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, header.indexOf(c)]));

  /** @type {Map<string, {price: number, currency: string, asOf: string}>} */
  const quotes = new Map();
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const symbol = (cells[index.symbol] ?? '').trim().toUpperCase();
    const price = parseAmount(cells[index.price]);
    const currency = (cells[index.currency] ?? '').trim().toUpperCase();
    const asOf = (cells[index.as_of] ?? '').trim();
    if (!symbol) return;
    if (price === null || price <= 0) {
      throw new RebalError('quote_invalid', `自报价第 ${line} 行价格非法：${JSON.stringify(cells[index.price])}`, {
        issues: [{ path: `${symbol}`, message: 'price 必须是正数' }],
      });
    }
    quotes.set(symbol, { price, currency, asOf });
  });
  return quotes;
}
