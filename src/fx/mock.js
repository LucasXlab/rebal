/**
 * mock 汇率：`{"base":"CNY","rates":{"USD":7.0}}`，rates 就是 rateToBase。
 */

import fs from 'node:fs';
import { RebalError } from '../errors.js';
import { parseAmount } from '../util.js';

/**
 * @param {string} filePath
 * @returns {{fetchedAt: string, rates: Map<string, number>}}
 */
export function readMockFx(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new RebalError('mock_fixture_invalid', `mock 汇率文件读不了或不是合法 JSON：${filePath}`, {
      issues: [{ path: filePath, message: err instanceof Error ? err.message : String(err) }],
    });
  }
  if (!parsed || typeof parsed.rates !== 'object' || parsed.rates === null) {
    throw new RebalError('mock_fixture_invalid', `mock 汇率文件缺少 rates 对象：${filePath}`, {
      issues: [{ path: filePath, message: '需要 {"rates": {"USD": 7.0}} 这样的结构' }],
    });
  }
  /** @type {Map<string, number>} */
  const rates = new Map();
  for (const [currency, raw] of Object.entries(/** @type {Record<string, unknown>} */ (parsed.rates))) {
    const rate = parseAmount(raw);
    if (rate === null || rate <= 0) {
      throw new RebalError('mock_fixture_invalid', `mock 汇率里 ${currency} 的值非法`, {
        issues: [{ path: filePath, message: `rates.${currency} 必须是正数` }],
      });
    }
    rates.set(currency.toUpperCase(), rate);
  }
  return { fetchedAt: parsed.fetchedAt ?? '2026-01-01T00:00:00+00:00', rates };
}
