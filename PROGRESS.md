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

## 阶段 4：验证（进行中）

- [ ] 全新 clone 安装实录 → `notes/安装实录.md`
- [ ] 10 次真实运行（含 ≥5 个异常场景）
- [ ] 3 个独立审稿子代理：正确性 / 安全与数据 / 新用户体验
- [ ] 逐条复现并修复，补回归测试，再复审

## 阶段 5：发布物料（未开始）

README、README_EN、docs/features.md、CI、CHANGELOG、LICENSE、`v0.1.0` 标签、`launch/`。
