/**
 * 整数分配算法（SPEC §5.7）。纯函数：不读文件、不联网、不看时钟。
 *
 * 输入输出都用"本币金额"（base currency），数量保持整数（lotSize 的整数倍）。
 * 全程用未舍入的浮点数计算，只在输出层舍入——否则 floor() 与 <= budget 的判断会被中间舍入改变。
 */

/**
 * 误差容限：金额比较、need 判断都用它。
 * 金额最大约 1e9，double 的有效位数足够；1e-9 比"一分钱"小 7 个数量级。
 */
import { formatMoney } from './util.js';

const EPS = 1e-9;

/**
 * @typedef {object} Order
 * @property {string} symbol
 * @property {'buy'|'sell'} side
 * @property {string} classId
 * @property {number} quantity
 * @property {number} lotSize
 * @property {number} unitPrice
 * @property {string} currency
 * @property {number} fxRate
 * @property {number} value 数量 × 单价（标的货币）
 * @property {number} valueBase 折算成本币
 * @property {number} feeBase 手续费（本币）
 */

/**
 * @param {object} input
 * @param {{classId: string, targetWeight: number, band: number, preferredSymbol: string|null}[]} input.classes
 * @param {Record<string, {classId: string, currency: string, lotSize: number}>} input.assets
 * @param {Map<string, {quantity: number}>} input.holdings
 * @param {Map<string, {price: number}>} input.quotes
 * @param {Map<string, {rateToBase: number}>} input.fx
 * @param {number} input.cash
 * @param {{allowSell: boolean, minTradeValue: number, maxOrders: number}} input.policy
 * @param {number} input.feesPerOrder
 * @param {string} [input.baseCurrency] 本币代码，只用于生成人话警告
 * @returns {{orders: Order[], skipped: {classId: string, symbol?: string, reason: string}[], warnings: string[], feesTotal: number, remainingCash: number, before: any, after: any}}
 */
export function allocate(input) {
  const { classes, assets, holdings, quotes, fx, cash, policy, feesPerOrder } = input;
  const baseCurrency = input.baseCurrency ?? 'CNY';
  const minTradeValue = policy.minTradeValue;
  const maxOrders = policy.maxOrders;

  /**
   * 取一个符号在本币下的单价；价格或汇率缺失说明上游没校验，直接抛（不是用户输入问题）。
   * @param {string} symbol
   */
  const unitBase = (symbol) => {
    const asset = assets[symbol];
    const quote = quotes.get(symbol);
    const rate = fx.get(asset.currency)?.rateToBase ?? 1;
    if (!quote || !(quote.price > 0)) throw new Error(`缺少 ${symbol} 的价格`);
    return { price: quote.price, rate, unit: quote.price * rate };
  };

  /** 类别当前市值（本币）。 */
  const labelOf = (classId) => classes.find((c) => c.classId === classId)?.label || classId;
  const classValue = (classId) => {
    let sum = 0;
    for (const [symbol, row] of holdings) {
      const asset = assets[symbol];
      if (!asset || asset.classId !== classId) continue;
      sum += row.quantity * unitBase(symbol).unit;
    }
    return sum;
  };

  const totalBase = classes.reduce((sum, c) => sum + classValue(c.classId), 0);
  const targetAfterBase = totalBase + cash;
  const targetValue = new Map(classes.map((c) => [c.classId, c.targetWeight * targetAfterBase]));
  const values = new Map(classes.map((c) => [c.classId, classValue(c.classId)]));

  const beforeClasses = classes.map((c) => {
    const valueBase = values.get(c.classId);
    const targetBase = targetValue.get(c.classId);
    const driftBase = valueBase - targetBase;
    return {
      id: c.classId,
      valueBase,
      targetBase,
      driftBase,
      driftPp: targetAfterBase > 0 ? (driftBase / targetAfterBase) * 100 : 0,
      outOfBand: targetAfterBase > 0 && Math.abs(driftBase) > c.band * targetAfterBase,
    };
  });

  /** @type {Order[]} */
  const orders = [];
  /** @type {{classId: string, symbol?: string, reason: string}[]} */
  const skipped = [];
  /** @type {string[]} */
  const extraWarnings = [];
  /** 已卖出金额（本币），用于 plannedValue */
  const soldValue = new Map();
  let feesTotal = 0;
  let cashPool = cash;

  /**
   * 记一条跳过原因（同类别同原因只记一次）。
   * @param {string} classId
   * @param {string} reason
   * @param {string} [symbol]
   */
  const skip = (classId, reason, symbol) => {
    if (skipped.some((s) => s.classId === classId && s.reason === reason)) return;
    skipped.push(symbol ? { classId, symbol, reason } : { classId, reason });
  };

  // ---------- 卖出阶段 ----------
  if (policy.allowSell) {
    const candidates = [...classes]
      .filter((c) => values.get(c.classId) - targetValue.get(c.classId) > c.band * targetAfterBase)
      .sort((a, b) => {
        const diff = values.get(b.classId) - targetValue.get(b.classId) - (values.get(a.classId) - targetValue.get(a.classId));
        return diff !== 0 ? diff : a.classId.localeCompare(b.classId);
      });

    for (const candidate of candidates) {
      if (orders.length >= maxOrders) break;
      const symbol = candidate.preferredSymbol;
      if (!symbol) {
        skip(candidate.classId, 'sell_no_holdings');
        continue;
      }
      const row = holdings.get(symbol);
      const asset = assets[symbol];
      if (!row || !(row.quantity > 0) || !asset) {
        skip(candidate.classId, 'sell_no_holdings', symbol);
        continue;
      }
      const { price, rate, unit } = unitBase(symbol);
      const driftBase = values.get(candidate.classId) - targetValue.get(candidate.classId);
      const lotSize = asset.lotSize;
      const byDrift = Math.floor(driftBase / unit / lotSize + EPS) * lotSize;
      const byHoldings = Math.floor(row.quantity / lotSize + EPS) * lotSize;
      const quantity = Math.min(byDrift, byHoldings);
      const gross = quantity * unit;

      if (quantity <= 0) {
        skip(candidate.classId, 'sell_no_holdings', symbol);
        continue;
      }
      if (gross < minTradeValue) {
        skip(candidate.classId, 'sell_below_min_trade', symbol);
        continue;
      }
      const net = gross - feesPerOrder;
      if (net <= 0) {
        skip(candidate.classId, 'sell_below_fee', symbol);
        continue;
      }
      // 按持仓截断后仍然超配
      if (byDrift > byHoldings && driftBase - gross > candidate.band * targetAfterBase) {
        skip(candidate.classId, 'sell_capped_by_holdings', symbol);
      }

      orders.push({
        symbol,
        side: 'sell',
        classId: candidate.classId,
        classLabel: labelOf(candidate.classId),
        quantity,
        lotSize,
        unitPrice: price,
        currency: asset.currency,
        fxRate: rate,
        value: quantity * price,
        valueBase: gross,
        feeBase: feesPerOrder,
      });
      feesTotal += feesPerOrder;
      cashPool += net;
      soldValue.set(candidate.classId, gross);
    }
  }

  // ---------- 买入阶段 ----------
  /** 计划执行后的类别市值（用于算 need）。 */
  const plannedValue = new Map(
    classes.map((c) => [c.classId, values.get(c.classId) - (soldValue.get(c.classId) ?? 0)]),
  );
  let budget = cashPool;
  /** 类别 → 是否已有买单（决定是否再收一次手续费）。 */
  const hasBuyOrder = new Set();
  const buyOrders = new Map();

  for (let guard = 0; guard < 1_000_000; guard += 1) {
    if (orders.length >= maxOrders) {
      for (const c of classes) {
        const need = targetValue.get(c.classId) - plannedValue.get(c.classId);
        if (need > EPS && c.targetWeight > 0) skip(c.classId, 'max_orders_reached');
      }
      break;
    }
    const candidates = classes
      .filter((c) => c.targetWeight > 0 && targetValue.get(c.classId) - plannedValue.get(c.classId) > EPS)
      .sort((a, b) => {
        const needB = targetValue.get(b.classId) - plannedValue.get(b.classId);
        const needA = targetValue.get(a.classId) - plannedValue.get(a.classId);
        return needB !== needA ? needB - needA : a.classId.localeCompare(b.classId);
      });
    if (candidates.length === 0) break;

    let bought = false;
    for (const candidate of candidates) {
      const symbol = candidate.preferredSymbol;
      if (!symbol) continue;
      const asset = assets[symbol];
      if (!asset) continue;
      const { price, rate, unit } = unitBase(symbol);
      const lotCost = unit * asset.lotSize;
      const isNewOrder = !hasBuyOrder.has(candidate.classId);
      const cost = isNewOrder ? lotCost + feesPerOrder : lotCost;
      if (cost > budget + EPS) {
        // 够买一手但不够付手续费
        if (lotCost <= budget + EPS && isNewOrder) skip(candidate.classId, 'fee_exceeds_cash', symbol);
        continue;
      }
      const existing = buyOrders.get(candidate.classId);
      if (existing) {
        existing.quantity += asset.lotSize;
        existing.value = existing.quantity * price;
        existing.valueBase = existing.value * rate;
      } else {
        const order = {
          symbol,
          side: 'buy',
          classId: candidate.classId,
          quantity: asset.lotSize,
          lotSize: asset.lotSize,
          unitPrice: price,
          currency: asset.currency,
          fxRate: rate,
          value: asset.lotSize * price,
          valueBase: asset.lotSize * price * rate,
          feeBase: feesPerOrder,
        };
        // 必须 push 同一个对象：后续 existing.quantity += lot 是原地累加的，
        // 推副本会让 orders 里的股数停在一手，且 orders.indexOf(order) 失效
        order.classLabel = labelOf(order.classId);
        buyOrders.set(candidate.classId, order);
        orders.push(order);
        hasBuyOrder.add(candidate.classId);
        feesTotal += feesPerOrder;
      }
      budget -= cost;
      plannedValue.set(candidate.classId, plannedValue.get(candidate.classId) + lotCost);
      bought = true;
      break;
    }
    if (!bought) break;
  }

  // ---------- 丢弃低于最小交易额的买单（在汇总之前） ----------
  for (const [classId, order] of [...buyOrders.entries()]) {
    if (order.valueBase < minTradeValue - EPS) {
      orders.splice(orders.indexOf(order), 1);
      buyOrders.delete(classId);
      hasBuyOrder.delete(classId);
      feesTotal -= order.feeBase;
      budget += order.valueBase + order.feeBase;
      plannedValue.set(classId, plannedValue.get(classId) - order.valueBase);
      skip(classId, 'below_min_trade', order.symbol);
    }
  }

  // ---------- 执行后汇总 ----------
  const afterTotalBase = totalBase + cash - feesTotal;
  /** 执行后每个符号的持仓数量。 */
  const afterQuantities = new Map([...holdings].map(([symbol, row]) => [symbol, row.quantity]));
  for (const order of orders) {
    const delta = order.side === 'buy' ? order.quantity : -order.quantity;
    afterQuantities.set(order.symbol, (afterQuantities.get(order.symbol) ?? 0) + delta);
  }
  const afterValue = (classId) => {
    let sum = 0;
    for (const [symbol, quantity] of afterQuantities) {
      const asset = assets[symbol];
      if (!asset || asset.classId !== classId) continue;
      sum += quantity * unitBase(symbol).unit;
    }
    return sum;
  };

  const afterClasses = classes.map((c) => {
    const valueBase = afterValue(c.classId);
    const targetBase = c.targetWeight * afterTotalBase;
    const driftBase = valueBase - targetBase;
    return {
      id: c.classId,
      valueBase,
      targetBase,
      driftBase,
      driftPp: afterTotalBase > 0 ? (driftBase / afterTotalBase) * 100 : 0,
      outOfBand: afterTotalBase > 0 && Math.abs(driftBase) > c.band * afterTotalBase,
    };
  });

  const maxAbsDriftPp = afterClasses.reduce((max, c) => Math.max(max, Math.abs(c.driftPp)), 0);
  const remainingCash = cash + [...soldValue.values()].reduce((a, b) => a + b, 0) - orders
    .filter((o) => o.side === 'buy')
    .reduce((a, o) => a + o.valueBase, 0) - feesTotal;

  // ---------- 结束后仍越界：给出原因（与 skipped 一一对应） ----------
  for (const c of afterClasses) {
    if (!c.outOfBand) continue;
    if (skipped.some((s) => s.classId === c.id)) continue;
    const before = beforeClasses.find((b) => b.id === c.id);
    if (before && before.driftBase > 0 && !policy.allowSell) {
      skip(c.id, 'overweight_no_sell');
    } else {
      skip(c.id, 'lot_too_expensive');
    }
  }

  // ---------- 排序：卖单在前，再按 classId、symbol ----------
  orders.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'sell' ? -1 : 1;
    return a.classId.localeCompare(b.classId) || a.symbol.localeCompare(b.symbol);
  });

  // skipped 的顺序固定为 [targets] 里的类别顺序（再按原因），保证输出可复现
  const classOrder = new Map(classes.map((c, i) => [c.classId, i]));
  skipped.sort((a, b) => {
    const byClass = (classOrder.get(a.classId) ?? 99) - (classOrder.get(b.classId) ?? 99);
    return byClass !== 0 ? byClass : a.reason.localeCompare(b.reason);
  });

  const lotCostOf = (classId) => {
    const c = classes.find((x) => x.classId === classId);
    const symbol = c?.preferredSymbol;
    if (!symbol || !assets[symbol]) return null;
    try {
      return unitBase(symbol).unit * assets[symbol].lotSize;
    } catch {
      return null;
    }
  };
  const warnings = skipped.map((s) => describeSkip(s, {
    classes,
    afterClasses,
    minTradeValue,
    maxOrders,
    assets,
    lotCostOf,
    remainingCash,
    baseCurrency,
    labelOf,
  }));

  return {
    orders,
    skipped,
    warnings: [...warnings, ...extraWarnings],
    feesTotal,
    remainingCash,
    before: { totalBase, classes: beforeClasses, cash },
    after: { totalBase: afterTotalBase, maxAbsDriftPp, classes: afterClasses, remainingCash },
  };
}

/**
 * 把一条 skipped 变成人话（DESIGN 的文案要求：说清楚"为什么"和"下一步"）。
 * @param {{classId: string, symbol?: string, reason: string}} skip
 * @param {{classes: any[], afterClasses: any[], minTradeValue: number, maxOrders: number, assets: Record<string, any>, labelOf: (classId: string) => string}} ctx
 * @returns {string}
 */
function describeSkip(skip, ctx) {
  const name = ctx.labelOf(skip.classId);
  const after = ctx.afterClasses.find((c) => c.id === skip.classId);
  const pp = after ? Math.abs(after.driftPp).toFixed(1) : '?';
  const symbol = skip.symbol ?? ctx.classes.find((c) => c.classId === skip.classId)?.preferredSymbol ?? skip.classId;
  const lot = ctx.assets[symbol]?.lotSize ?? 1;
  const lotCost = ctx.lotCostOf(skip.classId);
  const lotCostText = lotCost === null ? '一手' : `一手 ${lot} 股约 ${formatMoney(lotCost, ctx.baseCurrency)}`;
  const cashText = `现金只剩 ${formatMoney(ctx.remainingCash, ctx.baseCurrency)}`;
  switch (skip.reason) {
    case 'overweight_no_sell':
      return `${name} 超配 ${pp}pp，本次不卖出；加 --sell 可以配平`;
    case 'lot_too_expensive':
      return `${name} 还差 ${pp}pp，但${lotCostText}，${cashText}，买不起`;
    case 'max_orders_reached':
      return `订单数到上限 ${ctx.maxOrders}，${name} 还没配平；加 --cash 分两次买或调大 policy.max_orders`;
    case 'fee_exceeds_cash':
      return `${name} 的现金够买一手，但不够付手续费`;
    case 'below_min_trade':
      return `${name} 的买单不到最小交易额 ${formatMoney(ctx.minTradeValue, ctx.baseCurrency)}，已跳过`;
    case 'sell_below_min_trade':
      return `${name} 要卖的金额不到最小交易额 ${formatMoney(ctx.minTradeValue, ctx.baseCurrency)}，这次不卖`;
    case 'sell_no_holdings':
      return `${name} 超配，但首选符号没有持仓；检查 classes.${skip.classId}.preferred_symbol`;
    case 'sell_capped_by_holdings':
      return `${name} 的持股不够卖到目标，已把能卖的卖完`;
    case 'sell_below_fee':
      return `${name} 的卖出金额还不够手续费，这次不卖`;
    default:
      return `${name}: ${skip.reason}`;
  }
}
