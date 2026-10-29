/**
 * 错误码与退出码的唯一定义处。
 * 码表与 SPEC.md §4.1 一一对应；新增码必须先改 SPEC。
 */

export const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  INPUT: 2,
  EXTERNAL: 3,
  NO_RESULT: 4,
});

/** 退出码 2：配置、参数或输入文件错误。 */
const INPUT_CODES = new Set([
  'usage',
  'invalid_input',
  'invalid_env',
  'config_not_found',
  'config_exists',
  'config_invalid',
  'init_dir_unwritable',
  'unknown_field',
  'invalid_class_id',
  'targets_not_normalized',
  'missing_preferred_symbol',
  'unknown_class',
  'holdings_not_found',
  'holdings_too_large',
  'holdings_missing_column',
  'holdings_invalid',
  'unknown_symbol',
  'currency_conflict',
  'too_many_symbols',
  'plan_not_found',
  'plan_corrupt',
  'state_dir_unwritable',
  'mock_fixture_invalid',
  'cash_required',
]);

/** 退出码 3：外部依赖失败。 */
const EXTERNAL_CODES = new Set([
  'quote_not_found',
  'quote_invalid',
  'quote_http_error',
  'quote_rate_limited',
  'fx_not_found',
  'fx_invalid',
  'fx_http_error',
  'fx_rate_limited',
  'network_error',
  'network_redirect',
  'timeout',
  'response_too_large',
]);

/** 退出码 4：命令成功但没有可执行结果，或 --strict 判定失败。 */
const NO_RESULT_CODES = new Set(['no_actionable_orders', 'strict_failed']);

/**
 * 按机器码返回退出码。未知码一律视为内部错误（1），
 * 避免"新加的码忘了登记"变成静默的退出码 0。
 * @param {string} code
 * @returns {number}
 */
export function exitCodeFor(code) {
  if (code === 'internal_error') return EXIT.INTERNAL;
  if (INPUT_CODES.has(code)) return EXIT.INPUT;
  if (EXTERNAL_CODES.has(code)) return EXIT.EXTERNAL;
  if (NO_RESULT_CODES.has(code)) return EXIT.NO_RESULT;
  return EXIT.INTERNAL;
}

/** 一次校验里发现的所有问题，最后统一抛出。 */
export class IssueList {
  constructor() {
    /** @type {{code: string, path: string, message: string}[]} */
    this.issues = [];
  }

  /**
   * @param {string} code 机器码
   * @param {string} path 字段路径或文件名:行号
   * @param {string} message 中文说明
   */
  add(code, path, message) {
    this.issues.push({ code, path, message });
  }

  get length() {
    return this.issues.length;
  }

  /** 按加入顺序（= 规则编号顺序）取第一条的码。 */
  firstCode() {
    return this.issues.length > 0 ? this.issues[0].code : null;
  }

  /**
   * 抛出一个带全部问题的错误；没有问题时不抛。
   * 第一行永远是最具体的那句话，其余问题放 details（人读时逐行列出）。
   */
  throwIfAny() {
    if (this.issues.length === 0) return;
    const first = this.issues[0];
    const head =
      this.issues.length === 1
        ? first.message
        : `${first.message}（共 ${this.issues.length} 个问题）`;
    throw new RebalError(first.code, head, { issues: this.issues });
  }
}

/** 带机器码的错误。`details` 结构化为 {path, message} 数组。 */
export class RebalError extends Error {
  /**
   * @param {string} code 机器码（见 SPEC §4.1）
   * @param {string} message 中文一句话说明
   * @param {{issues?: {code?: string, path: string, message: string}[], cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'RebalError';
    this.code = code;
    /** @type {{path: string, message: string}[]} */
    this.issues = (opts.issues ?? []).map((i) => ({ path: i.path, message: i.message }));
  }

  get exitCode() {
    return exitCodeFor(this.code);
  }

  /** 机器可读的错误对象（SPEC §4.8）。 */
  toJSON() {
    return {
      error: this.message,
      code: this.code,
      details: this.issues.map((i) => ({ path: i.path, message: i.message })),
    };
  }
}

/**
 * 把任意异常收敛成 RebalError。非 RebalError 一律是内部错误。
 * @param {unknown} err
 * @returns {RebalError}
 */
export function asRebalError(err) {
  if (err instanceof RebalError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new RebalError('internal_error', message, { cause: err });
  return wrapped;
}
