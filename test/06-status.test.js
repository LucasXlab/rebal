import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { makeProject, runCli, validToml } from './helpers.js';
import { paintStatus } from '../src/format/table.js';

const TENCENT_BODY = [
  'v_usVTI="usVTI~VTI~VTI~300~299~300~";',
  'v_usBND="usBND~BND~BND~70~69~70~";',
  'v_sh510300="sh510300~沪深300ETF~510300~4~3.98~4~";',
].join('\n');

test('T28 多币种估值：USD 按 7.0 折算，总市值与占比与手算一致', async (t) => {
  const project = makeProject(t);
  const result = await runCli(['status', '--json'], project);
  assert.equal(result.code, 0);
  const data = JSON.parse(result.stdout);
  // VTI 10×300×7 = 21000；BND 50×70×7 = 24500；510300 1000×4 = 4000
  assert.equal(data.totalBase, 49500);
  assert.equal(data.baseCurrency, 'CNY');
  const byId = Object.fromEntries(data.classes.map((c) => [c.classId, c]));
  assert.equal(byId.us_equity.valueBase, 21000);
  assert.equal(byId.cn_equity.valueBase, 4000);
  assert.equal(byId.bond.valueBase, 24500);
  assert.ok(Math.abs(byId.us_equity.actualRatio - 0.4242) < 0.001);
  assert.ok(Math.abs(byId.cn_equity.actualRatio - 0.0808) < 0.001);
  assert.ok(Math.abs(byId.bond.actualRatio - 0.4949) < 0.001);
});

test('T29 偏离与 outOfBand：必须严格大于带宽才算越界（等于不算）', async (t) => {
  // 构造"偏离正好等于带宽"：T = 66×490 + 16415×4 = 98000，
  // bond 市值 32340，目标 30% = 29400 → 偏离 2940，带宽 3% × 98000 = 2940（完全相等）
  const holdings = `symbol,quantity,account,currency,price,name
BND,66,ibkr,,,
510300,16415,futu,,,
`;
  const exact = makeProject(t, { holdings, toml: validToml({ band: 0.03 }) });
  const result = await runCli(['status', '--json'], exact);
  const data = JSON.parse(result.stdout);
  const bond = data.classes.find((c) => c.classId === 'bond');
  assert.ok(Math.abs(Math.abs(bond.driftPp) - 3.0) < 0.01, `偏离应约 3.0pp，实际 ${bond.driftPp}`);
  assert.equal(bond.outOfBand, false, '等于带宽不算越界');

  // 稍微再多一点就必须算越界
  const over = makeProject(t, {
    holdings: holdings.replace('BND,66,', 'BND,67,'),
    toml: validToml({ band: 0.03 }),
  });
  const overData = JSON.parse((await runCli(['status', '--json'], over)).stdout);
  assert.equal(overData.classes.find((c) => c.classId === 'bond').outOfBand, true);
});

test('T30 status --strict：越界退出码 4，全部在带内退出码 0', async (t) => {
  const outOfBand = makeProject(t);
  const strictFail = await runCli(['status', '--strict'], outOfBand);
  assert.equal(strictFail.code, 4);
  assert.match(strictFail.stderr, /strict_failed/);

  // 配平组合：T = 29400，us 14700 / bond 8820 / cn 5880，偏离全 0
  const balanced = makeProject(t, {
    holdings: `symbol,quantity,account,currency,price,name
VTI,7,ibkr,,,
BND,18,ibkr,,,
510300,1470,futu,,,
`,
  });
  const ok = await runCli(['status', '--strict'], balanced);
  assert.equal(ok.code, 0);
});

test('T31 status --json 字段集合与 SPEC 4.3 一致', async (t) => {
  const project = makeProject(t, {
    toml: validToml({ quoteProvider: 'tencent', fxProvider: 'static' }),
    env: { REBAL_QUOTE_URL: 'http://127.0.0.1:9/q=' },
  });
  const result = await runCli(['status', '--json'], project, {
    fetch: async () => new Response(TENCENT_BODY, { status: 200 }),
  });
  assert.equal(result.code, 0);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(data).sort(), [
    'accounts',
    'baseCurrency',
    'classes',
    'fx',
    'quotes',
    'schemaVersion',
    'totalBase',
    'warnings',
  ]);
  assert.deepEqual(Object.keys(data.classes[0]).sort(), [
    'actualRatio',
    'band',
    'classId',
    'driftBase',
    'driftPp',
    'outOfBand',
    'targetBase',
    'targetWeight',
    'valueBase',
  ]);
  assert.deepEqual(Object.keys(data.quotes[0]).sort(), [
    'currency',
    'fetchedAt',
    'price',
    'source',
    'stale',
    'symbol',
  ]);
  assert.deepEqual(Object.keys(data.fx[0]).sort(), ['currency', 'fetchedAt', 'rateToBase', 'source', 'stale']);
  assert.equal(data.quotes[0].stale, false);
  assert.equal(data.quotes[0].source, 'tencent');
  assert.deepEqual(Object.keys(data.accounts[0]).sort(), ['account', 'ratio', 'valueBase']);
  assert.ok(Array.isArray(data.warnings));
});

test('T32 账户汇总：同账户多符号求和；账户为空记为 default', async (t) => {
  const holdings = `symbol,quantity,account,currency,price,name
VTI,10,ibkr,,,
BND,50,ibkr,,,
510300,1000,,,,
`;
  const project = makeProject(t, { holdings });
  const result = await runCli(['status', '--json'], project);
  const data = JSON.parse(result.stdout);
  const byAccount = Object.fromEntries(data.accounts.map((a) => [a.account, a.valueBase]));
  assert.equal(byAccount.ibkr, 45500, 'ibkr = 21000 + 24500');
  assert.equal(byAccount.default, 4000, '空账户记为 default');
  const sum = data.accounts.reduce((acc, a) => acc + a.valueBase, 0);
  assert.equal(sum, data.totalBase);

  // 人类可读输出里账户按市值倒序
  const readable = await runCli(['status'], project);
  const ibkrLine = readable.stdout.split('\n').findIndex((line) => line.startsWith('ibkr'));
  const defaultLine = readable.stdout.split('\n').findIndex((line) => line.startsWith('default'));
  assert.ok(ibkrLine > 0 && defaultLine > ibkrLine, '市值大的账户在前');
  assert.ok(path.isAbsolute(project.dir));
});

test('paintStatus 覆盖 DESIGN 词表每一个词：正常/新/完成=绿，缓存/部分/未执行=黄，越界/超量/反向=红', () => {
  const seen = { ok: [], warn: [], bad: [], none: [] };
  const color = (token, text) => {
    seen[token].push(text);
    return text;
  };
  const ok = ['正常', '新', '完成'];
  const warn = ['缓存', '部分', '未执行'];
  const bad = ['越界', '超量', '反向'];
  for (const word of ok) {
    seen.ok.length = 0;
    paintStatus(word, color);
    assert.deepEqual(seen.ok, [word], `${word} 应该是 ok 色`);
  }
  for (const word of warn) {
    seen.warn.length = 0;
    paintStatus(word, color);
    assert.deepEqual(seen.warn, [word], `${word} 应该是 warn 色`);
  }
  for (const word of bad) {
    seen.bad.length = 0;
    paintStatus(word, color);
    assert.deepEqual(seen.bad, [word], `${word} 应该是 bad 色`);
  }
  // 词表外的词不上色，也不会崩
  assert.equal(paintStatus('未知词', color), '未知词');
});
