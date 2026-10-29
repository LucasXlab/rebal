/**
 * 带超时、重试、响应上限、错误映射的 fetch 封装（SPEC §5.4）。
 *
 * 只暴露一个 `requestText()`：取文本、不跟随重定向、按 provider 映射机器码。
 * 所有等待都通过注入的 `sleep`，测试里换成"记录参数、不真的等"。
 */

import { RebalError } from './errors.js';

export const MAX_BODY_BYTES = 1024 * 1024;

/** 查询参数里看起来像密钥的名字，一律打码。 */
const SECRET_PARAMS = ['token', 'key', 'api_key', 'apikey', 'secret', 'password'];

/**
 * 把 URL 里的密钥打码。用户信息（user:pass@）也打码。
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  let text = String(url);
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
      text = parsed.toString();
    }
    const reparsed = new URL(text);
    let changed = false;
    for (const name of SECRET_PARAMS) {
      if (reparsed.searchParams.has(name)) {
        reparsed.searchParams.set(name, '***');
        changed = true;
      }
    }
    return changed ? reparsed.toString() : text;
  } catch {
    return text.replace(/([?&](?:token|key|api_key|apikey|secret|password)=)[^&]*/gi, '$1***');
  }
}

/**
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>}} [deps]
 */
export function createHttp(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? { info: () => {}, debug: () => {} };
  /** 请求次数统计（`--verbose` 汇总用）。 */
  const stats = { requests: 0, retries: 0 };

  /**
   * 取一个文本资源。
   * @param {string} url
   * @param {{timeoutMs?: number, retries?: number, maxBytes?: number, provider?: 'quotes'|'fx', headers?: Record<string,string>}} [options]
   * @returns {Promise<{status: number, body: string, headers: Headers}>}
   */
  async function requestText(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 8000;
    const retries = options.retries ?? 2;
    const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
    const provider = options.provider ?? 'quotes';
    const httpCode = provider === 'fx' ? 'fx_http_error' : 'quote_http_error';
    const rateCode = provider === 'fx' ? 'fx_rate_limited' : 'quote_rate_limited';

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        // 第 k 次重试前等 500 × 2^(k-1)：500 / 1000 / 2000 / 4000
        stats.retries += 1;
        const waitMs = 500 * 2 ** (attempt - 1);
        log.info(`第 ${attempt} 次重试，等 ${waitMs}ms：${redactUrl(url)}`);
        await sleep(waitMs);
      }
      try {
        log.debug(`GET ${redactUrl(url)}`);
        const startedAt = Date.now();
        stats.requests += 1;
        const result = await once(url, { timeoutMs, maxBytes, headers: options.headers });
        log.info(`请求完成 HTTP ${result.status}，${Date.now() - startedAt}ms：${redactUrl(url)}`);
        log.debug(`响应前 200 字符：${String(result.body).slice(0, 200)}`);
        if (result.status >= 200 && result.status < 300) return result;

        if (result.status === 429) {
          lastError = new RebalError(rateCode, `行情源限流（HTTP 429）：${redactUrl(url)}`, {
            issues: [{ path: redactUrl(url), message: truncateBody(result.body) }],
          });
          continue; // 429 可重试
        }
        if (result.status >= 500) {
          lastError = new RebalError(httpCode, `行情源返回 HTTP ${result.status}：${redactUrl(url)}`, {
            issues: [{ path: redactUrl(url), message: truncateBody(result.body) }],
          });
          continue; // 5xx 可重试
        }
        if (result.status >= 300 && result.status < 400) {
          const location = result.headers.get('location') ?? '（没有 Location 头）';
          throw new RebalError('network_redirect', `行情源返回重定向 HTTP ${result.status}：${redactUrl(url)}`, {
            issues: [{ path: redactUrl(url), message: `Location: ${location}` }],
          });
        }
        // 其他 4xx：不重试
        throw new RebalError(httpCode, `行情源返回 HTTP ${result.status}：${redactUrl(url)}`, {
          issues: [{ path: redactUrl(url), message: truncateBody(result.body) }],
        });
      } catch (err) {
        if (err instanceof RebalError && !isRetryable(err.code)) throw err;
        if (err instanceof RebalError) {
          lastError = err;
          continue;
        }
        lastError = new RebalError('network_error', `请求失败：${redactUrl(url)}`, {
          issues: [{ path: redactUrl(url), message: err instanceof Error ? err.message : String(err) }],
        });
      }
    }
    throw lastError ?? new RebalError('network_error', `请求失败：${redactUrl(url)}`);
  }

  /**
   * 发一次请求，超时用 AbortController，读体时按字节数截断。
   * @param {string} url
   * @param {{timeoutMs: number, maxBytes: number, headers?: Record<string,string>}} options
   */
  async function once(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: options.headers ?? {},
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new RebalError('timeout', `请求超时（${options.timeoutMs} ms）：${redactUrl(url)}`, {
          issues: [{ path: redactUrl(url), message: `超过 ${options.timeoutMs} ms 没有响应` }],
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const body = await readBodyCapped(response, options.maxBytes, url);
    return { status: response.status, body, headers: response.headers };
  }

  return { requestText, stats };
}

/**
 * 读响应体，超过上限直接报错（不把整包读进内存）。
 * @param {Response} response
 * @param {number} maxBytes
 * @param {string} url
 * @returns {Promise<string>}
 */
async function readBodyCapped(response, maxBytes, url) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // 取消失败不影响判定
      }
      throw new RebalError('response_too_large', `响应超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB：${redactUrl(url)}`, {
        issues: [{ path: redactUrl(url), message: `已读到 ${(total / 1024 / 1024).toFixed(2)} MB，上限 ${maxBytes} 字节` }],
      });
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buffer.toString('utf8');
}

/**
 * @param {string} code
 */
function isRetryable(code) {
  return code === 'network_error' || code === 'timeout';
}

/** 错误信息里最多带 200 字符的响应体。 */
function truncateBody(body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
