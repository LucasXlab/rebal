/**
 * `status` 与 `prices` 的人类可读输出（SPEC §5.10、§4.6，DESIGN 2.x）。
 */

import {
  formatDrift,
  formatLocalDateTime,
  formatMoney,
  formatPercent,
  formatPrice,
} from '../util.js';
import { makeColor, paintStatus, renderTable, renderTitle } from './table.js';

/**
 * @param {object} options
 * @param {import('../portfolio.js').ClassSummary[]} options.classes
 * @param {{baseCurrency: string, totalBase: number, accounts: any[]}} options.portfolio
 * @param {string} options.portfolioName
 * @param {{quotes: Map<string, any>, fx: Map<string, any>, offline: boolean}} options.market
 * @param {{layout: 'full'|'medium'|'narrow', color: (t: string, s: string) => string}} options.render
 * @param {string[]} options.warnings
 * @param {number[]} options.extra 需要写出去的附加行（提示）
 * @returns {string}
 */
export function renderStatus(options) {
  const { classes, portfolio, market, render, warnings } = options;
  const { color } = render;
  const lines = [];

  lines.push(
    `${options.portfolioName} · 本币 ${portfolio.baseCurrency} · 总市值 ${formatMoney(portfolio.totalBase, portfolio.baseCurrency)}`,
  );

  const quoteTimes = [...market.quotes.values()].map((q) => q.fetchedAt);
  const fxEntries = [...market.fx.entries()].filter(([currency]) => currency !== portfolio.baseCurrency);
  const fxTimes = fxEntries.map(([, f]) => f.fetchedAt);
  const quoteSources = [...new Set([...market.quotes.values()].map((q) => sourceLabel(q.source, q.provider)))];
  const fxSources = [...new Set(fxEntries.map(([, f]) => sourceLabel(f.source)))];
  if (quoteTimes.length > 0) {
    const fxText = fxEntries.length > 0 ? ` · 汇率 ${newestTime(fxTimes)}（${fxSources.join('、')}）` : '';
    lines.push(color('dim', `行情 ${newestTime(quoteTimes)}（${quoteSources.join('、')}）${fxText}`));
  }
  lines.push('');

  if (portfolio.totalBase === 0) {
    lines.push('还没有持仓');
  } else {
    const columns = [
      { key: 'class', title: '资产类别', align: 'left', render: (r) => r.label },
      { key: 'target', title: '目标', align: 'right', render: (r) => formatPercent(r.targetWeight) },
      { key: 'actual', title: '当前', align: 'right', render: (r) => formatPercent(r.actualRatio) },
      { key: 'drift', title: '偏离', align: 'right', render: (r) => formatDrift(r.driftPp) },
      { key: 'band', title: '带宽', align: 'right', render: (r) => `${(r.band * 100).toFixed(1)}pp` },
      { key: 'status', title: '状态', align: 'left', render: (r) => paintStatus(r.outOfBand ? '越界' : '正常', color) },
    ];
    const rows = classes.map((c) => ({ ...c, label: c.classId }));
    lines.push(...renderTable(columns, rows, { layout: render.layout }));
    lines.push('');

    const accountColumns = [
      { key: 'account', title: '账户', align: 'left', render: (r) => r.account },
      { key: 'value', title: `市值(${portfolio.baseCurrency})`, align: 'right', render: (r) => formatMoney(r.valueBase, portfolio.baseCurrency).replace(/^[^\d-]+/, '') },
      { key: 'ratio', title: '占比', align: 'right', render: (r) => formatPercent(r.ratio) },
    ];
    if (portfolio.accounts.length > 1 || portfolio.accounts[0]?.account !== 'default') {
      lines.push(...renderTable(accountColumns, portfolio.accounts, { layout: render.layout }));
      lines.push('');
    }
  }

  if (warnings.length > 0) {
    lines.push(color('warn', '警告'));
    for (const warning of warnings.slice(0, 5)) lines.push(`  ${warning}`);
    if (warnings.length > 5) lines.push(`  还有 ${warnings.length - 5} 条警告`);
    lines.push('');
  }

  const outOfBand = classes.filter((c) => c.outOfBand);
  if (portfolio.totalBase > 0) {
    if (outOfBand.length > 0) {
      lines.push(
        color('dim', `提示：${outOfBand.length} 个类别越界。运行 rebal plan --cash <金额> 看这笔钱怎么买。`),
      );
    } else {
      lines.push(color('dim', '提示：全部在带宽内，这期可以不操作。'));
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * `prices` 的人类可读输出。
 * @param {object} options
 * @param {Map<string, any>} options.quotes
 * @param {Map<string, any>} options.fx
 * @param {string} options.baseCurrency
 * @param {{layout: 'full'|'medium'|'narrow'}} options.render
 * @returns {string}
 */
export function renderPrices(options) {
  const { quotes, fx, baseCurrency, render } = options;
  const lines = [];
  const quoteColumns = [
    { key: 'symbol', title: '代码', align: 'left', render: (r) => r.symbol },
    { key: 'price', title: '价格', align: 'right', render: (r) => formatPrice(r.price, r.currency) },
    { key: 'currency', title: '货币', align: 'left', render: (r) => r.currency },
    { key: 'source', title: '来源', align: 'left', render: (r) => sourceLabel(r.source, r.provider) },
    { key: 'fetchedAt', title: '获取时间', align: 'left', render: (r) => formatLocalDateTime(new Date(r.fetchedAtMs)) },
    { key: 'fresh', title: '状态', align: 'left', render: (r) => (r.stale ? '缓存' : '新') },
  ];
  const rows = [...quotes.entries()].map(([symbol, q]) => ({ symbol, ...q }));
  lines.push(...renderTable(quoteColumns, rows, { layout: render.layout }));
  lines.push('');

  const fxColumns = [
    { key: 'currency', title: '货币', align: 'left', render: (r) => r.currency },
    { key: 'rate', title: `汇率(→${baseCurrency})`, align: 'right', render: (r) => r.rateToBase.toFixed(4) },
    { key: 'source', title: '来源', align: 'left', render: (r) => sourceLabel(r.source) },
    { key: 'fetchedAt', title: '获取时间', align: 'left', render: (r) => formatLocalDateTime(new Date(r.fetchedAtMs)) },
    { key: 'fresh', title: '状态', align: 'left', render: (r) => (r.stale ? '缓存' : '新') },
  ];
  const fxRows = [...fx.entries()]
    .filter(([currency]) => currency !== baseCurrency)
    .map(([currency, f]) => ({ currency, ...f }));
  lines.push(...renderTable(fxColumns, fxRows, { layout: render.layout }));
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * 行情来源的中文标签（DESIGN 2.3 的固定词表）。
 * @param {string} source
 * @param {string} [provider]
 */
export function sourceLabel(source, provider) {
  switch (source) {
    case 'tencent':
      return '腾讯行情';
    case 'csv':
      return 'CSV';
    case 'mock':
      return '示例数据';
    case 'override':
      return '自报价';
    case 'static':
      return '静态';
    case 'frankfurter':
      return 'Frankfurter';
    case 'base':
      return '本币';
    default:
      return provider ?? source;
  }
}

/**
 * 取最新时间并格式化。
 * @param {string[]} times
 */
function newestTime(times) {
  const newest = times.filter(Boolean).sort().at(-1);
  if (!newest) return '未知时间';
  const date = new Date(newest);
  return Number.isNaN(date.getTime()) ? newest : formatLocalDateTime(date);
}

export { makeColor };
