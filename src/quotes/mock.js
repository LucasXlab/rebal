/**
 * mock 行情源：读 JSON 文件，按 quote_id 查。
 * 用于 `init --demo`、测试与完全离线演示（SPEC §7）。
 */

import fs from 'node:fs';
import { RebalError } from '../errors.js';
import { parseAmount } from '../util.js';

/**
 * @param {string} filePath
 * @returns {{fetchedAt: string, quotes: Map<string, {price: number, currency: string|null}>}}
 */
export function readMockQuotes(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new RebalError('mock_fixture_invalid', `mock 行情文件读不了或不是合法 JSON：${filePath}`, {
      issues: [{ path: filePath, message: err instanceof Error ? err.message : String(err) }],
    });
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.quotes !== 'object' || parsed.quotes === null) {
    throw new RebalError('mock_fixture_invalid', `mock 行情文件缺少 quotes 对象：${filePath}`, {
      issues: [{ path: filePath, message: '需要 {"quotes": {"usVTI": {"price": 300}}} 这样的结构' }],
    });
  }
  /** @type {Map<string, {price: number, currency: string|null}>} */
  const quotes = new Map();
  for (const [quoteId, raw] of Object.entries(/** @type {Record<string, any>} */ (parsed.quotes))) {
    const price = parseAmount(raw?.price);
    if (price === null || price <= 0) {
      throw new RebalError('mock_fixture_invalid', `mock 行情里 ${quoteId} 的 price 非法`, {
        issues: [{ path: filePath, message: `quotes.${quoteId}.price 必须是正数` }],
      });
    }
    quotes.set(quoteId, { price, currency: raw?.currency ?? null });
  }
  return { fetchedAt: parsed.fetchedAt ?? '2026-01-01T00:00:00+00:00', quotes };
}
