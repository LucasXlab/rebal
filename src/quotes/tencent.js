/**
 * 腾讯行情解析（SPEC §5.3，实测记录见 docs/external-apis.md）。
 *
 * 响应是 GBK 编码的 `v_usVTI="200~名称~代码~价格~…";`，价格在按 `~` 分隔的第 4 段。
 * 只在这里解析字段位置：接口一变，最坏结果是"取不到价格"并报错，而不是算出错误订单。
 */

import { RebalError } from '../errors.js';
import { decodeGbk } from '../text.js';

export { decodeGbk };

/**
 * 腾讯的 quote_id 前缀决定市场，市场决定币种。这个映射是稳定契约，
 * 不依赖响应里第几段是什么（沪深与美股的字段布局并不一样，按固定下标取币种会取错）。
 */
export const MARKET_CURRENCY = Object.freeze({
  us: 'USD',
  sh: 'CNY',
  sz: 'CNY',
  hk: 'HKD',
});

/**
 * 由 quote_id 推断上游市场币种；前缀不认识时返回 null（不校验）。
 * @param {string} quoteId
 * @returns {string|null}
 */
export function currencyForQuoteId(quoteId) {
  const prefix = /^([a-z]{2})/.exec(quoteId)?.[1];
  return prefix ? (MARKET_CURRENCY[prefix] ?? null) : null;
}

/**
 * 解析响应文本，返回 quote_id → {price, code, name}。
 *
 * 保留上游给的代码与名称：`prices` 会把它们显示出来供人核对，
 * 这是"写错一个字母就买到别的标的"这类错误唯一能被人眼抓住的地方。
 * @param {string} text
 * @returns {Map<string, {price: number, code: string|null, name: string|null}>}
 */
export function parseTencentResponse(text) {
  /** @type {Map<string, {price: number, code: string|null, name: string|null}>} */
  const result = new Map();
  for (const line of String(text).split(';')) {
    const match = /^\s*v_([A-Za-z0-9._-]+)="(.*)"\s*$/.exec(line);
    if (!match) continue;
    const quoteId = match[1];
    const fields = match[2].split('~');
    if (fields.length <= 3) continue;
    const price = Number(fields[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    result.set(quoteId, {
      price,
      code: fields[2] ? String(fields[2]).trim() : null,
      name: fields[1] ? String(fields[1]).trim() : null,
    });
  }
  return result;
}

/**
 * 拼请求 URL：`REBAL_QUOTE_URL` + 逗号分隔的 quote_id（腾讯是路径式的 `q=xxx`）。
 * @param {string} base
 * @param {string[]} quoteIds
 * @returns {string}
 */
export function buildTencentUrl(base, quoteIds) {
  return `${base}${quoteIds.join(',')}`;
}

/**
 * 取一批行情。
 * @param {{requestText: Function}} http
 * @param {{url: string, quoteIds: string[], timeoutMs: number, retries: number, headers?: Record<string,string>}} options
 * @returns {Promise<Map<string, {price: number}>>}
 */
export async function fetchTencent(http, options) {
  const url = buildTencentUrl(options.url, options.quoteIds);
  const response = await http.requestText(url, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    provider: 'quotes',
    headers: options.headers,
    // 腾讯返回 GBK；不按 GBK 解会得到乱码名称
    charset: 'gbk',
  });
  return parseTencentResponse(response.body);
}

/**
 * 行情响应里没有这个 quote_id 时抛 quote_not_found。
 * @param {string} symbol
 * @param {string} quoteId
 * @returns {never}
 */
export function quoteNotFound(symbol, quoteId) {
  throw new RebalError('quote_not_found', `取不到 ${symbol} 的价格（行情里没有 ${quoteId}）`, {
    issues: [
      {
        path: symbol,
        message: `确认 [assets.${symbol}] 的 quote_id = ${quoteId} 是否正确（美股 us、沪市 sh、深市 sz、港股 hk 前缀）`,
      },
    ],
  });
}
