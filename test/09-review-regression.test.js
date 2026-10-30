/**
 * 阶段 4 复审补的回归测试（T50–T55）。
 *
 * 每一条都对应一次真实复现过的缺陷，不是"为了覆盖率"补的：
 * 先把 SPEC/DESIGN 的原文和被违反的那一行写在注释里，再断言修好之后的行为。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeProject, runCli, validToml } from './helpers.js';

test('T50 SPEC §4.7：rebal help <命令> 给出该命令的参数与退出码，未知命令退出码 2', async (t) => {
  const project = makeProject(t);

  const specific = await runCli(['help', 'plan'], project);
  assert.equal(specific.code, 0, specific.stderr);
  assert.match(specific.stdout, /--cash/, 'help plan 要列出 plan 自己的参数');
  assert.match(specific.stdout, /退出码/, 'help plan 要给出退出码');
  assert.ok(!specific.stdout.includes('rebal init'), 'help plan 不该把总览整个打出来');

  // 每个命令都要有一条能看的说明，不能有命令的 help 是空的
  for (const command of ['init', 'status', 'plan', 'check', 'prices', 'version', 'help']) {
    const one = await runCli(['help', command], project);
    assert.equal(one.code, 0, `${command}: ${one.stderr}`);
    assert.ok(one.stdout.trim().length > 0, `${command} 的 help 不能是空字符串`);
    assert.ok(one.stdout.includes(`rebal ${command}`), `${command} 的 help 第一行要自报命令名`);
  }

  // 总览仍然是总览
  const overview = await runCli(['help'], project);
  assert.equal(overview.code, 0);
  assert.match(overview.stdout, /通用参数/);

  const unknown = await runCli(['help', 'nope'], project);
  assert.equal(unknown.code, 2, '未知命令名必须退出码 2');
  assert.match(unknown.stderr, /没有 nope 这个命令/);

  // `--dir` 的值不能被当成命令名（以前会报"help 一次只能看一个命令：plan /tmp/xxx"）
  const withDir = await runCli(['help', 'plan', '--dir', project.dir], project);
  assert.equal(withDir.code, 0, withDir.stderr);
  assert.match(withDir.stdout, /--cash/);
});

test('T51 SPEC §4.6：prices 必须有「状态」列，且 新/缓存 两个词都按 TTL 判定', async (t) => {
  // 行情与汇率都要走 mock，才能比较两者的过期判定是否同口径
  const project = makeProject(t, { toml: validToml({ fxProvider: 'mock' }) });

  // mock 数据的时间固定为 2026-01-01，时钟是 2026-10-29 → 超过 TTL，全部应是"缓存"
  const stale = await runCli(['prices'], project);
  assert.equal(stale.code, 0, stale.stderr);
  assert.match(stale.stdout, /状态/, 'SPEC §4.6 的表格里有一列「状态」');
  assert.match(stale.stdout, /示例数据/, '来源列只写来源，不该把"（缓存）"拼进去');
  assert.ok(!stale.stdout.includes('（缓存）'), '缓存是独立的「状态」列，不拼在来源后面');
  assert.match(stale.stdout, /缓存/, '超过 TTL 必须是"缓存"');

  // 同一份示例数据里行情与汇率的状态词必须一致（以前汇率硬写 stale:false 会显示"新"）
  const quoteBlock = stale.stdout.split('\n\n')[0];
  const fxBlock = stale.stdout.split('\n\n').slice(1).join('\n\n');
  assert.ok(quoteBlock.includes('缓存'), '行情块应为缓存');
  assert.ok(fxBlock.includes('缓存'), '汇率块也应为缓存：同一份 fixed 时间戳，不能一个过度一个不过期');

  // 把时钟拨到 mock 数据时间附近（±1 小时，TTL 720 分钟）→ 同样两行都变成"新"。
  // 这同时验证了"新/缓存"确实是按 now - fetchedAt 与 TTL 比出来的，而不是来源写死的。
  const freshProject = { ...project, env: project.env };
  const fresh = await runCli(['prices'], freshProject, {
    now: () => Date.parse('2026-01-01T01:00:00+00:00'),
  });
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.match(fresh.stdout, /新/, 'TTL 内应显示"新"');
  assert.ok(!fresh.stdout.includes('缓存'), 'TTL 内不该出现"缓存"');
});

test('T52 执行后偏离用类别名，与表格「类别」列一致；没有 name 时回退 ID', async (t) => {
  const toml = validToml().replace(
    '[classes.us_equity]\npreferred_symbol = "VTI"',
    '[classes.us_equity]\nname = "美股"\npreferred_symbol = "VTI"',
  );
  const project = makeProject(t, { toml });

  const result = await runCli(['plan', '--cash', '6000', '--no-save'], project);
  assert.equal(result.code, 0, result.stderr);

  const afterLine = result.stdout.split('\n').find((line) => line.startsWith('执行后'));
  assert.ok(afterLine, 'plan 输出里要有「执行后」那一行');
  assert.match(afterLine, /美股/, '有 name 时用类别名');
  assert.ok(!afterLine.includes('us_equity'), '有 name 时不该再出现类别 ID');
  // 没有 name 的类别回退成 ID，不会变成空白
  assert.match(afterLine, /cn_equity/, '没写 name 的类别回退显示 ID');
});

test('T53 DESIGN §2.2：空值显示 — ；整列都是空值时整列不显示', async (t) => {
  // 三个资产都不写 name → 「名称」列整列都空，应整列消失（而不是留一整列空白）
  const toml = validToml().replace(/\nname = "Vanguard Total Stock Market ETF"/g, '')
    .replace(/\nname = "沪深300ETF"/g, '')
    .replace(/\nname = "Vanguard Total Bond Market ETF"/g, '');
  const project = makeProject(t, { toml });

  const plan = await runCli(['plan', '--cash', '6000', '--no-save'], project);
  assert.equal(plan.code, 0, plan.stderr);
  const headerLine = plan.stdout.split('\n').find((line) => line.includes('方向') && line.includes('代码'));
  assert.ok(headerLine, '要有表头');
  assert.ok(!headerLine.includes('名称'), '全是空值的「名称」列应整列不显示');

  // 只有一部分资产有 name → 列保留，缺的那个显示 —（不是空白）
  const partialToml = toml.replace(
    '[assets.VTI]\nclass = "us_equity"',
    '[assets.VTI]\nclass = "us_equity"\nname = "全市场ETF"',
  );
  const partialProject = makeProject(t, { toml: partialToml });
  const partial = await runCli(['plan', '--cash', '6000', '--no-save'], partialProject);
  assert.equal(partial.code, 0, partial.stderr);
  const partialHeader = partial.stdout.split('\n').find((line) => line.includes('方向') && line.includes('代码'));
  assert.ok(partialHeader.includes('名称'), '有资产写了 name 时这一列要保留');
  const buyRows = partial.stdout.split('\n').filter((line) => line.startsWith('买入'));
  assert.ok(buyRows.length > 0);
  assert.ok(buyRows.some((row) => row.includes('—')), '没有 name 的资产显示 — 而不是空白');
});

test('T54 SPEC §3.6：计划文件与 --json 的 orders 只含契约字段（不泄漏 classLabel）', async (t) => {
  const project = makeProject(t);
  const result = await runCli(['plan', '--cash', '6000'], project);
  assert.equal(result.code, 0, result.stderr);

  const planFiles = fs.readdirSync(path.join(project.dir, '.rebal', 'plans'))
    .filter((name) => name !== 'latest.json');
  assert.equal(planFiles.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(project.dir, '.rebal', 'plans', planFiles[0]), 'utf8'));
  for (const order of saved.orders) {
    assert.deepEqual(Object.keys(order).sort(), [
      'classId', 'currency', 'feeBase', 'fxRate', 'lotSize', 'quantity',
      'side', 'symbol', 'unitPrice', 'value', 'valueBase',
    ], '计划文件里的订单字段必须与 SPEC §3.6 一致');
  }

  // --no-save 走的是另一条分支（直接序列化 allocate 的结果），同样不能泄漏
  const json = await runCli(['plan', '--cash', '6000', '--no-save', '--json'], project);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.ok(payload.orders.length > 0);
  assert.equal(payload.orders[0].classLabel, undefined, '--json 也不能带 classLabel');
});

test('T55 `--cash -100` 给出中文写法提示，而不是英文的 parseArgs 报错', async (t) => {
  const project = makeProject(t);

  const spaced = await runCli(['plan', '--cash', '-100'], project);
  assert.equal(spaced.code, 2, '负数金额是输入错误');
  assert.match(spaced.stderr, /--cash/, '要说清是哪个参数');
  assert.match(spaced.stderr, /--cash=-100/, '要给出能直接抄的写法');
  assert.ok(!/ambiguous|Unexpected argument|Unknown option/i.test(spaced.stderr), '不能把英文原文甩给用户');

  // 等号写法走到真正的取值范围校验
  const equals = await runCli(['plan', '--cash=-100'], project);
  assert.equal(equals.code, 2);
  assert.match(equals.stderr, /invalid_input/);
  assert.match(equals.stderr, /0–1e9/);
});

test('T56 配置与 CSV 里的 ANSI 转义不能进终端（清屏/隐藏文字/挤歪表格）', async (t) => {
  // 1) 配置里的名称：入口就拒绝，而不是偷偷改内容
  const evilToml = validToml().replace(
    'name = "Vanguard Total Stock Market ETF"',
    'name = "safe\\u001b[2JHACKED"',
  );
  const evilProject = makeProject(t, { toml: evilToml });
  const rejected = await runCli(['plan', '--cash', '6000', '--no-save'], evilProject);
  assert.equal(rejected.code, 2, '带控制字符的名称应报配置错误');
  assert.match(rejected.stderr, /config_invalid/);
  assert.ok(!rejected.stdout.includes('\u001b[2J'), 'stdout 里不能出现清屏序列');

  // 2) holdings.csv 的 account / name：同样在入口拒绝
  const evilCsv = 'symbol,quantity,account,currency,price,name\nVTI,10,ib\u001b[2Jkr,,,\nBND,50,ibkr,,,\n510300,1000,futu,,,\n';
  const evilHoldings = makeProject(t, { holdings: evilCsv });
  const csvRejected = await runCli(['status'], evilHoldings);
  assert.equal(csvRejected.code, 2);
  assert.match(csvRejected.stderr, /holdings_invalid/);
  assert.match(csvRejected.stderr, /account/);

  // 3) 正常名称仍然照常显示（别把校验做成"一律拒绝"）
  const ok = makeProject(t);
  const normal = await runCli(['plan', '--cash', '6000', '--no-save'], ok);
  assert.equal(normal.code, 0, normal.stderr);
  assert.match(normal.stdout, /Vanguard Total Stock Market/);
});

test('T57 stripControl：剥掉清屏/隐藏/OSC，保留换行与制表符', async () => {
  const { stripControl, hasControlChar } = await import('../src/util.js');
  assert.equal(stripControl('a\u001b[2Jb'), 'ab');
  assert.equal(stripControl('a\u001b[31m红\u001b[0m'), 'a红');
  assert.equal(stripControl('\u001b]0;标题\u0007x'), 'x');
  assert.equal(stripControl('正常\t制表'), '正常\t制表');
  assert.equal(stripControl('保留\n换行'), '保留\n换行');
  assert.equal(hasControlChar('普通文本'), false);
  assert.equal(hasControlChar('带\u001b[2J转义'), true);
});
