# 进度

## 阶段 1：选题 ✅

产物：`docs/选题.md`（8 个候选、痛点证据、竞品、1–5 评分、逐项理由）。
选定：**配平 rebal** — 跨账户多币种的定投／再平衡下单清单 CLI。
记录：`notes/决定.md`（12 条关键决定）、`notes/参照.md`（19 条从 inkdove 学到并落地的做法）。

## 阶段 2：规格 ✅

产物：`SPEC.md`（唯一契约，762 行）、`DESIGN.md`（终端输出规范）、`docs/external-apis.md`（外部接口实测记录）。
审稿：4 个独立子代理做对抗式审查，23 条外部意见 + 28 条自查问题，全部修完（`notes/审稿记录.md`）。

## 阶段 3：实现 ✅

按"地基 → 一个功能一个功能"推进，每个功能带测试与文档一起提交。

| 功能 | 文件 | 测试 |
|---|---|---|
| F1 配置 | `src/config.js` | T1、T3–T8 |
| F2 持仓 | `src/holdings.js` | T9–T13 |
| F3 行情与汇率 | `src/quotes/*`、`src/fx/*` | T14–T22 |
| F4 缓存 | `src/cache.js`、`src/load.js` | T23–T27 |
| F5 估值与状态 | `src/portfolio.js`、`src/format/*` | T28–T32 |
| F6 分配算法 | `src/allocate.js` | T33–T40 |
| F7 计划与核对 | `src/plan.js` | T41–T44、T48 |
| F8 CLI 与安全 | `src/cli.js`、`bin/rebal.js` | T2、T45–T47、T49 |

- 测试：52 个用例全绿（`npm test`），覆盖 SPEC §9 的 T1–T49（另有 2 个解析/脱敏用例），
  零网络、零固定 sleep、全部临时目录。
- 偏差记录：`docs/deviations.md`（D1–D9）。
- 端到端冒烟：`rebal init --demo` → `status` → `plan --cash 6000` → `check` 全通，
  且 `plan` 的结果与 SPEC §5.8 算例逐字一致。

## 阶段 4：验证 ✅

- **全新 clone 安装实录**：`notes/安装实录.md`（clone → `npm ci` → 测试 → 按 README 走一遍，
  含本机 npm 缓存权限问题的绕过方法）。
- **真实运行记录**：`notes/真实运行记录.md`（10 个场景 / 8 个异常，输出与退出码原样粘贴）。
- **三路独立审稿**：正确性 / 安全与数据 / 新用户体验；发现的问题逐条复现后修，
  补了回归用例（T50–T57）。
- 真实运行里发现并修掉的真问题：
  1. Frankfurter 把 `api.frankfurter.app` 301 到 `.dev/v1`，默认地址已换（不跟随重定向是设计）。
  2. 腾讯行情是 GBK，http 层却按 UTF-8 解码 → 中文名称全是乱码，已按字符集解码。
  3. 把美股 `quote_id` 写进 A 股资产时，会按错误汇率静默算出订单 → 现在按前缀校验市场币种。
  4. 着色时列宽把 ANSI 转义算成可见字符 → 真终端每屏错位，已先剥转义再量宽。
  5. 终端宽度检测从未接线（不读 `COLUMNS` / `stdout.columns`）→ DESIGN 的三档降级永不触发。
  6. 订单表只给本币等值，外币单看不出在券商里该敲多少 → 金额列改用标的货币。

## 阶段 5：发布物料 ✅

- `README.md`（中文主文档，首屏是真实终端输出）、`README_EN.md`（原生英文重写）。
- `docs/features.md`（功能详解）、`docs/development.md`、`docs/deviations.md`（13 条偏差）、
  `docs/external-apis.md`（实测记录）。
- `LICENSE`（MIT）、`CHANGELOG.md`、`.env.example`（只用 `example.com`）。
- `.github/workflows/ci.yml`：三版本测试 + 跳过用例按失败处理 + 离线冒烟 + tag 发版校验版本一致。
- `launch/`：Show HN、Reddit 两版、V2EX、发布前检查清单——**写了，没发**。
- 版本 `0.1.0`，本地标签 `v0.1.0`（没有远端仓库，没有 push）。

## 完成度自查

| 要求 | 状态 |
|---|---|
| SPEC 的接口与测试要求全部实现 | ✅ 49 个规格用例 + 12 个复审回归用例，共 63 个 |
| 全部测试通过、连续三次、无跳过 | ✅ 3 × `63 pass / 0 fail / 0 skipped` |
| 全新安装能跑通 | ✅ `notes/安装实录.md` + 本轮亲自 clone 复验 |
| 没有未解决的严重审稿问题 | ✅ 三路审稿的阻断/重要项全部修完并补了回归测试 |
| README 里每个功能与数字可复现 | ✅ 两份 README 的终端输出都是真实运行结果 |

- 已知问题：见 README「已知限制」与 `docs/deviations.md`。
- 发版前需要人工做的事：见 `launch/checklist.md`。
