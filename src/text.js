/**
 * 文本解码。腾讯行情返回 GBK，其余接口是 UTF-8。
 *
 * Node 官方构建带 full-icu，`TextDecoder('gbk')` 可用；自定义 small-icu 构建里
 * 取不到 gbk 解码器时退化到 latin1 —— 价格与数字都是 ASCII，不受影响，
 * 只是中文名称显示不出来，不会因此算错钱。
 */

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeGbk(bytes) {
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/**
 * 按字符集解码。charset 只接受 'utf8' 与 'gbk'。
 * @param {Uint8Array} bytes
 * @param {'utf8'|'gbk'} [charset]
 * @returns {string}
 */
export function decodeBody(bytes, charset = 'utf8') {
  return charset === 'gbk' ? decodeGbk(bytes) : new TextDecoder('utf-8').decode(bytes);
}
