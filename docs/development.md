# 开发

## 环境

- Node.js ≥ 20.11.0（`engines` 里写死；CI 跑 20、22、24 三个版本）
- npm ≥ 9
- 没有数据库、没有需要编译的原生依赖

## 装依赖

```bash
npm ci          # 按 package-lock.json 装；两个依赖：smol-toml、csv-parse
```

如果本机 npm 缓存目录不可写（会报 `EACCES: permission denied, mkdir '~/.npm'`），
临时换一个缓存目录即可，不影响仓库：

```bash
npm ci --cache /tmp/npm-cache
```

## 跑测试

```bash
npm test                       # 全部用例
node --test test/02-holdings.test.js   # 单个文件
```

测试约定（SPEC §9）：

- 不联网：所有外部接口都用 `test/helpers.js` 里的假 HTTP 服务器或 `provider=mock`。
- 不用固定 sleep：等待用 `waitFor(条件)` 轮询，时钟用 `makeClock()` 注入。
- 不写用户真实目录：每个用例 `makeTempDir()` 建临时目录，结束自动删。
- 出现偶发失败必须查根因，不允许加重试或跳过用例。

## 目录

```
bin/rebal.js        入口，只做 process.exitCode = await run(argv)
src/cli.js          参数解析、命令分发、统一输出与退出码
src/config.js       rebal.toml 解析与校验（一次报全）
src/holdings.js     持仓 CSV 解析、列映射、多账户合并
src/quotes/         行情：tencent / csv / mock
src/fx/             汇率：frankfurter / static / mock
src/portfolio.js    估值、按类别汇总、偏离
src/allocate.js     整数分配算法（纯函数，无 IO）
src/plan.js         计划生成、保存、读回、核对
src/cache.js        行情/汇率缓存（TTL）
src/http.js         带超时、重试、大小上限的 fetch 封装
src/format/         终端表格与 JSON 输出
src/errors.js       错误码与退出码
```

## 改代码的规矩

1. 先改 `SPEC.md`，再改代码。代码与规格不一致时以规格为准；实现不了的按"最简单能跑通"
   处理，并在 `docs/deviations.md` 加编号条目。
2. 每个功能一个提交：代码 + 测试 + 文档一起。
3. 提交信息写用户能感知的行为和关键数字，不写"重构一下"。
4. 不引入需要联网运行的新依赖；外部接口必须先写进 `docs/external-apis.md`（含核实日期）。
