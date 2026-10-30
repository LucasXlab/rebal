/**
 * 计划文件的生成、保存、读回与核对（SPEC §3.6、§3.8、§5.9）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { RebalError } from './errors.js';
import { formatIsoLocal, formatPlanId } from './util.js';

export const PLAN_SCHEMA_VERSION = 1;
export const MAX_PLANS = 52;

/** 计划 ID 白名单：路径穿越在正则这一层就挡住。 */
const PLAN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{2}-\d{2}(-[2-9])?$/;

/**
 * @param {string} stateDir
 */
export function plansDir(stateDir) {
  return path.join(stateDir, 'plans');
}

/**
 * @param {string} stateDir
 * @param {string} planId
 */
export function planPath(stateDir, planId) {
  return path.join(plansDir(stateDir), `${planId}.json`);
}

/**
 * 生成一个不与已有文件冲突的 planId。同秒内重复时追加 -2…-9。
 * @param {{stateDir: string, date: Date, sleep: (ms: number) => Promise<void>, now: () => number}} options
 * @returns {Promise<string>}
 */
export async function nextPlanId(options) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = formatPlanId(new Date(options.now()));
    if (!fs.existsSync(planPath(options.stateDir, base))) return base;
    for (let suffix = 2; suffix <= 9; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!fs.existsSync(planPath(options.stateDir, candidate))) return candidate;
    }
    // 同一秒的 9 个后缀都满了：等 1 秒再取新的秒
    await options.sleep(1000);
  }
  throw new RebalError('internal_error', '生成 planId 失败：同一秒内的序号用尽');
}

/**
 * 只挑 SPEC §3.6 列出的订单字段。
 * 渲染层会在 orders 上挂 `classLabel` 之类的内部字段；计划文件与 --json 是
 * schemaVersion 1 的契约，多一个键就会让下游消费者对不上，所以在这里筛掉。
 * @param {any[]} orders
 * @returns {any[]}
 */
export function toPlanOrders(orders) {
  return orders.map((o) => ({
    symbol: o.symbol,
    side: o.side,
    classId: o.classId,
    quantity: o.quantity,
    lotSize: o.lotSize,
    unitPrice: o.unitPrice,
    currency: o.currency,
    fxRate: o.fxRate,
    value: o.value,
    valueBase: o.valueBase,
    feeBase: o.feeBase,
  }));
}

/**
 * 组装 Plan 对象（字段与 SPEC §3.6 一一对应）。
 * @param {object} options
 * @param {string} options.planId
 * @param {() => number} options.now
 * @param {string} options.toolVersion
 * @param {string} options.baseCurrency
 * @param {number} options.cash
 * @param {{allowSell: boolean, minTradeValue: number, maxOrders: number}} options.policy
 * @param {Map<string, {fetchedAt: string}>} options.quotes
 * @param {import('./holdings.js').Holdings} options.holdings
 * @param {ReturnType<typeof import('./allocate.js').allocate>} options.allocation
 */
export function buildPlan(options) {
  const snapshot = [...options.holdings.bySymbol.entries()]
    .map(([symbol, row]) => ({
      symbol,
      quantity: row.quantity,
      accounts: Object.fromEntries(row.accounts),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const pricesAsOf = {};
  for (const [symbol] of options.holdings.bySymbol) {
    const quote = options.quotes.get(symbol);
    if (quote) pricesAsOf[symbol] = quote.fetchedAt;
  }

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: options.planId,
    createdAt: formatIsoLocal(new Date(options.now())),
    toolVersion: options.toolVersion,
    baseCurrency: options.baseCurrency,
    cash: options.cash,
    policy: { ...options.policy },
    pricesAsOf,
    snapshot,
    orders: toPlanOrders(options.allocation.orders),
    skipped: options.allocation.skipped,
    warnings: options.allocation.warnings,
    before: options.allocation.before,
    after: options.allocation.after,
    remainingCash: options.allocation.remainingCash,
    feesTotal: options.allocation.feesTotal,
  };
}

/**
 * 原子写一个 JSON 文件。失败抛 state_dir_unwritable（SPEC §5.9）。
 * @param {string} file
 * @param {unknown} data
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不影响判定
    }
    throw new RebalError('state_dir_unwritable', `写计划文件失败：${file}`, {
      issues: [{ path: file, message: err instanceof Error ? err.message : String(err) }],
    });
  }
}

/**
 * 保存计划：写 `<planId>.json` 与 `latest.json`，再清理旧文件。
 * @param {{stateDir: string, plan: any}} options
 * @returns {{file: string, pruned: number}}
 */
export function savePlan(options) {
  const dir = plansDir(options.stateDir);
  const file = planPath(options.stateDir, options.plan.planId);
  writeJsonAtomic(file, options.plan);
  writeJsonAtomic(path.join(dir, 'latest.json'), options.plan);
  const pruned = prunePlans(options.stateDir);
  return { file, pruned };
}

/**
 * 只保留最近 MAX_PLANS 份计划（按文件名倒序 = 时间倒序）。
 * @param {string} stateDir
 * @returns {number} 删除的数量
 */
export function prunePlans(stateDir) {
  const dir = plansDir(stateDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => PLAN_ID_PATTERN.test(n.replace(/\.json$/, '')) && n.endsWith('.json'));
  } catch {
    return 0;
  }
  const sorted = names.sort().reverse();
  let removed = 0;
  for (const name of sorted.slice(MAX_PLANS)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed += 1;
    } catch {
      // 删不掉就留着，不影响本次结果
    }
  }
  return removed;
}

/**
 * 读回计划。`latest` 读 latest.json，否则按 planId 读；planId 必须匹配白名单。
 * @param {{stateDir: string, planId: string}} options
 * @returns {any}
 */
export function loadPlan(options) {
  const { stateDir } = options;
  const planId = options.planId ?? 'latest';
  let file;
  if (planId === 'latest') {
    file = path.join(plansDir(stateDir), 'latest.json');
  } else {
    if (!PLAN_ID_PATTERN.test(planId)) {
      throw new RebalError('plan_not_found', `没有这个计划：${planId}`, {
        issues: [{ path: planId, message: 'planId 形如 2026-10-29T21-45-00-04-00，或直接用 latest' }],
      });
    }
    file = planPath(stateDir, planId);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new RebalError('plan_not_found', `计划文件不存在：${file}`, {
      issues: [{ path: file, message: '先运行 rebal plan 生成一份计划' }],
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RebalError('plan_corrupt', `计划文件不是合法 JSON：${file}`, {
      issues: [{ path: file, message: '删掉它重新运行 rebal plan' }],
    });
  }
  if (!parsed || parsed.schemaVersion !== PLAN_SCHEMA_VERSION || !Array.isArray(parsed.orders) || !Array.isArray(parsed.snapshot)) {
    throw new RebalError('plan_corrupt', `计划文件缺字段或版本不对：${file}`, {
      issues: [{ path: file, message: '删掉它重新运行 rebal plan' }],
    });
  }
  return parsed;
}

/**
 * 对比计划与当前持仓（SPEC §3.8）。
 * @param {{plan: any, holdings: import('./holdings.js').Holdings}} options
 * @returns {{schemaVersion: number, planId: string, checkedAt: string, items: any[], unplanned: any[], summary: Record<string, number>}}
 */
export function comparePlan(options) {
  const { plan, holdings } = options;
  const before = new Map(plan.snapshot.map((row) => [row.symbol, row.quantity]));
  const deltaOf = (symbol) => (holdings.bySymbol.get(symbol)?.quantity ?? 0) - (before.get(symbol) ?? 0);

  const plannedSymbols = new Set();
  const items = plan.orders.map((order) => {
    plannedSymbols.add(order.symbol);
    const delta = deltaOf(order.symbol);
    const signed = order.side === 'buy' ? delta : -delta;
    const planned = order.quantity;
    let status;
    if (signed < -1e-6) status = 'reversed';
    else if (Math.abs(signed) <= 1e-6) status = 'pending';
    else if (Math.abs(signed - planned) <= 1e-6) status = 'done';
    else if (signed < planned) status = 'partial';
    else status = 'over';
    return { symbol: order.symbol, side: order.side, planned, actual: signed, status };
  });

  const unplanned = [];
  for (const [symbol, row] of holdings.bySymbol) {
    if (plannedSymbols.has(symbol)) continue;
    const delta = row.quantity - (before.get(symbol) ?? 0);
    if (Math.abs(delta) > 1e-6) unplanned.push({ symbol, delta });
  }
  unplanned.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const summary = { done: 0, partial: 0, pending: 0, over: 0, reversed: 0, unplanned: unplanned.length };
  for (const item of items) summary[item.status] += 1;

  return {
    schemaVersion: 1,
    planId: plan.planId,
    checkedAt: formatIsoLocal(new Date(options.now?.() ?? Date.now())),
    items,
    unplanned,
    summary,
  };
}
