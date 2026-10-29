import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fakeServer, makeProject, readJson, runCli, validToml } from './helpers.js';

const ORDERS_BODY = [
  'v_usVTI="usVTI~VTI~VTI~300~299~300~";',
  'v_usBND="usBND~BND~BND~70~69~70~";',
  'v_sh510300="sh510300~沪深300ETF~510300~4~3.98~4~";',
].join('\n');

/** 跑一次 plan，返回计划文件内容。 */
async function makePlan(project, extra = []) {
  const result = await runCli(['plan', '--cash', '6000', ...extra], project);
  assert.equal(result.code, 0, `plan 失败：${result.stderr}`);
  const latest = readJson(path.join(project.dir, '.rebal', 'plans', 'latest.json'));
  return { result, plan: latest };
}

test('T41 计划写入失败：state 目录是普通文件 → 退出码 2、不留 .tmp、错误日志有记录', async (t) => {
  const project = makeProject(t);
  const stateDir = path.join(project.dir, '.rebal');
  fs.writeFileSync(stateDir, '我是文件，不是目录', 'utf8');

  const result = await runCli(['plan', '--cash', '6000'], project);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /state_dir_unwritable/);

  // 不留下任何临时文件
  const leftovers = fs.readdirSync(project.dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);

  // state 目录不可写 → 错误日志退到 tmpdir，并在 stderr 里说明
  const fallback = path.join(project.tmpDir, 'rebal-last-error.log');
  assert.ok(fs.existsSync(fallback), `兜底错误日志应存在：${fallback}`);
  const entries = fs
    .readFileSync(fallback, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(entries.at(-1).code, 'state_dir_unwritable');
  assert.match(result.stderr, /rebal-last-error\.log/);
});

test('T42 只保留最近 52 份计划，latest.json 指向最后一份', async (t) => {
  const project = makeProject(t);
  const plansDir = path.join(project.dir, '.rebal', 'plans');

  let lastId = null;
  for (let i = 0; i < 55; i += 1) {
    project.clock.advance(60_000);
    const { plan } = await makePlan(project);
    lastId = plan.planId;
  }

  const files = fs.readdirSync(plansDir).filter((name) => name !== 'latest.json');
  assert.equal(files.length, 52, `应该只剩 52 份计划，实际 ${files.length}`);
  const sorted = files.sort();
  assert.ok(!sorted.includes('2026-10-29T21-45-00-04-00.json'), '最早的一份应被删掉');
  const latest = readJson(path.join(plansDir, 'latest.json'));
  assert.equal(latest.planId, lastId);
  assert.ok(fs.existsSync(path.join(plansDir, `${lastId}.json`)));
});

test('T43 check 的五种状态与计划外变动；--strict 在非全完成时退出码 4', async (t) => {
  const project = makeProject(t);
  const plansDir = path.join(project.dir, '.rebal', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const plan = {
    schemaVersion: 1,
    planId: '2026-10-29T21-45-00-04-00',
    createdAt: '2026-10-29T21:45:00-04:00',
    toolVersion: '0.1.0',
    baseCurrency: 'CNY',
    cash: 0,
    policy: { allowSell: true, minTradeValue: 100, maxOrders: 20 },
    pricesAsOf: {},
    snapshot: [
      { symbol: 'AAA', quantity: 0, accounts: {} },
      { symbol: 'BBB', quantity: 0, accounts: {} },
      { symbol: 'CCC', quantity: 0, accounts: {} },
      { symbol: 'DDD', quantity: 0, accounts: {} },
      { symbol: 'EEE', quantity: 10, accounts: {} },
      { symbol: 'FFF', quantity: 0, accounts: {} },
    ],
    orders: [
      { symbol: 'AAA', side: 'buy', classId: 'a', quantity: 10, lotSize: 1, unitPrice: 1, currency: 'CNY', fxRate: 1, value: 10, valueBase: 10, feeBase: 0 },
      { symbol: 'BBB', side: 'buy', classId: 'b', quantity: 10, lotSize: 1, unitPrice: 1, currency: 'CNY', fxRate: 1, value: 10, valueBase: 10, feeBase: 0 },
      { symbol: 'CCC', side: 'buy', classId: 'c', quantity: 10, lotSize: 1, unitPrice: 1, currency: 'CNY', fxRate: 1, value: 10, valueBase: 10, feeBase: 0 },
      { symbol: 'DDD', side: 'buy', classId: 'd', quantity: 10, lotSize: 1, unitPrice: 1, currency: 'CNY', fxRate: 1, value: 10, valueBase: 10, feeBase: 0 },
      { symbol: 'EEE', side: 'sell', classId: 'e', quantity: 10, lotSize: 1, unitPrice: 1, currency: 'CNY', fxRate: 1, value: 10, valueBase: 10, feeBase: 0 },
    ],
    skipped: [],
    warnings: [],
    before: { totalBase: 10, classes: [] },
    after: { totalBase: 10, maxAbsDriftPp: 0, classes: [] },
    remainingCash: 0,
    feesTotal: 0,
  };
  fs.writeFileSync(path.join(plansDir, 'latest.json'), JSON.stringify(plan, null, 2), 'utf8');

  // done: AAA 买 10；partial: BBB 买 5；pending: CCC 没动（CSV 里没有这一行）；
  // reversed: EEE 本该卖 10 却买了 10；over: DDD 买 12；unplanned: FFF 买了 3
  fs.writeFileSync(
    path.join(project.dir, 'holdings.csv'),
    `symbol,quantity,account,currency,price,name
AAA,10,,,,
BBB,5,,,,
DDD,12,,,,
EEE,20,,,,
FFF,3,,,,
`,
    'utf8',
  );

  const result = await runCli(['check', '--json'], project);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const bySymbol = Object.fromEntries(report.items.map((i) => [i.symbol, i.status]));
  assert.deepEqual(bySymbol, {
    AAA: 'done',
    BBB: 'partial',
    CCC: 'pending',
    DDD: 'over',
    EEE: 'reversed',
  });
  assert.deepEqual(report.unplanned, [{ symbol: 'FFF', delta: 3 }]);
  assert.deepEqual(report.summary, {
    done: 1,
    partial: 1,
    pending: 1,
    over: 1,
    reversed: 1,
    unplanned: 1,
  });

  const strict = await runCli(['check', '--strict'], project);
  assert.equal(strict.code, 4);
  assert.match(strict.stderr, /strict_failed/);

  // 人类可读输出给出五种状态的中文词
  const readable = await runCli(['check'], project);
  for (const word of ['完成', '部分', '未执行', '超量', '反向', '计划外变动']) {
    assert.ok(readable.stdout.includes(word), `输出里应有"${word}"`);
  }
});

test('T44 非法 planId（路径穿越）→ plan_not_found；损坏的 plan → plan_corrupt', async (t) => {
  const project = makeProject(t);
  const traversal = await runCli(['check', '--plan', '../../etc/passwd'], project);
  assert.equal(traversal.code, 2);
  assert.match(traversal.stderr, /plan_not_found/);

  const plansDir = path.join(project.dir, '.rebal', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'latest.json'), '{ 坏掉的 JSON', 'utf8');
  const corrupt = await runCli(['check'], project);
  assert.equal(corrupt.code, 2);
  assert.match(corrupt.stderr, /plan_corrupt/);

  // 缺字段也算损坏
  fs.writeFileSync(path.join(plansDir, 'latest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf8');
  const missing = await runCli(['check'], project);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /plan_corrupt/);
});

test('T48 同一秒两次 plan → planId 加 -2，两份都在；子进程重启后缓存仍可用', async (t) => {
  const project = makeProject(t);
  const first = await makePlan(project);
  const second = await makePlan(project);
  assert.equal(second.plan.planId, `${first.plan.planId}-2`);
  const plansDir = path.join(project.dir, '.rebal', 'plans');
  assert.ok(fs.existsSync(path.join(plansDir, `${first.plan.planId}.json`)));
  assert.ok(fs.existsSync(path.join(plansDir, `${second.plan.planId}.json`)));
  assert.equal(readJson(path.join(plansDir, 'latest.json')).planId, second.plan.planId);

  // 子进程 1：联网取价写缓存；子进程 2：--offline 必须零请求
  const server = await fakeServer(() => ({ status: 200, body: ORDERS_BODY }));
  const project2 = makeProject(t);
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'rebal.js');
  const runChild = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: project2.dir,
        env: {
          PATH: process.env.PATH ?? '',
          REBAL_QUOTE_URL: `${server.url}/q=`,
          ...project2.env,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  try {
    // 先把配置换成 tencent provider
    fs.writeFileSync(
      path.join(project2.dir, 'rebal.toml'),
      validToml({ quoteProvider: 'tencent' }),
      'utf8',
    );
    const online = await runChild(['status']);
    assert.equal(online.code, 0, online.stderr);
    assert.equal(server.requests.length, 1);

    const offline = await runChild(['status', '--offline']);
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(server.requests.length, 1, '新进程应命中磁盘缓存');
  } finally {
    await server.close();
  }
});
