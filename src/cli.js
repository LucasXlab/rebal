/**
 * 命令行入口：参数解析 → 命令分发 → 输出 → 退出码（SPEC §4）。
 *
 * 所有 IO 都从 `app` 取（env/now/sleep/fetch/stdout/stderr），测试可以完全注入。
 * 这里不调用 process.exit：run() 返回退出码，bin/rebal.js 负责赋值。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { asRebalError, EXIT, RebalError } from './errors.js';
import { loadBasics, loadPrices } from './load.js';
import { allocate } from './allocate.js';
import { buildPlan, comparePlan, loadPlan, nextPlanId, savePlan, toPlanOrders } from './plan.js';
import { layoutFor, makeColor, renderTable } from './format/table.js';
import { renderPrices, renderStatus } from './format/status.js';
import { sourceLabel } from './format/status.js';
import {
  formatDrift,
  formatLocalDateTime,
  formatMoney,
  formatPrice,
  groupInteger,
  roundHalfUp,
  stripControl,
  truncateWidth,
} from './util.js';
import { DEMO_HOLDINGS, DEMO_TOML, TEMPLATE_HOLDINGS, TEMPLATE_TOML } from './templates.js';
import { appendErrorLog } from './error-log.js';
import { TOOL_VERSION } from './version.js';

export const HELP = `配平 rebal ${TOOL_VERSION} — 把"这个月这笔钱该买什么"变成一张能照着下单的清单

用法：
  rebal init [--demo] [--force]         生成配置与持仓模板（--demo 用示例数据，可离线）
  rebal status [--strict]               当前各类资产比例、偏离、是否越界
  rebal plan [--cash <金额>] [--sell]   这笔钱怎么买：订单清单 + 执行后偏离
  rebal check [--plan <id|latest>]      上期计划执行了没有
  rebal prices [--refresh]              看这次用到的价格与汇率从哪来
  rebal version
  rebal help

通用参数：
  --dir <目录>        工作目录（默认当前目录）：找 rebal.toml、holdings.csv、.rebal/
  --config <文件>     指定配置文件（默认 <dir>/rebal.toml）
  --holdings <文件>   指定持仓文件（默认取配置里的 holdings.path）
  --state-dir <目录>  指定状态目录（默认 <dir>/.rebal）
  --json              输出机器可读 JSON
  --offline           只用缓存里的价格，不联网
  --color <模式>      auto（默认）| always | never
  --verbose           打印请求与耗时
  --quiet             不打印警告与提示

退出码：0 成功；1 内部错误；2 配置/参数/输入错误；3 外部依赖失败；4 没有可执行结果。
`;

/** 全局参数。 */
const GLOBAL_OPTIONS = {
  dir: { type: 'string' },
  config: { type: 'string' },
  holdings: { type: 'string' },
  'state-dir': { type: 'string' },
  json: { type: 'boolean' },
  offline: { type: 'boolean' },
  color: { type: 'string' },
  verbose: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/** 每个命令自己的参数。 */
const COMMAND_OPTIONS = {
  init: { demo: { type: 'boolean' }, force: { type: 'boolean' } },
  status: { strict: { type: 'boolean' } },
  plan: {
    cash: { type: 'string' },
    sell: { type: 'boolean' },
    'no-sell': { type: 'boolean' },
    'no-save': { type: 'boolean' },
  },
  check: { plan: { type: 'string' }, strict: { type: 'boolean' } },
  prices: { refresh: { type: 'boolean' } },
  version: {},
  help: {},
};

const COMMANDS = Object.keys(COMMAND_OPTIONS);

/**
 * 单个命令的说明（`rebal help <命令>`，SPEC §4.7 要求给出该命令的参数与退出码）。
 * 只写这一条命令需要知道的东西；通用参数与退出码总表由 `rebal help` 给。
 */
const COMMAND_HELP = {
  init: `rebal init — 生成一份能跑的配置与持仓模板

用法：rebal init [--demo] [--force] [--dir <目录>]

参数：
  --demo       写入示例持仓，行情与汇率都用内置示例数据（不需要联网）
  --force      覆盖已存在的 rebal.toml / holdings.csv
  --dir <目录> 写到哪个目录（默认当前目录，不存在会自动创建）

生成：rebal.toml、holdings.csv

退出码：0 成功；2 文件已存在（config_exists）、目录不可写（init_dir_unwritable）
下一步：rebal status`,
  status: `rebal status — 当前各类资产的比例、偏离与是否越界

用法：rebal status [--strict] [--json]

参数：
  --strict     有任一类别越界时退出码 4（适合放进定时任务做告警）
  --json       输出机器可读 JSON

退出码：0 正常；2 配置/持仓错误；3 取不到行情或汇率；4 --strict 且越界`,
  plan: `rebal plan — 这笔钱怎么买：订单清单 + 执行后偏离

用法：rebal plan [--cash <金额>] [--sell | --no-sell] [--no-save] [--json]

参数：
  --cash <金额>  本次投入多少钱（本币，≥0，≤1e9）。不给就用配置里的 contribution.amount
  --sell         本次允许卖出超配的类别（覆盖 policy.allow_sell）
  --no-sell      本次禁止卖出（覆盖 policy.allow_sell = true）
  --no-save      不写计划文件，也不清理旧计划
  --json         输出完整的 Plan 对象

退出码：0 有订单（并写计划）；2 参数/配置错误、没给金额也没有 contribution.amount；
        3 取不到行情或汇率；4 没有可执行的下单（no_actionable_orders）
下一步：照着下单，然后更新 holdings.csv，再 rebal check`,
  check: `rebal check — 上期计划执行了没有

用法：rebal check [--plan <planId|latest>] [--strict] [--json]

参数：
  --plan <id>   核对哪一份计划（默认 latest）
  --strict      有订单不是"完成"时退出码 4
  --json        输出机器可读 JSON

退出码：0 核对完成；2 计划不存在（plan_not_found）或损坏（plan_corrupt）；
        4 --strict 且未全部完成`,
  prices: `rebal prices — 这次用到的价格与汇率从哪来

用法：rebal prices [--refresh] [--offline] [--json]

参数：
  --refresh     忽略缓存 TTL，重新取一次
  --offline     只用缓存，不联网（与 --refresh 互斥）
  --json        输出机器可读 JSON

退出码：0 正常；2 参数矛盾；3 取不到行情或汇率`,
  version: `rebal version — 打印版本号

用法：rebal version [--json]`,
  help: `rebal help — 用法总览，或某个命令的说明

用法：rebal help [命令]
  rebal help          全部命令与通用参数
  rebal help plan     只看 plan 的参数与退出码`,
};

/**
 * @typedef {object} App
 * @property {NodeJS.ProcessEnv} env
 * @property {string} cwd
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {typeof fetch} fetch
 * @property {(text: string) => void} stdout
 * @property {(text: string) => void} stderr
 * @property {boolean} isTty
 * @property {number|undefined} columns
 * @property {boolean} noColor
 * @property {'auto'|'always'|'never'} colorMode
 * @property {string} tmpDir 错误日志的兜底目录（默认 os.tmpdir()）
 */

/**
 * @param {Partial<App>} overrides
 * @returns {App}
 */
export function createApp(overrides = {}) {
  const env = overrides.env ?? process.env;
  return {
    env,
    cwd: overrides.cwd ?? process.cwd(),
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    fetch: overrides.fetch ?? globalThis.fetch,
    stdout: overrides.stdout ?? ((text) => process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text) => process.stderr.write(text)),
    isTty: overrides.isTty ?? Boolean(process.stdout.isTTY),
    columns: overrides.columns,
    noColor: overrides.noColor ?? env.NO_COLOR !== undefined,
    colorMode: overrides.colorMode ?? 'auto',
    tmpDir: overrides.tmpDir ?? os.tmpdir(),
  };
}

/**
 * 跑一次命令，返回退出码。
 * @param {string[]} argv 不含 node 与脚本名
 * @param {Partial<App>} overrides
 * @returns {Promise<number>}
 */
export async function run(argv, overrides = {}) {
  const app = createApp(overrides);
  const wantsJson = argv.includes('--json');
  try {
    const { command, values, positionals } = parseCommandLine(argv);
    if (values.color !== undefined && !['auto', 'always', 'never'].includes(values.color)) {
      throw new RebalError('usage', `--color 只能是 auto/always/never，当前是 ${values.color}`);
    }
    if (values.color !== undefined) app.colorMode = values.color;

    const ctx = {
      app,
      values,
      positionals,
      dir: values.dir,
      config: values.config,
      holdings: values.holdings,
      stateDir: values['state-dir'],
      json: Boolean(values.json),
      quiet: Boolean(values.quiet),
      offline: Boolean(values.offline),
      logLevel: values.verbose ? 'info' : values.quiet ? 'error' : undefined,
    };

    if (values.help && command !== 'help') {
      app.stdout(HELP);
      return EXIT.OK;
    }

    switch (command) {
      case 'version':
        return commandVersion(ctx);
      case 'help': {
        const topic = ctx.positionals[0];
        if (!topic) {
          app.stdout(HELP);
          return EXIT.OK;
        }
        if (!COMMANDS.includes(topic)) {
          throw new RebalError('usage', `没有 ${topic} 这个命令`, {
            issues: [{ path: topic, message: `可用命令：${COMMANDS.join('、')}` }],
          });
        }
        app.stdout(`${COMMAND_HELP[topic]}\n`);
        return EXIT.OK;
      }
      case 'init':
        return commandInit(ctx);
      case 'status':
        return await commandStatus(ctx);
      case 'plan':
        return await commandPlan(ctx);
      case 'check':
        return await commandCheck(ctx);
      case 'prices':
        return await commandPrices(ctx);
      default:
        throw new RebalError('usage', `未知命令：${command}`, {
          issues: [{ path: command, message: `可用命令：${COMMANDS.join('、')}` }],
        });
    }
  } catch (err) {
    return reportError(app, asRebalError(err), wantsJson, argv);
  }
}

/**
 * @param {string[]} argv
 */
/**
 * 把 `node:util` parseArgs 的英文报错翻成"中文 + 正确写法"。
 * 这是新人最常撞的一类错（`plan 6000`、`--cas`、`help plan`），英文报错会让人以为工具没做完。
 * @param {unknown} err
 * @param {string} command
 * @returns {RebalError}
 */
function translateParseArgsError(err, command) {
  const raw = err instanceof Error ? err.message : String(err);
  const usage = { path: '命令行', message: `运行 rebal help 看用法` };
  const unexpectedArg = /^Unexpected argument '(.+?)'/.exec(raw);
  if (unexpectedArg) {
    const arg = unexpectedArg[1];
    // 位置参数误用：多给了个值
    const hint =
      command === 'plan'
        ? `金额要用 --cash 传：rebal plan --cash ${arg}`
        : `请改用参数：rebal help ${command} 看这个命令支持哪些参数`;
    return new RebalError('usage', `多了一个参数：${arg}`, {
      issues: [{ path: arg, message: hint }],
    });
  }
  const unknownOption = /^Unknown option '(.+?)'/.exec(raw);
  if (unknownOption) {
    const option = unknownOption[1];
    const suggestion = suggestOption(option);
    return new RebalError(
      'usage',
      `没有 ${option} 这个参数${suggestion ? `，你是不是想写 --${suggestion}？` : ''}`,
      { issues: [] },
    );
  }
  // `--cash -100`：parseArgs 把 -100 当成另一个选项，报 "argument is ambiguous"。
  // 这是负数金额最常见的写法，直接告诉用户写成 --cash=-100 就行。
  const ambiguous = /Option '(--?[^']+)' argument is ambiguous/.exec(raw);
  if (ambiguous) {
    const option = ambiguous[1];
    return new RebalError('usage', `${option} 的值不能以 - 开头（会被当成另一个参数）`, {
      issues: [{ path: option, message: `写成 ${option}=-100；金额必须是 0–1e9 的数字` }],
    });
  }
  return new RebalError('usage', `命令行参数不认识：${raw}`, { issues: [usage] });
}

/**
 * 为拼错的参数找最接近的写法（编辑距离 ≤ 2 视为拼写错误）。
 * @param {string} option
 * @returns {string|null}
 */
function suggestOption(option) {
  const known = Object.keys({ ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS.plan ?? {}) });
  const bare = option.replace(/^-+/, '');
  let best = null;
  let bestDistance = 3;
  for (const candidate of known) {
    const d = editDistance(bare, candidate.replace(/^-+/, ''));
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function parseCommandLine(argv) {
  const positionals = argv.filter((arg) => !arg.startsWith('-'));
  const command = positionals[0] ?? 'help';
  // `rebal help plan` 的 "plan" 是参数而不是多余的位置参数（SPEC §4.7）。
  // help 只认全局选项，所以这里用 allowPositionals 再解析一次，好把
  // `rebal help --dir /x plan` 里的 /x 正确当成 --dir 的值而不是命令名。
  if (command === 'help') {
    const rest = argv.filter((arg) => arg !== command);
    let helpParsed;
    try {
      helpParsed = parseArgs({
        args: rest,
        options: GLOBAL_OPTIONS,
        allowPositionals: true,
        strict: true,
      });
    } catch (err) {
      throw translateParseArgsError(err, 'help');
    }
    const topics = helpParsed.positionals;
    if (topics.length > 1) {
      throw new RebalError('usage', `help 一次只能看一个命令：${topics.join(' ')}`, {
        issues: [{ path: 'help', message: '例如：rebal help plan' }],
      });
    }
    return { command, values: helpParsed.values, positionals: topics };
  }
  if (!COMMANDS.includes(command)) {
    const looksLikeFlag = positionals.length === 0 && argv.length > 0;
    throw new RebalError('usage', looksLikeFlag ? `缺少命令` : `未知命令：${command}`, {
      issues: [
        {
          path: command,
          message: `可用命令：${COMMANDS.join('、')}；运行 rebal help 看用法`,
        },
      ],
    });
  }
  const rest = argv.filter((arg) => arg !== command);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command] },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    // parseArgs 的报错是英文原文（"Unexpected argument '6000'."），不能直接甩给用户。
    // 把这几种最高频的误用翻成中文并给出正确写法。
    throw translateParseArgsError(err, command);
  }
  return { command, values: parsed.values, positionals: positionals.slice(1) };
}

// ---------------- 命令 ----------------

function commandVersion(ctx) {
  if (ctx.json) {
    ctx.app.stdout(`${JSON.stringify({ name: 'rebal', version: TOOL_VERSION, node: process.version })}\n`);
  } else {
    ctx.app.stdout(`rebal ${TOOL_VERSION}\n`);
  }
  return EXIT.OK;
}

function commandInit(ctx) {
  const { app, values } = ctx;
  const dir = path.resolve(app.cwd, ctx.dir ?? '.');
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
    throw new RebalError('invalid_input', `--dir 指向的是一个文件：${dir}`);
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new RebalError('init_dir_unwritable', `建不了目录：${dir}`, {
      issues: [{ path: dir, message: err instanceof Error ? err.message : String(err) }],
    });
  }

  const targets = [
    { file: path.join(dir, 'rebal.toml'), content: values.demo ? DEMO_TOML : TEMPLATE_TOML },
    { file: path.join(dir, 'holdings.csv'), content: values.demo ? DEMO_HOLDINGS : TEMPLATE_HOLDINGS },
  ];
  if (!values.force) {
    const conflicts = targets.filter((t) => fs.existsSync(t.file)).map((t) => path.basename(t.file));
    if (conflicts.length > 0) {
      throw new RebalError('config_exists', `这些文件已存在：${conflicts.join('、')}`, {
        issues: [{ path: conflicts.join('、'), message: '加 --force 覆盖，或换一个 --dir' }],
      });
    }
  }
  const created = [];
  try {
    for (const target of targets) {
      fs.writeFileSync(target.file, target.content, 'utf8');
      created.push(path.basename(target.file));
    }
  } catch (err) {
    throw new RebalError('init_dir_unwritable', `写文件失败：${dir}`, {
      issues: [{ path: dir, message: err instanceof Error ? err.message : String(err) }],
    });
  }

  if (ctx.json) {
    app.stdout(`${JSON.stringify({ ok: true, created })}\n`);
  } else {
    for (const name of created) app.stdout(`已创建 ${name}\n`);
    app.stdout(values.demo ? '下一步：rebal status（示例数据不需要联网）\n' : '下一步：rebal status\n');
  }
  return EXIT.OK;
}

async function commandStatus(ctx) {
  const { app, values } = ctx;
  const basics = loadBasics(ctx);
  const loaded = await loadPrices(app, basics, { offline: ctx.offline, logLevel: ctx.logLevel });
  const render = renderOptions(ctx);

  const payload = {
    schemaVersion: 1,
    baseCurrency: loaded.config.portfolio.baseCurrency,
    totalBase: round2(loaded.portfolio.totalBase),
    classes: loaded.portfolio.classes.map((c) => ({
      classId: c.classId,
      targetWeight: c.targetWeight,
      band: c.band,
      valueBase: round2(c.valueBase),
      targetBase: round2(c.targetBase),
      driftBase: round2(c.driftBase),
      driftPp: round2(c.driftPp),
      outOfBand: c.outOfBand,
      actualRatio: round4(c.actualRatio),
    })),
    accounts: loaded.portfolio.accounts.map((a) => ({
      account: a.account,
      valueBase: round2(a.valueBase),
      ratio: round4(a.ratio),
    })),
    quotes: [...loaded.quotes.entries()].map(([symbol, q]) => ({
      symbol,
      price: q.price,
      currency: q.currency,
      fetchedAt: q.fetchedAt,
      stale: q.stale,
      source: q.source,
    })),
    fx: [...loaded.fx.entries()].map(([currency, f]) => ({
      currency,
      rateToBase: f.rateToBase,
      fetchedAt: f.fetchedAt,
      stale: f.stale,
      source: f.source,
    })),
    warnings: loaded.warnings,
  };

  if (ctx.json) {
    app.stdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    app.stdout(
      renderStatus({
        classes: loaded.portfolio.classes,
        portfolio: {
          baseCurrency: loaded.config.portfolio.baseCurrency,
          totalBase: loaded.portfolio.totalBase,
          accounts: loaded.portfolio.accounts,
        },
        portfolioName: loaded.config.portfolio.name,
        market: { quotes: loaded.quotes, fx: loaded.fx, offline: loaded.offline },
        render,
        warnings: ctx.quiet ? [] : loaded.warnings,
      }),
    );
  }

  if (values.strict && loaded.portfolio.outOfBandCount > 0) {
    throw new RebalError('strict_failed', `${loaded.portfolio.outOfBandCount} 个类别超出带宽`);
  }
  return EXIT.OK;
}

async function commandPlan(ctx) {
  const { app, values } = ctx;
  const basics = loadBasics(ctx);
  const baseCurrency = basics.config.portfolio.baseCurrency;

  let cash = basics.config.contribution.amount;
  if (values.cash !== undefined) {
    const text = String(values.cash).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(text)) {
      throw new RebalError('invalid_input', `--cash 必须是 0–1e9 的数字，当前是 ${JSON.stringify(values.cash)}`);
    }
    cash = Number(text);
    if (cash > 1e9) {
      throw new RebalError('invalid_input', `--cash 不能超过 1e9，当前是 ${cash}`);
    }
  }
  if (cash === null || cash === undefined) {
    throw new RebalError('cash_required', '这次投入多少钱没有指定', {
      issues: [{ path: '--cash', message: '用 rebal plan --cash 3000，或在配置里写 contribution.amount' }],
    });
  }

  const allowSell = values['no-sell'] ? false : values.sell ? true : basics.config.policy.allowSell;
  const loaded = await loadPrices(app, basics, { cash, offline: ctx.offline, logLevel: ctx.logLevel });

  const allocation = allocate({
    classes: Object.entries(loaded.config.targets).map(([classId, targetWeight]) => ({
      classId,
      label: loaded.config.classes[classId]?.name || classId,
      targetWeight,
      band: loaded.config.bands.byClass[classId] ?? loaded.config.bands.default,
      preferredSymbol: loaded.config.classes[classId]?.preferredSymbol ?? null,
    })),
    assets: loaded.config.assets,
    holdings: new Map([...loaded.holdings.bySymbol].map(([symbol, row]) => [symbol, { quantity: row.quantity }])),
    quotes: loaded.quotes,
    fx: loaded.fx,
    cash,
    policy: { ...loaded.config.policy, allowSell },
    feesPerOrder: loaded.config.fees.perOrder,
    baseCurrency,
  });

  const hasOrders = allocation.orders.length > 0;
  let plan = null;
  let planFile = null;
  const policy = { ...loaded.config.policy, allowSell };

  if (hasOrders && !values['no-save']) {
    const planId = await nextPlanId({
      stateDir: loaded.paths.stateDir,
      sleep: app.sleep,
      now: app.now,
    });
    plan = buildPlan({
      planId,
      now: app.now,
      toolVersion: TOOL_VERSION,
      baseCurrency,
      cash,
      policy,
      quotes: loaded.quotes,
      holdings: loaded.holdings,
      allocation,
    });
    planFile = savePlan({ stateDir: loaded.paths.stateDir, plan }).file;
  }

  const payload = plan ?? {
    schemaVersion: 1,
    planId: null,
    createdAt: null,
    toolVersion: TOOL_VERSION,
    baseCurrency,
    cash,
    policy,
    pricesAsOf: {},
    snapshot: [...loaded.holdings.bySymbol.entries()].map(([symbol, row]) => ({
      symbol,
      quantity: row.quantity,
      accounts: Object.fromEntries(row.accounts),
    })),
    orders: toPlanOrders(allocation.orders),
    skipped: allocation.skipped,
    warnings: allocation.warnings,
    before: allocation.before,
    after: allocation.after,
    remainingCash: allocation.remainingCash,
    feesTotal: allocation.feesTotal,
  };
  if (!hasOrders) payload.code = 'no_actionable_orders';
  if (planFile) payload.planFile = planFile;

  if (ctx.json) {
    app.stdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    app.stdout(renderPlan({ allocation, loaded, render: renderOptions(ctx), cash, planFile, quiet: ctx.quiet }));
  }
  return hasOrders ? EXIT.OK : EXIT.NO_RESULT;
}

async function commandCheck(ctx) {
  const { app, values } = ctx;
  const basics = loadBasics(ctx, { skipAssetCheck: true, ensureState: false });
  const plan = loadPlan({ stateDir: basics.paths.stateDir, planId: values.plan ?? 'latest' });
  const report = comparePlan({ plan, holdings: basics.holdings, now: app.now });

  if (ctx.json) {
    app.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    app.stdout(renderCheck(report, renderOptions(ctx), plan));
  }

  const notDone = report.summary.partial + report.summary.pending + report.summary.over + report.summary.reversed;
  if (values.strict && notDone > 0) {
    throw new RebalError('strict_failed', `${notDone} 笔订单没有执行到位`);
  }
  return EXIT.OK;
}

async function commandPrices(ctx) {
  const { app, values } = ctx;
  if (ctx.offline && values.refresh) {
    throw new RebalError('invalid_input', '--refresh 与 --offline 不能同时用');
  }
  const basics = loadBasics(ctx);
  const loaded = await loadPrices(app, basics, {
    offline: ctx.offline,
    refresh: Boolean(values.refresh),
    logLevel: ctx.logLevel,
  });
  const render = renderOptions(ctx);

  if (ctx.json) {
    app.stdout(
      `${JSON.stringify(
        {
          quotes: [...loaded.quotes.entries()].map(([symbol, q]) => ({ symbol, ...q })),
          fx: [...loaded.fx.entries()].map(([currency, f]) => ({ currency, ...f })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    app.stdout(
      renderPrices({
        quotes: loaded.quotes,
        fx: loaded.fx,
        baseCurrency: loaded.config.portfolio.baseCurrency,
        render,
      }),
    );
  }
  return EXIT.OK;
}

// ---------------- 渲染与错误 ----------------

/**
 * 从命令行/环境推断 state 目录，仅用于写错误日志（此时配置可能还没读成功）。
 * @param {App} app
 * @param {string[]} argv
 * @returns {string|undefined}
 */
function resolveStateDirHint(app, argv) {
  const index = argv.indexOf('--state-dir');
  const fromArgv = index >= 0 ? argv[index + 1] : undefined;
  if (fromArgv) return path.resolve(app.cwd, fromArgv);
  if (app.env.REBAL_STATE_DIR) return path.resolve(app.cwd, app.env.REBAL_STATE_DIR);
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex >= 0 && argv[dirIndex + 1] ? path.resolve(app.cwd, argv[dirIndex + 1]) : app.cwd;
  return path.join(dir, '.rebal');
}

/**
 * @param {{app: App, columns?: number}} ctx
 */
/**
 * 终端宽度：`COLUMNS` 环境变量 > `process.stdout.columns` > 100。
 * 少了这一步，DESIGN 里的宽度降级在真实终端永远不会触发。
 * @param {App} app
 * @returns {number}
 */
export function detectColumns(app) {
  if (Number.isFinite(app.columns) && app.columns > 0) return app.columns;
  const fromEnv = Number(app.env?.COLUMNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromStdout = Number(process.stdout.columns);
  if (Number.isFinite(fromStdout) && fromStdout > 0) return fromStdout;
  return 100;
}

function renderOptions(ctx) {
  const enabled =
    ctx.app.colorMode === 'always'
      ? true
      : ctx.app.colorMode === 'never'
        ? false
        : ctx.app.noColor
          ? false
          : ctx.app.isTty;
  return { layout: layoutFor(detectColumns(ctx.app)), color: makeColor(enabled) };
}

/**
 * @param {App} app
 * @param {RebalError} err
 * @param {boolean} json
 * @param {string[]} argv
 */
function reportError(app, err, json, argv) {
  // 内部错误要额外打 stack（SPEC §4.1）
  if (err.code === 'internal_error' && err.cause instanceof Error) {
    app.stderr(`${err.cause.stack ?? err.cause.message}\n`);
  }
  // 错误日志：state 目录不可写时退到 tmpdir（提示放在错误块之后，别打断"哪里错了"）
  const stateDir = resolveStateDirHint(app, argv);
  const logged = appendErrorLog({
    stateDir,
    error: err,
    stack: err.cause instanceof Error ? err.cause.stack : undefined,
    tmpDir: app.tmpDir,
  });

  if (json) {
    app.stdout(`${JSON.stringify(err.toJSON(), null, 2)}\n`);
  } else {
    app.stderr(`rebal: error: ${stripControl(err.message)} [${err.code}]\n`);
    // 第一行已经是完整句子时，加了路径前缀再重复一遍没有信息量
    const bareMessage = err.message.replace(/\s*\[[a-z0-9_]+\]\s*$/, '').trim();
    const shown = err.issues.filter((issue) => {
      if (issue.message === err.message) return false;
      return !(bareMessage.length > 8 && issue.message.includes(bareMessage));
    });
    for (const issue of shown.slice(0, 6)) {
      app.stderr(`  ${stripControl(issue.path)}: ${stripControl(issue.message)}\n`);
    }
    if (shown.length > 6) app.stderr(`  还有 ${shown.length - 6} 条\n`);
    const hint = HINTS[err.code];
    if (hint) app.stderr(`  怎么办：${hint}\n`);
    if (logged.fellBack) {
      app.stderr(`  错误日志写到 ${logged.file}（${stateDir ?? '状态目录'} 不可写）\n`);
    }
  }
  return err.exitCode;
}

const HINTS = {
  usage: '运行 rebal help 看用法',
  config_not_found: '运行 rebal init 生成一份配置，或用 --config 指定路径',
  config_exists: '加 --force 覆盖，或换一个 --dir',
  config_invalid: '按提示改 rebal.toml；字段名与取值范围见 README 的"配置"一节',
  targets_not_normalized: '把 [targets] 里的数字按同一比例缩放，使总和正好等于 1（例如 0.5 / 0.2 / 0.3）',
  invalid_class_id: '类别名只能用小写字母、数字与下划线，例如 us_equity',
  missing_preferred_symbol: '给权重非 0 的每个类别写 [classes.类别] 的 preferred_symbol',
  unknown_class: '把 [classes] 或 [bands] 里的类别名改成 [targets] 里已有的键',
  holdings_invalid: '数量必须是不小于 0 的数字（不能为负），代码列不能为空',
  holdings_too_large: '把持仓拆成多个文件，或删掉已经清仓的行',
  invalid_input: '按提示给出合法取值（金额是数字，例如 6000）',
  quote_invalid: '检查 quote_id 的前缀（us/sh/sz/hk）与 currency 是否写混了',
  fx_static_missing: '在 [fx.static] 里补齐缺少的货币汇率',
  unknown_field: '删掉拼错的配置项',
  invalid_env: '改掉这个环境变量，或 unset 它',
  holdings_not_found: '检查配置里的 holdings.path（CSV 至少要有 symbol 与 quantity 两列）',
  holdings_missing_column: '把配置 [holdings] 里的列名改成 CSV 里真实的表头',
  unknown_symbol: '给持仓里的每个代码补一段 [assets.代码]',
  cash_required: '用 rebal plan --cash 3000，或在配置里写 contribution.amount',
  quote_not_found: '确认 quote_id（美股 us、沪市 sh、深市 sz、港股 hk），或改用 --offline / provider=csv',
  quote_http_error: '稍后重试；或改用 --offline 读缓存',
  quote_rate_limited: '等几分钟再试；或改用 --offline 读缓存',
  fx_not_found: '在 [fx.static] 里写好汇率，或检查货币代码',
  fx_http_error: '稍后重试；或用 [fx.static] 写死汇率',
  network_error: '检查网络；或用 --offline 读缓存',
  network_redirect: '接口地址可能变了，检查 REBAL_QUOTE_URL',
  timeout: '网络慢，稍后重试或调大 quotes.timeout_ms',
  response_too_large: '响应异常大，稍后重试',
  state_dir_unwritable: '换一个 --state-dir，或检查目录权限',
  plan_not_found: '先运行 rebal plan 生成一份计划',
  plan_corrupt: '删掉 .rebal/plans 里那份文件，重新运行 rebal plan',
  no_actionable_orders: '这期不需要下单；如果期望下单，检查目标比例与现金金额',
  strict_failed: '这是 --strict 的预期行为；去掉 --strict 只看报告',
  init_dir_unwritable: '换一个 --dir 或给目录写权限',
  too_many_symbols: '分两次运行，或用 provider=csv 自报价',
  mock_fixture_invalid: '检查 REBAL_MOCK_QUOTES_FILE / REBAL_MOCK_FX_FILE 指向的 JSON',
  currency_conflict: '同一标的的多行币种必须一致',
  internal_error: '这是程序缺陷，请带上 --verbose 的输出提 issue',
};

// ---------------- 计划的终端输出 ----------------

/**
 * @param {object} options
 */
function renderPlan(options) {
  const { allocation, loaded, render, planFile, quiet } = options;
  const { color } = render;
  const baseCurrency = loaded.config.portfolio.baseCurrency;
  const lines = [];
  lines.push(
    `${loaded.config.portfolio.name} · 本币 ${baseCurrency} · 总市值 ${formatMoney(loaded.portfolio.totalBase, baseCurrency)}`,
  );
  const sources = [...new Set([...loaded.quotes.values()].map((q) => sourceLabel(q.source, q.provider)))];
  lines.push(color('dim', `本次投入 ${formatMoney(options.cash, baseCurrency)} · 价格来自 ${sources.join('、') || '无持仓'}`));
  lines.push('');

  if (allocation.orders.length === 0) {
    lines.push('没有需要执行的下单');
  } else {
    const columns = [
      { key: 'side', title: '方向', align: 'left', render: (o) => (o.side === 'buy' ? '买入' : '卖出') },
      { key: 'symbol', title: '代码', align: 'left', render: (o) => o.symbol },
      {
        key: 'name',
        title: '名称',
        align: 'left',
        // config 里 name 缺省是空字符串（不是 null），所以用 || 而不是 ??：
        // 空名字要显示 —（DESIGN 2.2），显示空白会让人以为解析失败
        render: (o) => truncateWidth(loaded.config.assets[o.symbol]?.name || '—', 22),
        onlyIn: ['full'],
      },
      { key: 'class', title: '类别', align: 'left', render: (o) => o.classLabel ?? o.classId },
      { key: 'quantity', title: '股数', align: 'right', render: (o) => formatQuantity(o.quantity) },
      { key: 'price', title: '价格', align: 'right', render: (o) => formatPrice(o.unitPrice, o.currency) },
      {
        // 下单要照着"券商里的币种金额"敲，所以两边都给：$7,851.80（本币 ¥52,306.97）
        key: 'value',
        title: '金额',
        align: 'right',
        render: (o) => orderAmount(o, baseCurrency),
      },
      {
        key: 'fee',
        title: '手续费',
        align: 'right',
        render: (o) => formatMoney(o.feeBase, baseCurrency),
        onlyIn: ['full'],
      },
    ];
    lines.push(...renderTable(columns, allocation.orders, { layout: render.layout }));
    lines.push('');

    const buy = allocation.orders.filter((o) => o.side === 'buy').reduce((a, o) => a + o.valueBase, 0);
    const sell = allocation.orders.filter((o) => o.side === 'sell').reduce((a, o) => a + o.valueBase, 0);
    const parts = [`合计 ${allocation.orders.length} 笔`];
    if (buy > 0) parts.push(`买入 ${formatMoney(buy, baseCurrency)}`);
    if (sell > 0) parts.push(`卖出 ${formatMoney(sell, baseCurrency)}`);
    parts.push(`手续费 ${formatMoney(allocation.feesTotal, baseCurrency)}`);
    parts.push(`剩余现金 ${formatMoney(allocation.remainingCash, baseCurrency)}`);
    lines.push(parts.join(' · '));
  }

  lines.push(
    // 用类别名（没有 name 时回退 ID），跟上面表格里的「类别」列保持一致
    `执行后  ${allocation.after.classes
      .map((c) => `${loaded.config.classes[c.id]?.name || c.id} ${formatDrift(c.driftPp)}`)
      .join(' · ')}`,
  );

  if (!quiet && allocation.warnings.length > 0) {
    lines.push('');
    lines.push(color('warn', '警告'));
    for (const warning of allocation.warnings.slice(0, 5)) lines.push(`  ${warning}`);
    if (allocation.warnings.length > 5) {
      lines.push(`  还有 ${allocation.warnings.length - 5} 条警告，见计划文件`);
    }
  }

  if (planFile) {
    lines.push('');
    lines.push(color('dim', `计划已保存：${path.relative(loaded.paths.dir, planFile)}`));
    // 说清 check 依赖手动更新持仓，否则用户会以为它自动对账
    lines.push(color('dim', '成交后更新 holdings.csv，再运行 rebal check'));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * @param {any} report
 * @param {{layout: string, color: (t: string, s: string) => string}} render
 * @param {any} plan
 */
function renderCheck(report, render, plan) {
  const { color } = render;
  const STATUS_TEXT = { done: '完成', partial: '部分', pending: '未执行', over: '超量', reversed: '反向' };
  const created = plan.createdAt ? formatLocalDateTime(new Date(plan.createdAt)) : '—';
  const lines = [`核对计划 ${plan.planId}`, `创建于 ${created} · 实际持仓来自 holdings.csv`, ''];
  const columns = [
    { key: 'symbol', title: '代码', align: 'left', render: (r) => r.symbol },
    { key: 'side', title: '方向', align: 'left', render: (r) => (r.side === 'buy' ? '买入' : '卖出') },
    { key: 'planned', title: '计划(股)', align: 'right', render: (r) => formatQuantity(r.planned) },
    { key: 'actual', title: '实际(股)', align: 'right', render: (r) => formatQuantity(r.actual) },
    { key: 'status', title: '状态', align: 'left', render: (r) => paint(STATUS_TEXT[r.status], color) },
  ];
  lines.push(...renderTable(columns, report.items, { layout: render.layout }));
  if (report.unplanned.length > 0) {
    lines.push('');
    lines.push('计划外变动');
    for (const item of report.unplanned) lines.push(`  ${item.symbol} ${item.delta > 0 ? '+' : ''}${item.delta}`);
  }
  const s = report.summary;
  lines.push('');
  // 只打印非零的计数：六项全打出来时，多数人只看得到五个 0
  const parts = [
    [s.done, '完成'],
    [s.partial, '部分'],
    [s.pending, '未执行'],
    [s.over, '超量'],
    [s.reversed, '反向'],
    [s.unplanned, '计划外'],
  ]
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${label} ${count}`);
  lines.push(parts.length > 0 ? parts.join(' · ') : '计划里的订单都已完成');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 状态词染色（与 DESIGN 2.3 的词表一致）。 */
function paint(status, color) {
  if (status === '越界' || status === '反向' || status === '超量') return color('bad', status);
  if (status === '缓存' || status === '部分' || status === '未执行') return color('warn', status);
  if (status === '正常' || status === '完成') return color('ok', status);
  return status;
}

/**
 * 订单金额用标的自己的货币（价格列的符号已经说明币种），
 * 本币合计在表格下方给——行内塞"本币等值"会把表撑到 94 列。
 */
function orderAmount(order) {
  return formatMoney(order.value, order.currency);
}

/** 股数：整数 + 千分位（`1,800`）。 */
function formatQuantity(value) {
  return groupInteger(String(Math.round(value)));
}

function round2(value) {
  return roundHalfUp(value, 2);
}
function round4(value) {
  return roundHalfUp(value, 4);
}
