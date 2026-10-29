import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJson } from './helpers.js';
import { fakeServer, makeProject, runCli, validToml } from './helpers.js';

/** 覆盖全部三个符号的腾讯响应。 */
const TENCENT_BODY = [
  'v_usVTI="usVTI~VTI~VTI~300~299~300~";',
  'v_usBND="usBND~BND~BND~70~69~70~";',
  'v_sh510300="sh510300~沪深300ETF~510300~4~3.98~4~";',
].join('\n');

/** 搭一套 tencent provider 的项目 + 假行情服务器。 */
async function tencentProject(t, options = {}) {
  const server = await fakeServer(() => ({ status: 200, body: TENCENT_BODY }));
  const project = makeProject(t, {
    toml: validToml({ quoteProvider: 'tencent', ...(options.toml ?? {}) }),
    env: { REBAL_QUOTE_URL: `${server.url}/q=` },
  });
  project.server = server;
  return project;
}

test('T23 第一次取行情写缓存；TTL 内第二次不再发请求', async (t) => {
  const project = await tencentProject(t);
  const first = await runCli(['status'], project, { fetch: globalThis.fetch });
  assert.equal(first.code, 0);
  assert.equal(project.server.requests.length, 1, '三个符号一次批量请求');

  const cache = readJson(path.join(project.dir, '.rebal', 'cache.json'));
  assert.equal(cache.schemaVersion, 1);
  assert.equal(cache.quotes.VTI.price, 300);
  assert.equal(cache.quotes.VTI.quoteId, 'usVTI');

  const second = await runCli(['status'], project, { fetch: globalThis.fetch });
  assert.equal(second.code, 0);
  assert.equal(project.server.requests.length, 1, 'TTL 内走缓存，不再请求');
  assert.ok(!second.stdout.includes('缓存截至'), '没过期就不该标缓存');
  await project.server.close();
});

test('T24 超过 TTL（721 分钟）后重新请求', async (t) => {
  const project = await tencentProject(t);
  await runCli(['status'], project, { fetch: globalThis.fetch });
  assert.equal(project.server.requests.length, 1);

  project.clock.advance(721 * 60_000);
  const second = await runCli(['status'], project, { fetch: globalThis.fetch });
  assert.equal(second.code, 0);
  assert.equal(project.server.requests.length, 2, 'TTL 过期要重取');
  await project.server.close();
});

test('T25 --offline 用缓存并标 stale，stdout 含"缓存截至"；无缓存时 quote_not_found', async (t) => {
  const project = await tencentProject(t);
  await runCli(['status'], project, { fetch: globalThis.fetch });
  assert.equal(project.server.requests.length, 1);

  // 离线：把 TTL 推到过期很远也要用缓存，并标出来
  project.clock.advance(30 * 24 * 3600_000);
  const offline = await runCli(['status', '--offline'], project, {
    fetch: async () => {
      throw new Error('离线模式下不该发请求');
    },
  });
  assert.equal(offline.code, 0);
  assert.match(offline.stdout, /缓存截至/);
  assert.equal(project.server.requests.length, 1, '离线不再请求');
  await project.server.close();

  // 没有缓存时离线 → quote_not_found（绝不回退到 0）
  const empty = makeProject(t, {
    toml: validToml({ quoteProvider: 'tencent' }),
    env: { REBAL_QUOTE_URL: 'http://127.0.0.1:9/q=' },
  });
  const failed = await runCli(['status', '--offline'], empty);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /quote_not_found/);
});

test('T26 缓存文件损坏时视为无缓存，重新请求且不崩溃', async (t) => {
  const project = await tencentProject(t);
  const stateDir = path.join(project.dir, '.rebal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'cache.json'), '{ 这不是 JSON', 'utf8');

  const result = await runCli(['status'], project, { fetch: globalThis.fetch });
  assert.equal(result.code, 0, '坏缓存不能让程序挂掉');
  assert.equal(project.server.requests.length, 1, '坏缓存当作没有，重新取');
  const cache = readJson(path.join(stateDir, 'cache.json'));
  assert.equal(cache.quotes.VTI.price, 300, '重新取之后要写好');
  await project.server.close();
});

test('T27 --refresh 忽略 TTL；--refresh --offline → 退出码 2 invalid_input', async (t) => {
  const project = await tencentProject(t);
  await runCli(['status'], project, { fetch: globalThis.fetch });
  assert.equal(project.server.requests.length, 1);

  const refreshed = await runCli(['prices', '--refresh'], project, { fetch: globalThis.fetch });
  assert.equal(refreshed.code, 0);
  assert.equal(project.server.requests.length, 2, '--refresh 必须重取');

  const conflict = await runCli(['prices', '--refresh', '--offline'], project, { fetch: globalThis.fetch });
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /invalid_input/);
  await project.server.close();
});
