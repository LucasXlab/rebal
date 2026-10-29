/**
 * 错误日志（SPEC §4.1）：`<state_dir>/last-error.log`，JSONL，保留最近 20 条，单条 ≤ 8 KB。
 * state 目录不可写时退到 `os.tmpdir()/rebal-last-error.log`，由调用方把实际路径打印到 stderr。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatIsoLocal } from './util.js';

export const MAX_ENTRIES = 20;
export const MAX_ENTRY_BYTES = 8 * 1024;

/**
 * @param {string} stateDir
 */
export function logPath(stateDir) {
  return path.join(stateDir, 'last-error.log');
}

/**
 * @param {string} tmpDir
 */
export function fallbackLogPath(tmpDir = os.tmpdir()) {
  return path.join(tmpDir, 'rebal-last-error.log');
}

/**
 * 写一条错误日志。
 * @param {object} options
 * @param {string|undefined} options.stateDir
 * @param {import('./errors.js').RebalError} options.error
 * @param {string} [options.stack] 原始异常的 stack
 * @param {string} [options.tmpDir]
 * @returns {{file: string, fellBack: boolean}}
 */
export function appendErrorLog(options) {
  const entry = {
    // 用真实时间：错误日志是给人排查用的，不该被注入的时钟影响，也不能因为时钟坏了写不进去
    time: formatIsoLocal(new Date()),
    code: options.error.code,
    exitCode: options.error.exitCode,
    message: options.error.message,
    details: options.error.issues,
  };
  if (options.stack) entry.stack = truncate(String(options.stack), MAX_ENTRY_BYTES - 1024);

  const primary = options.stateDir ? logPath(options.stateDir) : null;
  if (primary) {
    try {
      fs.mkdirSync(options.stateDir, { recursive: true });
      writeEntries(primary, entry);
      return { file: primary, fellBack: false };
    } catch {
      // 落到下面的 tmpdir
    }
  }
  const fallback = fallbackLogPath(options.tmpDir);
  try {
    writeEntries(fallback, entry);
    return { file: fallback, fellBack: true };
  } catch {
    return { file: fallback, fellBack: true };
  }
}

/**
 * 追加一条并裁剪到 20 条。读取旧文件失败时当作空文件（不让日志写坏影响主流程）。
 * @param {string} file
 * @param {object} entry
 */
function writeEntries(file, entry) {
  const line = truncate(JSON.stringify(entry), MAX_ENTRY_BYTES);
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    lines = [];
  }
  lines.push(line);
  const kept = lines.slice(-MAX_ENTRIES);
  fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
}

/**
 * @param {string} text
 * @param {number} maxBytes
 */
function truncate(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1024);
  return `${out}…(截断)`;
}

/**
 * 读回日志条目（测试与 `--verbose` 用）。
 * @param {string} file
 * @returns {any[]}
 */
export function readErrorLog(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
