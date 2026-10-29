/**
 * 测试公用工具：临时目录、假 HTTP 服务器、注入时钟、可复现的配置与持仓。
 * 规则（SPEC §9 补充要求）：不联网、不用固定 sleep、不写用户真实目录。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * 建临时目录，测试结束自动删除。
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeTempDir(t, prefix = 'rebal-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * 写文件（自动建父目录）。
 * @param {string} dir
 * @param {string} relativePath
 * @param {string} content
 * @returns {string}
 */
export function writeFile(dir, relativePath, content) {
  const file = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * @param {string} file
 * @returns {any}
 */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 一份能通过校验的配置（mock 行情 + 静态汇率，完全离线）。 */
export function validToml(overrides = {}) {
  const targets = overrides.targets ?? { us_equity: 0.5, cn_equity: 0.2, bond: 0.3 };
  const targetLines = Object.entries(targets)
    .map(([id, w]) => `${id} = ${w}`)
    .join('\n');
  return `[portfolio]
name = "我的组合"
base_currency = "CNY"

[policy]
allow_sell = ${overrides.allowSell ?? false}
min_trade_value = ${overrides.minTradeValue ?? 100}
max_orders = ${overrides.maxOrders ?? 20}

[quotes]
provider = "${overrides.quoteProvider ?? 'mock'}"
ttl_minutes = ${overrides.ttlMinutes ?? 720}
timeout_ms = ${overrides.timeoutMs ?? 8000}
retries = ${overrides.retries ?? 2}

[fx]
provider = "${overrides.fxProvider ?? 'static'}"
[fx.static]
USD = ${overrides.usdRate ?? 7.0}

[fees]
per_order = ${overrides.perOrder ?? 0}

[holdings]
path = "holdings.csv"
symbol_column = "symbol"
quantity_column = "quantity"
account_column = "account"
currency_column = "currency"
price_column = "price"
name_column = "name"

[targets]
${targetLines}

[bands]
default = ${overrides.band ?? 0.03}

[classes.us_equity]
preferred_symbol = "VTI"

[classes.cn_equity]
preferred_symbol = "510300"

[classes.bond]
preferred_symbol = "BND"

[assets.VTI]
class = "us_equity"
name = "Vanguard Total Stock Market ETF"
currency = "USD"
quote_id = "usVTI"

[assets.510300]
class = "cn_equity"
name = "沪深300ETF"
currency = "CNY"
lot_size = 100

[assets.BND]
class = "bond"
name = "Vanguard Total Bond Market ETF"
currency = "USD"
quote_id = "usBND"
`;
}

/** 与 validToml 配套的持仓。 */
export const HOLDINGS_CSV = `symbol,quantity,account,currency,price,name
VTI,10,ibkr,,,
BND,50,ibkr,,,
510300,1000,futu,,,
`;

/**
 * 造一个只在 127.0.0.1 上监听的假 HTTP 服务器。
 * @param {(req: http.IncomingMessage, index: number) => {status?: number, body?: string, headers?: Record<string,string>}} handler
 * @returns {Promise<{url: string, requests: {path: string, headers: http.IncomingHttpHeaders}[], close: () => Promise<void>}>}
 */
export async function fakeServer(handler) {
  /** @type {{path: string, headers: http.IncomingHttpHeaders}[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    const index = requests.length;
    requests.push({ path: req.url ?? '', headers: req.headers });
    const result = handler(req, index);
    res.writeHead(result.status ?? 200, { 'content-type': 'text/plain; charset=utf-8', ...(result.headers ?? {}) });
    res.end(result.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * 可注入的时钟。
 * @param {number} [startMs] 默认 2026-10-29T21:44:00-04:00
 */
export function makeClock(startMs = Date.parse('2026-10-29T21:44:00-04:00')) {
  let current = startMs;
  return {
    now: () => current,
    date: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

/**
 * 记录 sleep 调用但不真的等（退避断言用）。
 * @returns {{sleep: (ms: number) => Promise<void>, waits: number[]}}
 */
export function makeSleep() {
  const waits = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

/** 一份 mock 行情数据（与 validToml 配套）。 */
export const MOCK_QUOTES = {
  schemaVersion: 1,
  fetchedAt: '2026-01-01T00:00:00+00:00',
  quotes: {
    usVTI: { price: 300, currency: 'USD' },
    usBND: { price: 70, currency: 'USD' },
    'sh510300': { price: 4, currency: 'CNY' },
  },
};

/** 一份 mock 汇率数据。 */
export const MOCK_FX = {
  schemaVersion: 1,
  fetchedAt: '2026-01-01T00:00:00+00:00',
  base: 'CNY',
  rates: { USD: 7.0 },
};

/**
 * 把 mock 数据写到临时目录，返回环境变量对象。
 * @param {string} dir
 * @param {{quotes?: unknown, fx?: unknown}} [data]
 */
export function writeMockFixtures(dir, data = {}) {
  const quotesFile = writeFile(dir, 'mock/quotes.json', JSON.stringify(data.quotes ?? MOCK_QUOTES, null, 2));
  const fxFile = writeFile(dir, 'mock/fx.json', JSON.stringify(data.fx ?? MOCK_FX, null, 2));
  return { REBAL_MOCK_QUOTES_FILE: quotesFile, REBAL_MOCK_FX_FILE: fxFile };
}

/** 干净的 env（不继承真实环境变量）。 */
export const CLEAN_ENV = Object.freeze({});
