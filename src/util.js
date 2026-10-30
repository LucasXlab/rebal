/**
 * 纯工具函数：金额舍入、格式化、显示宽度、时间串。
 * 这里不允许有 IO，也不读环境变量（测试要能直接断言）。
 */

/** 货币符号表（DESIGN.md 1.4）。未列出的货币用三字母 + 一个空格。 */
const CURRENCY_SYMBOLS = Object.freeze({
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  EUR: '€',
  JPY: 'JP¥',
  GBP: '£',
});

/**
 * 四舍五入到指定小数位（half-up，不用浮点 toFixed 的银行家舍入）。
 * 输入是"钱"的量级（< 1e12），先放大再取整不会丢精度。
 * @param {number} value
 * @param {number} [digits=2]
 * @returns {number}
 */
export function roundHalfUp(value, digits = 2) {
  const factor = 10 ** digits;
  const scaled = value * factor;
  // 1e-9 的补偿：0.005 * 100 = 0.49999999999999994 这种情况要进位
  const rounded = Math.floor(scaled + 0.5 + Math.sign(scaled) * 1e-9);
  return rounded / factor;
}

/** 金额：2 位小数（输出层才舍入）。 */
export function roundMoney(value) {
  return roundHalfUp(value, 2);
}

/**
 * 整数部分加千分位。
 * @param {string|number} int
 * @returns {string}
 */
export function groupInteger(int) {
  return String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * @param {number} value
 * @returns {string} 带千分位的两位小数，例如 "49,500.00"
 */
export function formatNumber(value) {
  const rounded = roundHalfUp(value, 2);
  const negative = rounded < 0 || Object.is(rounded, -0);
  const fixed = Math.abs(rounded).toFixed(2);
  const [int, frac] = fixed.split('.');
  return `${negative ? '-' : ''}${groupInteger(int)}.${frac}`;
}

/**
 * 金额 + 货币符号。
 * @param {number} value
 * @param {string} currency
 * @returns {string}
 */
export function formatMoney(value, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${formatNumber(value)}`;
}

/**
 * 单价：至少 2 位、最多 4 位小数（美股常见 2 位，港股常见 3 位）。
 * @param {number} value
 * @param {string} currency
 * @returns {string}
 */
export function formatPrice(value, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const twoDp = roundHalfUp(value, 2);
  if (Math.abs(value - twoDp) < 1e-9) return `${symbol}${formatNumber(twoDp)}`;
  const fourDp = roundHalfUp(value, 4).toFixed(4).replace(/0+$/, '');
  const body = fourDp.endsWith('.') ? `${fourDp}00` : fourDp;
  const [int, frac] = body.split('.');
  return `${symbol}${groupInteger(int)}.${frac}`;
}

/**
 * 百分比，1 位小数。
 * @param {number} ratio 0.424 → "42.4%"
 * @returns {string}
 */
export function formatPercent(ratio) {
  return `${roundHalfUp(ratio * 100, 1).toFixed(1)}%`;
}

/**
 * 偏离（百分点），带符号、1 位小数。
 * @param {number} pp -8.377 → "-8.4pp"
 * @returns {string}
 */
export function formatDrift(pp) {
  const rounded = roundHalfUp(pp, 1);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}pp`;
}

/**
 * 带符号的百分比数值（用于 JSON 之外的展示，如"目标 50.0%"）。
 * @param {number} pp
 * @returns {string}
 */
export function formatSignedPp(pp) {
  const rounded = roundHalfUp(pp, 1);
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

/**
 * 剥掉 ANSI 转义序列与 C0/C1 控制字符。
 *
 * 为什么需要：终端会把 `\x1b[2J`（清屏）、`\x1b[8m`（隐藏文字）当成指令执行。
 * 配置或 holdings.csv 一旦来自不可信来源（同事发的、从网页复制的），
 * 这些字节就能清空屏幕、隐藏真实数字、把表格挤歪。显示层一律先剥掉。
 * 换行与制表符保留（调用方自己决定要不要折行）。
 * @param {string} text
 * @returns {string}
 */
export function stripControl(text) {
  return String(text)
    // CSI（`ESC [ ... 字母`）与 OSC（`ESC ] ... BEL/ST`）
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // 其他两字符转义（ESC + 单字符）
    .replace(/\x1b[@-Z\\-_]/g, '')
    // C0（除 \n \t）与 DEL、C1
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * 是否含控制字符（含 ESC）。用于在入口拒绝，而不是显示时才修。
 * @param {string} text
 * @returns {boolean}
 */
export function hasControlChar(text) {
  return /[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(String(text));
}

/** 东半角宽度：CJK 与全角标点算 2，其余算 1。 */
export function displayWidth(text) {
  // 先剥掉 ANSI 转义：染色的状态词若被算成 13 列宽，整张表在真终端里会错位
  const plain = stripControl(text).replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * @param {number} cp
 * @returns {boolean}
 */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * 按显示宽度右侧补空格（左对齐）。
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function padEndWidth(text, width) {
  const current = displayWidth(text);
  return current >= width ? text : text + ' '.repeat(width - current);
}

/**
 * 按显示宽度左侧补空格（右对齐）。
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function padStartWidth(text, width) {
  const current = displayWidth(text);
  return current >= width ? text : ' '.repeat(width - current) + text;
}

/**
 * 截断到指定显示宽度，超出用 … 结尾。
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function truncateWidth(text, width) {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of String(text)) {
    const w = displayWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/**
 * 本地时间 "YYYY-MM-DD HH:mm"。
 * @param {Date} date
 * @returns {string}
 */
export function formatLocalDateTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}`
  );
}

/**
 * ISO 8601 带本地时区偏移，例如 "2026-10-29T21:44:12-04:00"。
 * @param {Date} date
 * @returns {string}
 */
export function formatIsoLocal(date) {
  const p = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/**
 * 计划 ID：本地时间的 ISO 串，冒号换成 "-"，得到
 * "2026-10-29T21-45-00-04-00"（SPEC 3.6）。
 * @param {Date} date
 * @returns {string}
 */
export function formatPlanId(date) {
  const p = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T` +
    `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}-${p(abs % 60)}`
  );
}

/**
 * 解析"钱"：只接受十进制数字串，返回 number（不抛异常，返回 null 表示非法）。
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(text)) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/** 三个大写字母的货币码。 */
export function isCurrencyCode(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

/** 行情源里的代码/证券代码（SPEC 2.3 规则 5、2.4）。 */
export function isSymbolCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,16}$/.test(value);
}
