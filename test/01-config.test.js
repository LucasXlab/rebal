import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueList, RebalError } from '../src/errors.js';
import { loadConfig, normalizeConfig } from '../src/config.js';
import { CLEAN_ENV, makeTempDir, validToml, writeFile } from './helpers.js';

/** 从 TOML 文本直接归一化，便于不落盘的用例。 */
async function normalize(tomlText, env = CLEAN_ENV) {
  const { parse } = await import('smol-toml');
  const issues = new IssueList();
  const cfg = normalizeConfig(parse(tomlText), issues, 'rebal.toml');
  const { applyEnv } = await import('../src/config.js');
  const runtime = applyEnv(cfg, env, issues);
  return { cfg, runtime, issues };
}

/** 断言抛出的错误里包含某个机器码。 */
function expectIssue(issues, code, pathFragment) {
  const hit = issues.issues.find(
    (i) => i.code === code && (pathFragment === undefined || i.path.includes(pathFragment)),
  );
  assert.ok(hit, `期望有 ${code}（路径含 ${pathFragment}），实际：${JSON.stringify(issues.issues, null, 2)}`);
}

test('T1 合法配置能加载，targets 总和 0.999999 也接受', async (t) => {
  const dir = makeTempDir(t);
  writeFile(dir, 'rebal.toml', validToml());
  const { config, env } = loadConfig({ cwd: dir, dir, env: CLEAN_ENV });
  assert.equal(config.portfolio.name, '我的组合');
  assert.equal(config.portfolio.baseCurrency, 'CNY');
  assert.equal(config.quotes.provider, 'mock');
  assert.equal(config.fx.provider, 'static');
  assert.deepEqual(config.targets, { us_equity: 0.5, cn_equity: 0.2, bond: 0.3 });
  assert.equal(config.assets.VTI.classId, 'us_equity');
  assert.equal(config.assets['510300'].lotSize, 100);
  assert.equal(env.offline, false);

  // 总和在 1e-6 容差内接受
  const near = await normalize(
    validToml({ targets: { us_equity: 0.4999995, cn_equity: 0.2, bond: 0.3 } }),
  );
  assert.equal(near.issues.length, 0, JSON.stringify(near.issues.issues));
});

test('T3 未知顶层键报 unknown_field，一次列出全部未知键', async () => {
  const text = `${validToml()}\n[quotez]\nprovider = "mock"\n\n[polcy]\nallow_sell = true\n`;
  const { issues } = await normalize(text);
  expectIssue(issues, 'unknown_field', 'quotez');
  expectIssue(issues, 'unknown_field', 'polcy');
  assert.ok(issues.length >= 2);
});

test('T4 targets 总和 1.1 → targets_not_normalized，错误信息含实际总和', async () => {
  const { issues } = await normalize(validToml({ targets: { us_equity: 0.6, cn_equity: 0.2, bond: 0.3 } }));
  expectIssue(issues, 'targets_not_normalized', 'targets');
  const hit = issues.issues.find((i) => i.code === 'targets_not_normalized');
  assert.match(hit.message, /1\.100000/);
});

test('T5 preferred_symbol 未定义 / assets.class 不在 targets → 两条都列出来', async () => {
  const text = validToml().replace(
    '[classes.bond]\npreferred_symbol = "BND"',
    '[classes.bond]\npreferred_symbol = "NOPE"',
  ).replace('class = "bond"', 'class = "bonds"');
  const { issues } = await normalize(text);
  expectIssue(issues, 'missing_preferred_symbol', 'classes.bond');
  expectIssue(issues, 'unknown_class', 'assets.BND.class');
});

test('T6 lot_size=0、bands.default=0、timeout_ms=50 各自报错，错误信息带字段路径', async () => {
  const text = validToml({ timeoutMs: 50 })
    .replace('lot_size = 100', 'lot_size = 0')
    .replace('default = 0.03', 'default = 0');
  const { issues } = await normalize(text);
  expectIssue(issues, 'config_invalid', 'assets.510300.lot_size');
  expectIssue(issues, 'config_invalid', 'bands.default');
  expectIssue(issues, 'config_invalid', 'quotes.timeout_ms');
});

test('T7 环境变量非法 → invalid_env，列出允许值', async () => {
  const { issues } = await normalize(validToml(), {
    REBAL_QUOTE_PROVIDER: 'foo',
    REBAL_OFFLINE: 'maybe',
    REBAL_HTTP_TIMEOUT_MS: 'abc',
  });
  expectIssue(issues, 'invalid_env', 'REBAL_QUOTE_PROVIDER');
  expectIssue(issues, 'invalid_env', 'REBAL_OFFLINE');
  expectIssue(issues, 'invalid_env', 'REBAL_HTTP_TIMEOUT_MS');
  const providerIssue = issues.issues.find((i) => i.path === 'REBAL_QUOTE_PROVIDER');
  assert.match(providerIssue.message, /tencent\/csv\/mock/);
});

test('T8 只认 REBAL_ 前缀：其他变量不影响任何行为', async () => {
  const { cfg, issues } = await normalize(validToml(), {
    OPENAI_API_KEY: 'sk-should-not-be-read',
    QUOTE_PROVIDER: 'tencent',
    REBAL_OFFLINE: '1',
  });
  assert.equal(issues.length, 0, JSON.stringify(issues.issues));
  assert.equal(cfg.quotes.provider, 'mock', 'QUOTE_PROVIDER 不能覆盖 quotes.provider');
});
