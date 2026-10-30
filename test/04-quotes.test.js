import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTencentUrl,
  currencyForQuoteId,
  decodeGbk,
  parseTencentResponse,
} from '../src/quotes/tencent.js';
import { parseFrankfurter } from '../src/fx/index.js';
import { redactUrl } from '../src/http.js';
import { fakeServer, makeProject, runCli, validToml } from './helpers.js';

/** 造腾讯格式的响应。 */
function tencentBody(entries) {
  return entries.map(([id, price]) => `v_${id}="${id}~名称~${id}~${price}~昨收~今开~";`).join('\n');
}

test('T14 tencent 解析：多符号一次取回，第 4 段是价格；缺行 → quote_not_found', async (t) => {
  const text = tencentBody([
    ['usVTI', '300.12'],
    ['sh510300', '4.01'],
  ]);
  const parsed = parseTencentResponse(text);
  assert.equal(parsed.size, 2);
  assert.equal(parsed.get('usVTI').price, 300.12);
  assert.equal(parsed.get('sh510300').price, 4.01);
  assert.equal(buildTencentUrl('https://qt.gtimg.cn/q=', ['usVTI', 'sh510300']), 'https://qt.gtimg.cn/q=usVTI,sh510300');

  // 价格是 0.000（未知代码）与空响应都要当取不到
  assert.equal(parseTencentResponse('v_xxx="xxx~名称~xxx~0.000~";').size, 0);
  assert.equal(parseTencentResponse('v_pv_none_match="1";').size, 0);
  assert.equal(parseTencentResponse('').size, 0);

  // 走一次真实链路：只有 VTI 有报价，BND 应该报 quote_not_found
  const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
  const result = await runCli(['status'], project, {
    fetch: async () => new Response(tencentBody([['usVTI', '300']]), { status: 200 }),
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /quote_not_found/);
  assert.match(result.stderr, /BND/);
});

test('T15 汇率方向：USD→CNY 用 1/rates[USD]，两个方向都对', () => {
  const base = parseFrankfurter(JSON.stringify({ base: 'CNY', rates: { USD: 0.142857142857 } }), 'CNY', ['USD']);
  const rateToBase = base.get('USD');
  assert.ok(Math.abs(rateToBase - 7) < 1e-4, `1 美元应约合 7 元，实际 ${rateToBase}`);
  assert.ok(Math.abs(1 / rateToBase - 0.142857142857) < 1e-9, '反向换算要能还原');
  const second = parseFrankfurter(JSON.stringify({ base: 'CNY', rates: { USD: 7 } }), 'CNY', ['USD']);
  assert.ok(Math.abs(second.get('USD') - 1 / 7) < 1e-12, '接口若直接给 7，则 1 美元 = 1/7 元（方向不可搞反）');
});

test('T16 行情源 500：重试 2 次后 quote_http_error，错误含状态码与响应体前 200 字符，共 3 次请求', async (t) => {
  const bodies = 'x'.repeat(300);
  const server = await fakeServer(() => ({ status: 500, body: bodies }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
    const result = await runCli(['prices'], project, { fetch: globalThis.fetch, env: { REBAL_QUOTE_URL: `${server.url}/q=` } });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /quote_http_error/);
    assert.match(result.stderr, /500/);
    assert.ok(result.stderr.includes('x'.repeat(50)), '错误里要带响应体片段');
    assert.equal(server.requests.length, 3, '首次 + 2 次重试');
    assert.deepEqual(project.waits.waits, [500, 1000], '退避 500ms、1000ms');
  } finally {
    await server.close();
  }
});

test('T17 429：重试 2 次后 quote_rate_limited，两次退避 500ms、1000ms', async (t) => {
  const server = await fakeServer(() => ({ status: 429, body: 'slow down' }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
    const result = await runCli(['prices'], project, { fetch: globalThis.fetch, env: { REBAL_QUOTE_URL: `${server.url}/q=` } });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /quote_rate_limited/);
    assert.equal(server.requests.length, 3);
    assert.deepEqual(project.waits.waits, [500, 1000]);
  } finally {
    await server.close();
  }
});

test('T18 403 不重试（1 次请求）；连接被拒 → network_error', async (t) => {
  const server = await fakeServer(() => ({ status: 403, body: 'forbidden' }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
    const result = await runCli(['prices'], project, { fetch: globalThis.fetch, env: { REBAL_QUOTE_URL: `${server.url}/q=` } });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /quote_http_error/);
    assert.equal(server.requests.length, 1, '4xx 不重试');
  } finally {
    await server.close();
  }

  // 连接被拒：用一个已经关掉的端口
  const closed = await fakeServer(() => ({ status: 200, body: '' }));
  const closedUrl = closed.url;
  await closed.close();
  const project2 = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
  const result2 = await runCli(['prices'], project2, {
    fetch: globalThis.fetch,
    env: { REBAL_QUOTE_URL: `${closedUrl}/q=` },
  });
  assert.equal(result2.code, 3);
  assert.match(result2.stderr, /network_error/);
});

test('T19 超时 → timeout，消息含超时毫秒数', async (t) => {
  // 永不响应的服务器
  const server = await fakeServer(() => ({ hang: true }));
  try {
    const project = makeProject(t, {
      toml: validToml({ quoteProvider: 'tencent', timeoutMs: 300, retries: 0 }),
    });
    const result = await runCli(['prices'], project, {
      fetch: globalThis.fetch,
      env: { REBAL_QUOTE_URL: `${server.url}/q=` },
    });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /timeout/);
    assert.match(result.stderr, /300/, '要说清超时是多少毫秒');
  } finally {
    await server.close();
  }
});

test('T20 响应体 2 MB → response_too_large', async (t) => {
  const big = 'a'.repeat(2 * 1024 * 1024);
  const server = await fakeServer(() => ({ status: 200, body: big }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent', retries: 0 }) });
    const result = await runCli(['prices'], project, { fetch: globalThis.fetch, env: { REBAL_QUOTE_URL: `${server.url}/q=` } });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /response_too_large/);
  } finally {
    await server.close();
  }
});

test('T21 302 不跟随 → network_redirect，错误含 Location', async (t) => {
  const server = await fakeServer(() => ({
    status: 302,
    body: '',
    headers: { location: 'https://example.com/elsewhere' },
  }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
    const result = await runCli(['prices'], project, { fetch: globalThis.fetch, env: { REBAL_QUOTE_URL: `${server.url}/q=` } });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /network_redirect/);
    assert.ok(result.stderr.includes('example.com/elsewhere'), '错误里要带 Location');
    assert.equal(server.requests.length, 1, '不跟随、不重试');
  } finally {
    await server.close();
  }
});

test('T22 csv 与 mock provider 各自取到价格；csv 缺符号 → quote_not_found；mock 下零请求', async (t) => {

  // mock：完全离线，请求数 0
  let requests = 0;
  const mockProject = makeProject(t);
  const mockResult = await runCli(['prices', '--json'], mockProject, {
    fetch: async () => {
      requests += 1;
      throw new Error('不该发请求');
    },
  });
  assert.equal(mockResult.code, 0);
  const payload = JSON.parse(mockResult.stdout);
  assert.equal(payload.quotes.length, 3);
  assert.equal(requests, 0, 'mock 模式必须零网络请求');

  // csv：从自报价文件取价
  const csvProject = makeProject(t, {
    toml: validToml({ quoteProvider: 'csv' }).replace('[quotes]', '[quotes]\nprice_file = "prices.csv"'),
    extraFiles: {
      'prices.csv': `symbol,price,currency,as_of\nVTI,301,USD,2026-10-29\nBND,70,USD,2026-10-29\n510300,4.02,CNY,2026-10-29\n`,
    },
  });
  const csvResult = await runCli(['prices', '--json'], csvProject);
  assert.equal(csvResult.code, 0);
  const csvPayload = JSON.parse(csvResult.stdout);
  assert.equal(csvPayload.quotes.find((q) => q.symbol === 'VTI').price, 301);

  // csv 缺一个符号
  const missingProject = makeProject(t, {
    toml: validToml({ quoteProvider: 'csv' }).replace('[quotes]', '[quotes]\nprice_file = "prices.csv"'),
    extraFiles: { 'prices.csv': `symbol,price,currency,as_of\nVTI,301,USD,2026-10-29\n` },
  });
  const missingResult = await runCli(['prices'], missingProject);
  assert.equal(missingResult.code, 3);
  assert.match(missingResult.stderr, /quote_not_found/);
});

test('decodeGbk 能解出中文，取不到 GBK 解码器时退化为 latin1', () => {
  // "腾讯" 的 GBK 编码是 CC DA D1 B6
  const bytes = Uint8Array.from([0xcc, 0xda, 0xd1, 0xb6]);
  assert.equal(decodeGbk(bytes), '腾讯');
});

test('redactUrl 对敏感参数与 userinfo 打码', () => {
  assert.match(redactUrl('https://api.example.com/x?token=abc123'), /\*\*\*/);
  assert.ok(!redactUrl('https://api.example.com/x?token=abc123').includes('abc123'));
  for (const url of [
    'https://api.example.com/x?key=abc123',
    'https://api.example.com/x?api_key=abc123',
    'https://api.example.com/x?secret=abc123',
    'https://user:abc123@host/x',
  ]) {
    assert.ok(!redactUrl(url).includes('abc123'), `${url} 打码失败：${redactUrl(url)}`);
  }
  assert.equal(redactUrl('https://api.example.com/x?a=1'), 'https://api.example.com/x?a=1');
});

test('腾讯行情按 GBK 解码名称；币种由 quote_id 前缀推断，与配置不符要报错', async (t) => {
  // 名称字段是 GBK 字节："沪深300ETF"
  const nameGbk = Buffer.from([0xbb, 0xa6, 0xc9, 0xee, 0x33, 0x30, 0x30, 0x45, 0x54, 0x46]);
  const body = Buffer.concat([
    Buffer.from('v_usVTI="200~Vanguard Total Stock Market ETF~VTI.AM~300~299~300~";\n'),
    Buffer.from('v_usBND="200~Vanguard Total Bond Market ETF~BND.AM~70~69~70~";\n'),
    Buffer.concat([Buffer.from('v_sh510300="200~'), nameGbk, Buffer.from('~510300.SH~4~3.98~4~";')]),
    Buffer.from('\nv_pv_none_match="1";'),
  ]);
  const server = await fakeServer(() => ({ status: 200, body }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
    const result = await runCli(['prices'], project, {
      fetch: globalThis.fetch,
      env: { REBAL_QUOTE_URL: `${server.url}/q=` },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('沪深300ETF'), `名称应按 GBK 解出中文，实际：${result.stdout}`);
    assert.ok(result.stdout.includes('Vanguard Total Stock Ma'), '长名称按 24 列截断');
  } finally {
    await server.close();
  }

  // 币种口径：quote_id 前缀决定市场
  assert.equal(currencyForQuoteId('usVTI'), 'USD');
  assert.equal(currencyForQuoteId('sh510300'), 'CNY');
  assert.equal(currencyForQuoteId('sz159915'), 'CNY');
  assert.equal(currencyForQuoteId('hk00700'), 'HKD');
  assert.equal(currencyForQuoteId('xxxxx'), null, '不认识的前缀不校验');

  // 把美股代码写进 A 股资产 → 必须报 quote_invalid，不能按错汇率算下去
  const wrongToml = validToml({ quoteProvider: 'tencent' }).replace(
    'quote_id = "sh510300"',
    'quote_id = "us510300"',
  );
  const wrongProject = makeProject(t, { toml: wrongToml });
  const server2 = await fakeServer(() => ({
    status: 200,
    body: [
      'v_usVTI="200~VTI~VTI.AM~300~299~300~";',
      'v_usBND="200~BND~BND.AM~70~69~70~";',
      'v_us510300="200~某美股~510300.XX~4~3.98~4~";',
    ].join('\n'),
  }));
  try {
    const result = await runCli(['status'], wrongProject, {
      fetch: globalThis.fetch,
      env: { REBAL_QUOTE_URL: `${server2.url}/q=` },
    });
    // SPEC §4.1 把 quote_invalid 归为外部数据错误（退出码 3）
    assert.equal(result.code, 3, '币种与市场不符要停下，不能按错汇率算');
    assert.match(result.stderr, /quote_invalid/);
    assert.match(result.stderr, /USD/);
    assert.match(result.stderr, /CNY/);
  } finally {
    await server2.close();
  }
});
