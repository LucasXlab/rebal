/**
 * 估值与汇总（SPEC §5.6）。
 *
 * 所有金额都在本币（base currency）下；`driftPp` 的分母统一是 `targetAfterBase = totalBase + cash`。
 * `status` 传 cash = 0，`plan` 传本次要投的钱。
 */

/**
 * @typedef {object} ClassSummary
 * @property {string} classId
 * @property {number} targetWeight
 * @property {number} band
 * @property {number} valueBase
 * @property {number} targetBase
 * @property {number} driftBase
 * @property {number} driftPp
 * @property {boolean} outOfBand
 * @property {number} actualRatio
 */

/**
 * @typedef {object} SymbolValue
 * @property {string} symbol
 * @property {string} classId
 * @property {string} name
 * @property {number} quantity
 * @property {number} price
 * @property {string} currency
 * @property {number} rateToBase
 * @property {number} valueBase
 */

/**
 * @param {object} options
 * @param {import('./holdings.js').Holdings} options.holdings
 * @param {ReturnType<typeof import('./config.js').defaults>} options.config
 * @param {Map<string, {price: number}>} options.quotes
 * @param {Map<string, {rateToBase: number}>} options.fx
 * @param {number} [options.cash]
 * @returns {{baseCurrency: string, totalBase: number, targetAfterBase: number, cash: number, symbols: SymbolValue[], classes: ClassSummary[], accounts: {account: string, valueBase: number, ratio: number}[], outOfBandCount: number}}
 */
export function valuate(options) {
  const { holdings, config, quotes, fx } = options;
  const cash = options.cash ?? 0;
  const baseCurrency = config.portfolio.baseCurrency;

  /** @type {SymbolValue[]} */
  const symbols = [];
  for (const [symbol, row] of holdings.bySymbol) {
    const asset = config.assets[symbol];
    if (!asset) continue;
    const quote = quotes.get(symbol);
    if (!quote) continue;
    const rate = fx.get(asset.currency)?.rateToBase ?? 1;
    symbols.push({
      symbol,
      classId: asset.classId,
      name: asset.name || row.name || symbol,
      quantity: row.quantity,
      price: quote.price,
      currency: asset.currency,
      rateToBase: rate,
      valueBase: row.quantity * quote.price * rate,
    });
  }

  const totalBase = symbols.reduce((sum, s) => sum + s.valueBase, 0);
  const targetAfterBase = totalBase + cash;

  /** @type {ClassSummary[]} */
  const classes = Object.entries(config.targets).map(([classId, targetWeight]) => {
    const valueBase = symbols.filter((s) => s.classId === classId).reduce((sum, s) => sum + s.valueBase, 0);
    const targetBase = targetWeight * targetAfterBase;
    const driftBase = valueBase - targetBase;
    const band = config.bands.byClass[classId] ?? config.bands.default;
    const driftPp = targetAfterBase > 0 ? (driftBase / targetAfterBase) * 100 : 0;
    return {
      classId,
      targetWeight,
      band,
      valueBase,
      targetBase,
      driftBase,
      driftPp,
      outOfBand: targetAfterBase > 0 && Math.abs(driftBase) > band * targetAfterBase,
      actualRatio: targetAfterBase > 0 ? valueBase / targetAfterBase : 0,
    };
  });

  // 账户汇总：按行（而不是按符号）累计，同一符号在不同账户里各算各的
  /** @type {Map<string, number>} */
  const accountTotals = new Map();
  for (const item of holdings.items) {
    const asset = config.assets[item.symbol];
    const quote = quotes.get(item.symbol);
    if (!asset || !quote) continue;
    const rate = fx.get(asset.currency)?.rateToBase ?? 1;
    const value = item.quantity * quote.price * rate;
    accountTotals.set(item.account, (accountTotals.get(item.account) ?? 0) + value);
  }
  const accounts = [...accountTotals.entries()]
    .map(([account, valueBase]) => ({
      account,
      valueBase,
      ratio: totalBase > 0 ? valueBase / totalBase : 0,
    }))
    .sort((a, b) => b.valueBase - a.valueBase || a.account.localeCompare(b.account));

  return {
    baseCurrency,
    totalBase,
    targetAfterBase,
    cash,
    symbols,
    classes,
    accounts,
    outOfBandCount: classes.filter((c) => c.outOfBand).length,
  };
}

/**
 * 需要换算的货币（除本币外）。
 * @param {import('./holdings.js').Holdings} holdings
 * @param {ReturnType<typeof import('./config.js').defaults>} config
 * @returns {string[]}
 */
export function neededCurrencies(holdings, config) {
  const set = new Set();
  for (const [symbol, row] of holdings.bySymbol) {
    const asset = config.assets[symbol];
    if (!asset) continue;
    const currency = row.currency ?? asset.currency;
    if (currency !== config.portfolio.baseCurrency) set.add(currency);
  }
  return [...set].sort();
}
