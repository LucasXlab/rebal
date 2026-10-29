/**
 * 终端表格（DESIGN.md）。
 *
 * 规则：无框线、无 emoji、颜色只染状态词、数字右对齐、按显示宽度（CJK 算 2）计算列宽、
 * 窄终端按 92 / 60 列两档降级。
 */

import {
  displayWidth,
  formatDrift,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  padEndWidth,
  padStartWidth,
  truncateWidth,
} from '../util.js';

export const COLOR = Object.freeze({
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  bad: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
});

export const WIDTH_FULL = 92;
export const WIDTH_MEDIUM = 60;

/**
 * 判断是否输出颜色。
 * @param {{color: 'auto'|'always'|'never', isTty: boolean, noColor: boolean, term: string|undefined}} options
 * @returns {boolean}
 */
export function shouldUseColor(options) {
  if (options.color === 'never') return false;
  if (options.color === 'always') return true;
  if (options.noColor) return false;
  return options.isTty && Boolean(options.term);
}

/**
 * 按终端宽度决定布局档位。
 * @param {number|undefined} columns
 * @returns {'full'|'medium'|'narrow'}
 */
export function layoutFor(columns) {
  const width = Number.isFinite(columns) && columns > 0 ? columns : 100;
  if (width >= WIDTH_FULL) return 'full';
  if (width >= WIDTH_MEDIUM) return 'medium';
  return 'narrow';
}

/**
 * 一列的定义。
 * @typedef {object} Column
 * @property {string} key
 * @property {string} title
 * @property {'left'|'right'} align
 * @property {(row: any) => string} render
 * @property {string[]} [onlyIn] 只在某些布局里显示
 */

/**
 * 渲染表格（含表头与分隔线）。
 * @param {Column[]} columns
 * @param {any[]} rows
 * @param {{layout: 'full'|'medium'|'narrow'}} options
 * @returns {string[]} 每一行文本（调用方负责写出去）
 */
export function renderTable(columns, rows, options) {
  const visible = columns.filter((c) => !c.onlyIn || c.onlyIn.includes(options.layout));
  if (options.layout === 'narrow') return renderAsList(visible, rows);
  const cells = rows.map((row) => visible.map((c) => c.render(row)));
  const widths = visible.map((c, i) => Math.max(displayWidth(c.title), ...cells.map((line) => displayWidth(line[i]))));
  const header = visible.map((c, i) => (c.align === 'right' ? padStartWidth(c.title, widths[i]) : padEndWidth(c.title, widths[i])));
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1);
  const separator = '─'.repeat(totalWidth);
  const lines = [header.join('  '), separator];
  for (const line of cells) {
    lines.push(
      line
        .map((text, i) => (visible[i].align === 'right' ? padStartWidth(text, widths[i]) : padEndWidth(text, widths[i])))
        .join('  ')
        .replace(/\s+$/, ''),
    );
  }
  return lines;
}

/**
 * 窄终端降级：一行一个条目，字段用 · 分隔。
 * @param {Column[]} columns
 * @param {any[]} rows
 * @returns {string[]}
 */
function renderAsList(columns, rows) {
  return rows.map((row) => {
    const [first, ...rest] = columns;
    const head = first.render(row);
    const tail = rest
      .map((c) => `${c.title} ${c.align === 'right' ? c.render(row) : c.render(row)}`)
      .join(' · ');
    return tail ? `${head} · ${tail}` : head;
  });
}

/**
 * 标题行 + 分隔线。
 * @param {string} text
 * @param {{layout: 'full'|'medium'|'narrow', color: (token: string, text: string) => string}} options
 * @returns {string[]}
 */
export function renderTitle(text, options) {
  const width = Math.min(displayWidth(text), 100);
  if (options.layout === 'narrow') return [text];
  return [text, '─'.repeat(width)];
}

/**
 * 状态词染色（只染状态词本身）。
 * @param {string} status '越界'|'正常'|'缓存'|'done' 等
 * @param {(token: string, text: string) => string} color
 * @returns {string}
 */
export function paintStatus(status, color) {
  if (status === '越界' || status === '反向' || status === '超量') return color('bad', status);
  if (status === '缓存' || status === '部分' || status === '未执行') return color('warn', status);
  if (status === '正常' || status === '完成') return color('ok', status);
  return status;
}

/**
 * 生成一个着色函数。
 * @param {boolean} enabled
 * @returns {(token: string, text: string) => string}
 */
export function makeColor(enabled) {
  return (token, text) => {
    if (!enabled) return text;
    const code = COLOR[token];
    return code ? `${code}${text}${COLOR.reset}` : text;
  };
}

export { formatDrift, formatMoney, formatNumber, formatPercent, formatPrice, truncateWidth };
