import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fakeServer, makeProject, runCli, validToml } from './helpers.js';

const TENCENT_BODY = [
  'v_usVTI="usVTI~VTI~VTI~300~299~300~";',
  'v_usBND="usBND~BND~BND~70~69~70~";',
  'v_sh510300="sh510300~沪深300ETF~510300~4~3.98~4~";',
].join('\n');

test('T2 init 生成配置与持仓两件文件；已存在时报 config_exists，--force 可覆盖', async (t) => {
  const dir = makeProject(t).dir;
  const empty = path.join(dir, 'fresh');
  const project = { ...makeProject(t), dir: empty, env: {} };
  project.tmpDir = path.join(dir, 'tmp2');
  fs.mkdirSync(project.tmpDir, { recursive: true });

  const created = await runCli(['init'], project);
  assert.equal(created.code, 0, created.stderr);
  assert.ok(fs.existsSync(path.join(empty, 'rebal.toml')));
  assert.ok(fs.existsSync(path.join(empty, 'holdings.csv')));

  const again = await runCli(['init'], project);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /config_exists/);

  fs.writeFileSync(path.join(empty, 'rebal.toml'), '# 我的修改', 'utf8');
  const forced = await runCli(['init', '--force', '--demo'], project);
  assert.equal(forced.code, 0, forced.stderr);
  assert.ok(fs.readFileSync(path.join(empty, 'rebal.toml'), 'utf8').includes('示例组合'), '--force 要覆盖');
});

test('T45 60 列终端降级为逐行列表且数字不被截断；--color never 无 ANSI', async (t) => {
  const project = makeProject(t);
  const narrow = await runCli(['status'], project, { columns: 60 });
  assert.equal(narrow.code, 0);
  assert.ok(narrow.stdout.includes('45,500.00'), '金额要完整，不能被截断');
  assert.ok(!/\x1b\[/.test(narrow.stdout), '--color never 不应该有 ANSI 转义');

  const wide = await runCli(['status'], project, { columns: 120 });
  assert.ok(wide.stdout.includes('资产类别'), '宽终端用表格');

  const colored = await runCli(['status'], project, { columns: 120, color: 'always' });
  assert.ok(/\x1b\[3[123]m/.test(colored.stdout), '--color always 应该有状态色');
});

test('T46 九种失败的退出码与机器码；内部错误退出码 1 且错误日志含 stack', async (t) => {
  // 1. unknown_field → 2（拼错的键放进已有的表里）
  const unknownField = makeProject(t, {
    toml: validToml().replace('name = "我的组合"', 'name = "我的组合"\nbogus_key = 1'),
  });
  const uf = await runCli(['status'], unknownField);
  assert.equal(uf.code, 2);
  assert.match(uf.stderr, /unknown_field/);

  // 2. holdings_missing_column → 2
  const missingColumn = makeProject(t, {
    holdings: 'symbol,account\nVTI,ibkr\n',
  });
  const mc = await runCli(['status'], missingColumn);
  assert.equal(mc.code, 2);
  assert.match(mc.stderr, /holdings_missing_column/);

  // 3. cash_required → 2（配置里没有 contribution.amount，也没给 --cash）
  const cashRequired = makeProject(t);
  const cr = await runCli(['plan'], cashRequired);
  assert.equal(cr.code, 2);
  assert.match(cr.stderr, /cash_required/);

  // 4. plan_not_found → 2
  const noPlan = makeProject(t);
  const np = await runCli(['check'], noPlan);
  assert.equal(np.code, 2);
  assert.match(np.stderr, /plan_not_found/);

  // 5. quote_not_found → 3
  const noQuote = makeProject(t, {
    toml: validToml({ quoteProvider: 'mock' }),
    mock: { quotes: { quotes: { usVTI: { price: 300 } } } },
  });
  const nq = await runCli(['status'], noQuote);
  assert.equal(nq.code, 3);
  assert.match(nq.stderr, /quote_not_found/);

  // 6. timeout → 3
  const hang = await fakeServer(() => ({ hang: true }));
  try {
    const timeout = makeProject(t, { toml: validToml({ quoteProvider: 'tencent', timeoutMs: 200, retries: 0 }) });
    const to = await runCli(['status'], timeout, { fetch: globalThis.fetch, env: { REBAL_QUOTE_URL: `${hang.url}/q=` } });
    assert.equal(to.code, 3);
    assert.match(to.stderr, /timeout/);
  } finally {
    await hang.close();
  }

  // 7. fx_not_found → 3
  const noFx = makeProject(t, {
    toml: validToml().replace('[fx.static]\nUSD = 7', '[fx.static]'),
  });
  const nf = await runCli(['status'], noFx);
  assert.equal(nf.code, 3);
  assert.match(nf.stderr, /fx_not_found/);

  // 8. no_actionable_orders → 4
  const tinyCash = makeProject(t);
  const nao = await runCli(['plan', '--cash', '1'], tinyCash);
  assert.equal(nao.code, 4);
  const naoJson = await runCli(['plan', '--cash', '1', '--json'], tinyCash);
  assert.equal(naoJson.code, 4);
  const naoPlan = JSON.parse(naoJson.stdout);
  assert.equal(naoPlan.code, 'no_actionable_orders');
  assert.deepEqual(naoPlan.orders, []);

  // 9. strict_failed → 4
  const strict = makeProject(t);
  const sf = await runCli(['status', '--strict'], strict);
  assert.equal(sf.code, 4);
  assert.match(sf.stderr, /strict_failed/);

  // 10. 内部错误 → 1，stderr 有 stack，错误日志里有 stack
  const broken = makeProject(t);
  const internal = await runCli(['status'], broken, {
    now: () => {
      throw new Error('注入的时钟故障');
    },
  });
  assert.equal(internal.code, 1);
  assert.match(internal.stderr, /internal_error/);
  assert.match(internal.stderr, /时钟故障/);
  assert.match(internal.stderr, /\n\s+at /, '内部错误要打印 stack');

  const logFile = path.join(broken.dir, '.rebal', 'last-error.log');
  assert.ok(fs.existsSync(logFile), '错误日志要写到 state 目录');
  const entries = fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const internalEntry = entries.find((entry) => entry.code === 'internal_error');
  assert.ok(internalEntry, '错误日志里要有这条内部错误');
  assert.match(internalEntry.stack, /时钟故障/);
});

test('T47 401 真实请求：stderr 与 --json 里都不出现密钥', async (t) => {
  const server = await fakeServer(() => ({ status: 401, body: 'unauthorized' }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent', retries: 0 }) });
    const env = { REBAL_QUOTE_URL: `${server.url}/q=?token=abc123&x=` };
    const human = await runCli(['status'], project, { fetch: globalThis.fetch, env });
    assert.equal(human.code, 3);
    assert.ok(!human.stderr.includes('abc123'), '人类可读错误里不能出现密钥');
    assert.ok(!human.stdout.includes('abc123'));

    const json = await runCli(['status', '--json'], project, { fetch: globalThis.fetch, env });
    assert.equal(json.code, 3);
    assert.ok(!json.stdout.includes('abc123'), '--json 里不能出现密钥');
    assert.match(json.stdout, /quote_http_error/);
  } finally {
    await server.close();
  }
});

test('T49 只有表头的持仓：status 正常、plan 按目标比例下单', async (t) => {
  const project = makeProject(t, { holdings: 'symbol,quantity,account,currency,price,name\n' });
  const status = await runCli(['status'], project);
  assert.equal(status.code, 0, status.stderr);
  assert.ok(status.stdout.includes('还没有持仓'));

  const statusJson = await runCli(['status', '--json'], project);
  assert.equal(JSON.parse(statusJson.stdout).totalBase, 0);

  const plan = await runCli(['plan', '--cash', '3000', '--json'], project);
  assert.equal(plan.code, 0, plan.stderr);
  const data = JSON.parse(plan.stdout);
  assert.ok(data.orders.length > 0, '空持仓也该按目标比例下单');
  assert.ok(data.orders.every((order) => order.side === 'buy'));
  assert.ok(data.orders.every((order) => order.valueBase > 0));
  const total = data.orders.reduce((sum, order) => sum + order.valueBase, 0);
  assert.ok(total <= 3000, '不能超出现金');
});

test('--verbose 把请求与耗时写到 stderr，且不泄露密钥；--quiet 只留错误', async (t) => {
  const server = await fakeServer(() => ({ status: 200, body: TENCENT_BODY }));
  try {
    const project = makeProject(t, { toml: validToml({ quoteProvider: 'tencent' }) });
    const env = { REBAL_QUOTE_URL: `${server.url}/q=?token=abc123&y=` };
    const verbose = await runCli(['status', '--verbose'], project, { fetch: globalThis.fetch, env });
    assert.equal(verbose.code, 0, verbose.stderr);
    assert.match(verbose.stderr, /\[info\] 请求完成 HTTP 200/);
    assert.match(verbose.stderr, /行情：请求 \d+ 次/);
    assert.ok(!verbose.stderr.includes('abc123'), '--verbose 也不能泄露密钥');

    const debug = await runCli(['status', '--verbose', '--json'], project, {
      fetch: globalThis.fetch,
      env,
      env2: undefined,
    });
    assert.ok(debug.stdout.startsWith('{'), 'JSON 模式 stdout 只有 JSON');
    assert.ok(!debug.stderr.includes('abc123'));

    const quiet = await runCli(['status', '--quiet'], project, { fetch: globalThis.fetch, env });
    assert.equal(quiet.code, 0);
    assert.ok(!quiet.stderr.includes('[info]'), '--quiet 不出 info');
  } finally {
    await server.close();
  }
});
