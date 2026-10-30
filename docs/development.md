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
src/load.js         把"读配置 → 取价 → 估值"串成一个上下文，各命令共用
src/quotes/         行情：tencent / csv / mock
src/fx/             汇率：frankfurter / static / mock
src/portfolio.js    估值、按类别汇总、偏离
src/allocate.js     整数分配算法（纯函数，无 IO）
src/plan.js         计划生成、保存、读回、核对
src/cache.js        行情/汇率缓存（TTL）
src/http.js         带超时、重试、大小上限的 fetch 封装
src/text.js         文本解码（腾讯是 GBK，其余 UTF-8）
src/log.js          --verbose / REBAL_LOG_LEVEL 的日志
src/error-log.js    错误日志（JSONL，保留 20 条，不可写时退化到临时目录）
src/format/         终端表格与状态输出
src/templates.js    init 写出的配置与持仓模板
src/version.js      版本号（CI 会校验 tag 三者一致）
src/errors.js       错误码与退出码
```

测试按功能分文件，编号对应 SPEC §9 的用例号：

```
test/01-config.test.js           T1、T3–T8
test/02-holdings.test.js         T9–T13
test/03-allocate.test.js         T33–T40
test/04-quotes.test.js           T14–T22
test/05-cache.test.js            T23–T27
test/06-status.test.js           T28–T32
test/07-plan.test.js             T41–T44、T48
test/08-cli.test.js              T2、T45–T47、T49
test/09-review-regression.test.js 复审发现的问题的回归用例（T50–T57）
```

加回归用例的规矩：**先用一条命令或一个 `/tmp` 下的脚本把问题复现出来**，再写成测试，最后修代码。
顺序反了就会写出"测了个假东西"的用例。测试名要写清"什么输入 → 什么结果"，不要写 `test1`、`works`。

## 改代码的规矩

1. 先改 `SPEC.md`，再改代码。代码与规格不一致时以规格为准；实现不了的按"最简单能跑通"
   处理，并在 `docs/deviations.md` 加编号条目。
2. 每个功能一个提交：代码 + 测试 + 文档一起。
3. 提交信息写用户能感知的行为和关键数字，不写"重构一下"。
4. 不引入需要联网运行的新依赖；外部接口必须先写进 `docs/external-apis.md`（含核实日期）。
