/**
 * 腾讯行情解析（SPEC §5.3，实测记录见 docs/external-apis.md）。
 *
 * 响应是 GBK 编码的 `v_usVTI="200~名称~代码~价格~…";`，价格在按 `~` 分隔的第 4 段。
 * 只在这里解析字段位置：接口一变，最坏结果是"取不到价格"并报错，而不是算出错误订单。
 */

import { RebalError } from '../errors.js';

/**
 * 把 GBK 字节解成字符串。Node 官方构建带 full-icu，`TextDecoder('gbk')` 可用；
 * 万一不可用（自定义 small-icu 构建），退化为按 Latin-1 解——价格与数字都是 ASCII，不受影响。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeGbk(bytes) {
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/**
 * 解析响应文本，返回 quote_id → {price, currency}。
 * @param {string} text
 * @returns {Map<string, {price: number}>}
 */
export function parseTencentResponse(text) {
  /** @type {Map<string, {price: number}>} */
  const result = new Map();
  for (const line of String(text).split(';')) {
    const match = /^\s*v_([A-Za-z0-9._-]+)="(.*)"\s*$/.exec(line);
    if (!match) continue;
    const quoteId = match[1];
    const fields = match[2].split('~');
    if (fields.length <= 3) continue;
    const price = Number(fields[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    result.set(quoteId, { price });
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
