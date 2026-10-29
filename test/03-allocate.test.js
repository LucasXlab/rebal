import assert from 'node:assert/strict';
import test from 'node:test';
import { allocate } from '../src/allocate.js';

/** SPEC §5.8 的算例输入。 */
function workedExample(overrides = {}) {
  const assets = {
    VTI: { classId: 'us_equity', currency: 'USD', lotSize: 1, name: 'Vanguard Total Stock Market ETF' },
    '510300': { classId: 'cn_equity', currency: 'CNY', lotSize: 100, name: '沪深300ETF' },
    BND: { classId: 'bond', currency: 'USD', lotSize: 1, name: 'Vanguard Total Bond Market ETF' },
  };
  const holdings = new Map([
    ['VTI', { quantity: 10 }],
    ['BND', { quantity: 50 }],
    ['510300', { quantity: 1000 }],
  ]);
  const quotes = new Map([
    ['VTI', { price: 300 }],
    ['BND', { price: 70 }],
    ['510300', { price: 4 }],
  ]);
  const fx = new Map([
    ['CNY', { rateToBase: 1 }],
    ['USD', { rateToBase: 7 }],
  ]);
  const classes = [
    { classId: 'us_equity', targetWeight: 0.5, band: 0.03, preferredSymbol: 'VTI' },
    { classId: 'cn_equity', targetWeight: 0.2, band: 0.03, preferredSymbol: '510300' },
    { classId: 'bond', targetWeight: 0.3, band: 0.03, preferredSymbol: 'BND' },
  ];
  return {
    classes: overrides.classes ?? classes,
    assets: overrides.assets ?? assets,
    holdings: overrides.holdings ?? holdings,
    quotes: overrides.quotes ?? quotes,
    fx: overrides.fx ?? fx,
    cash: overrides.cash ?? 6000,
    policy: overrides.policy ?? { allowSell: false, minTradeValue: 100, maxOrders: 20 },
    feesPerOrder: overrides.feesPerOrder ?? 1.5,
    baseCurrency: 'CNY',
  };
}

const near = (actual, expected, tolerance = 0.011) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} 与 ${expected} 相差超过 ${tolerance}`);

test('T33 算例 (a) 默认不卖出：900 股 + 1 股、手续费 3、余额 297、执行后 ±14.15pp', () => {
  const result = allocate(workedExample());
  assert.equal(result.orders.length, 2);
  const cn = result.orders.find((o) => o.symbol === '510300');
  const us = result.orders.find((o) => o.symbol === 'VTI');
  assert.equal(cn.side, 'buy');
  assert.equal(cn.quantity, 900);
  assert.equal(cn.lotSize, 100);
  assert.equal(cn.unitPrice, 4);
  assert.equal(cn.value, 3600);
  assert.equal(cn.valueBase, 3600);
  assert.equal(cn.feeBase, 1.5);
  assert.equal(us.quantity, 1);
  assert.equal(us.unitPrice, 300);
  assert.equal(us.fxRate, 7);
  assert.equal(us.value, 300);
  assert.equal(us.valueBase, 2100);
  near(result.feesTotal, 3);
  near(result.remainingCash, 297);
  near(result.after.totalBase, 55497);
  near(result.after.maxAbsDriftPp, 14.15);
  const drifts = Object.fromEntries(result.after.classes.map((c) => [c.id, c.driftPp]));
  near(drifts.us_equity, -8.38);
  near(drifts.cn_equity, -6.31);
  near(drifts.bond, 14.15);
  assert.deepEqual(
    result.skipped,
    [
      { classId: 'us_equity', reason: 'lot_too_expensive' },
      { classId: 'cn_equity', reason: 'lot_too_expensive' },
      { classId: 'bond', reason: 'overweight_no_sell' },
    ],
  );
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[2], /--sell/);
});

test('T34 算例 (b) --sell：卖 BND 16 股、买 1800 + 3 股、执行后全部在带内', () => {
  const result = allocate(workedExample({ policy: { allowSell: true, minTradeValue: 100, maxOrders: 20 } }));
  assert.equal(result.orders.length, 3);
  const [sell, ...buys] = result.orders;
  assert.equal(sell.side, 'sell');
  assert.equal(sell.symbol, 'BND');
  assert.equal(sell.quantity, 16);
  assert.equal(sell.valueBase, 7840);
  assert.equal(buys.length, 2);
  const cn = buys.find((o) => o.symbol === '510300');
  const us = buys.find((o) => o.symbol === 'VTI');
  assert.equal(cn.quantity, 1800);
  assert.equal(cn.valueBase, 7200);
  assert.equal(us.quantity, 3);
  assert.equal(us.valueBase, 6300);
  near(result.feesTotal, 4.5);
  near(result.remainingCash, 335.5);
  near(result.after.totalBase, 55495.5);
  near(result.after.maxAbsDriftPp, 0.81);
  const drifts = Object.fromEntries(result.after.classes.map((c) => [c.id, c.driftPp]));
  near(drifts.us_equity, -0.81);
  near(drifts.cn_equity, 0.18);
  near(drifts.bond, 0.02);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.warnings, []);
});

test('T35 现金太少（¥50，最小一手 ¥400）→ 0 笔订单，skipped 是 lot_too_expensive', () => {
  const result = allocate(workedExample({ cash: 50 }));
  assert.equal(result.orders.length, 0);
  assert.ok(result.skipped.some((s) => s.reason === 'lot_too_expensive'));
  assert.ok(result.warnings.some((w) => /买不起/.test(w)));
});

test('T36 已经配平（cash=0 且在带内）→ 0 笔订单、无 skipped', () => {
  // 总市值 49500：us 24750 / cn 9900 / bond 14850，正好等于目标
  const exact = new Map([
    ['VTI', { quantity: 24750 / 2100 }],
    ['510300', { quantity: 9900 / 4 }],
    ['BND', { quantity: 14850 / 490 }],
  ]);
  const flat = allocate(workedExample({ cash: 0, holdings: exact }));
  assert.equal(flat.orders.length, 0);
  assert.deepEqual(flat.skipped, []);
  assert.deepEqual(flat.warnings, []);
  assert.ok(flat.after.maxAbsDriftPp < 0.01, `最大偏离应接近 0，实际 ${flat.after.maxAbsDriftPp}`);
});

test('T37 max_orders=1 只生成 1 笔；手续费按订单收一次', () => {
  const result = allocate(workedExample({ policy: { allowSell: false, minTradeValue: 100, maxOrders: 1 } }));
  assert.equal(result.orders.length, 1);
  assert.ok(result.skipped.some((s) => s.reason === 'max_orders_reached'));
  assert.equal(result.feesTotal, 1.5, '只下一笔单就只收一次手续费');
  // 第一笔是 cn 的一手：400 + 1.5 手续费
  const only = result.orders[0];
  assert.equal(only.symbol, '510300');
  assert.equal(only.quantity, 100);
  near(result.remainingCash, 6000 - 400 - 1.5);
});

test('T38 min_trade_value=5000 时整笔低于阈值的买单被丢弃，汇总与最终订单一致', () => {
  const result = allocate(
    workedExample({ policy: { allowSell: false, minTradeValue: 5000, maxOrders: 20 } }),
  );
  for (const order of result.orders) {
    assert.ok(order.valueBase >= 5000, `${order.symbol} 的订单 ${order.valueBase} 低于阈值`);
  }
  assert.ok(result.skipped.some((s) => s.reason === 'below_min_trade'));
  // 汇总必须只反映留下的订单
  const buyTotal = result.orders.filter((o) => o.side === 'buy').reduce((a, o) => a + o.valueBase, 0);
  near(result.remainingCash, 6000 - buyTotal - result.feesTotal);
});

test('T39 首选符号持仓为 0 但类别超配 → sell_no_holdings，不产生负持仓', () => {
  const assets = {
    VTI: { classId: 'us_equity', currency: 'USD', lotSize: 1, name: 'VTI' },
    '510300': { classId: 'cn_equity', currency: 'CNY', lotSize: 100, name: '沪深300ETF' },
    BND: { classId: 'bond', currency: 'USD', lotSize: 1, name: 'BND' },
    AGG: { classId: 'bond', currency: 'USD', lotSize: 1, name: 'AGG' },
  };
  const result = allocate(
    workedExample({
      assets,
      policy: { allowSell: true, minTradeValue: 100, maxOrders: 20 },
      holdings: new Map([
        ['VTI', { quantity: 10 }],
        ['510300', { quantity: 1000 }],
        ['AGG', { quantity: 50 }], // 债券的市值都在 AGG 上，首选符号 BND 持仓为 0
      ]),
      quotes: new Map([
        ['VTI', { price: 300 }],
        ['510300', { price: 4 }],
        ['BND', { price: 70 }],
        ['AGG', { price: 70 }],
      ]),
    }),
  );
  const sellSkip = result.skipped.find((s) => s.classId === 'bond' && s.reason === 'sell_no_holdings');
  assert.ok(sellSkip, JSON.stringify(result.skipped));
  assert.equal(sellSkip.symbol, 'BND');
  for (const order of result.orders.filter((o) => o.side === 'sell')) {
    assert.ok(order.quantity > 0);
  }
  const bond = result.after.classes.find((c) => c.id === 'bond');
  assert.ok(bond.valueBase >= 0);
});

test('T40 内部不舍入：中途舍入会少买一手，本例必须买得到', () => {
  // 单价 33.333…（1/3 类），lot 1；现金刚好够 3 手但"先舍入到分"就只够 2 手
  const assets = {
    AAA: { classId: 'a', currency: 'CNY', lotSize: 1 },
  };
  const holdings = new Map([['AAA', { quantity: 0 }]]);
  const quotes = new Map([['AAA', { price: 3.3333333333333335 }]]);
  const fx = new Map([['CNY', { rateToBase: 1 }]]);
  const classes = [{ classId: 'a', targetWeight: 1, band: 0.001, preferredSymbol: 'AAA' }];
  const result = allocate({
    classes,
    assets,
    holdings,
    quotes,
    fx,
    cash: 10,
    policy: { allowSell: false, minTradeValue: 0, maxOrders: 10 },
    feesPerOrder: 0,
    baseCurrency: 'CNY',
  });
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].quantity, 3, '10 / 3.3333… = 3 手，中途舍入会只买到 2 手');
  assert.ok(result.remainingCash >= 0, '余额不能为负');
});
