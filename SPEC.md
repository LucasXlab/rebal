# 配平 rebal — 规格（v0.1.0）

`rebal` 是一个命令行工具：读一份持仓表（CSV）和一份配置（TOML），取当日行情与汇率，
算出「这次这笔钱该买哪只、买几股」，并给出执行后的组合偏离；下一期再核对上一期的
计划有没有执行到位。

**第一版只做这一条核心流程：**

```
rebal init --demo            # 生成一份可离线跑通的示例配置与持仓
rebal status                 # 当前各类资产的比例、偏离、是否越界
rebal plan --cash 3000       # 这笔钱怎么买：订单清单 + 执行后的偏离
rebal check                  # 上期计划执行了没有
```

**非目标（v0.1.0 明确不做）：**

1. 不连接券商、不自动下单、不读券商账号密码；只输出清单。
2. 不给投资建议：目标比例、买卖什么，全部由用户在配置里写死；工具只做算术。
3. 不计算收益率、回撤、夏普、归因，也不做回测；那是组合分析工具的事。
4. 不支持分数股：只按整股或整手（`lot_size`）下单。
5. 不把现金作为资产类别参与配平（见 8.3）。
6. 不按账户分别设目标比例；账户只用于汇总和展示。
7. 不写 GUI，不跑常驻服务，不提供 HTTP 接口。
8. 不调用大模型，不需要任何 API key。
9. 不做税损收割（tax-loss harvesting）、不做洗售（wash sale）判定。
10. 不内置任何券商的 CSV 格式预设；靠配置里的列名映射。

**本文件是唯一契约。** 代码、测试、README 与本文件不一致时以本文件为准；实现不了的
按"最简单、能跑通"处理，并在 `docs/deviations.md` 编号记录。

---

## 1. 目录与技术栈

```
rebal/
  package.json          Node ESM，bin: rebal，version 0.1.0
  bin/rebal.js          入口：只做 process.exitCode = await run(argv)
  src/
    cli.js              参数解析、命令分发、统一退出码
    config.js           rebal.toml 解析与校验
    holdings.js         holdings.csv 读取、列映射、校验
    quotes/             行情：tencent.js、csv.js、mock.js、index.js
    fx/                 汇率：frankfurter.js、static.js、mock.js、index.js
    portfolio.js        估值、按资产类别汇总、偏离计算
    allocate.js         整数分配算法（纯函数，无 IO）
    plan.js             计划生成、保存、读回、对比
    cache.js            行情/汇率缓存（TTL）
    http.js             带超时、重试、大小上限、错误映射的 fetch 封装
    format/             table.js（人类可读）、json.js（机器可读）
    errors.js           RebalError、错误码与退出码映射
    version.js
  fixtures/             内置 mock 数据（随包发布）：quotes.mock.json、fx.mock.json
  test/                 node:test，49 个用例，见第 9 节
  docs/                 features.md、development.md、deviations.md、external-apis.md
  rebal.toml            示例配置（init 生成的模板）
  .env.example
```

- **运行环境**：Node.js **≥ 20.11.0**（需要稳定的 `fetch` 与 `node:util` 的 `parseArgs`）；macOS、Linux、Windows（PowerShell 与 Git Bash）可用。不需要编译工具、不需要数据库、不需要 Docker。
- **依赖（版本固定，均为纯 JS、无原生模块）**：
  - `smol-toml` **1.9.1** — TOML 解析；
  - `csv-parse` **7.0.3** — CSV 解析（带行号错误）。
  - 其余全部用 Node 内置模块（`node:fs`、`node:http`/`fetch`、`node:path`、`node:util`、`node:crypto`、`node:test`）。
- **安装**：
  - 发布后：`npm install -g rebal`；
  - 当前版本（未发布）：`git clone <repo> && cd rebal && npm ci && npm link`；
  - 一次性运行：`npx --yes . plan --cash 3000`（在仓库目录内）。
- **本地状态目录**：默认 `<当前目录>/.rebal/`，可用 `REBAL_STATE_DIR` 覆盖。里面只有两类文件：`cache.json`（行情与汇率缓存）和 `plans/*.json`（历史计划）。
- **不读取任何非 `REBAL_` 前缀的环境变量**：除 `NO_COLOR` 与 `TZ` 外，其他前缀的变量一律不读（`OPENAI_API_KEY`、`QUOTE_PROVIDER` 之类即使设置了也不产生任何影响，测试 T8）。不读 `HTTP_PROXY`/`HTTPS_PROXY`：代理要走 `REBAL_QUOTE_URL` 指向自建代理。

## 2. 配置

### 2.1 环境变量

只允许读下表中的变量。未列出的 `REBAL_*` 变量一律忽略并在 `--verbose` 下打一行
「忽略未知变量」。`REBAL_*` 之外的变量只读 `NO_COLOR` 与 `TZ`。

| 变量 | 默认 | 必填 | 非法时 |
|---|---|---|---|
| `REBAL_CONFIG` | `<dir>/rebal.toml` | 否 | 文件不存在 → 退出码 2，`config_not_found`，提示运行 `rebal init` |
| `REBAL_HOLDINGS` | 取配置里的 `holdings.path` | 否 | 文件不存在 → 退出码 2，`holdings_not_found`，信息里带路径 |
| `REBAL_STATE_DIR` | `<dir>/.rebal` | 否 | 无法创建或不可写 → 退出码 2，`state_dir_unwritable` |
| `REBAL_QUOTE_PROVIDER` | 取配置 `quotes.provider` | 否 | 不在 `tencent|csv|mock` → 退出码 2，`invalid_env`，`error` 里列出允许值 |
| `REBAL_FX_PROVIDER` | 取配置 `fx.provider` | 否 | 不在 `frankfurter|static|mock` → 退出码 2，`invalid_env` |
| `REBAL_OFFLINE` | `0` | 否 | 只接受 `0/1/true/false`，否则退出码 2，`invalid_env` |
| `REBAL_HTTP_TIMEOUT_MS` | 取配置 `quotes.timeout_ms` | 否 | 不是 100–60000 的整数 → 退出码 2，`invalid_env` |
| `REBAL_CACHE_TTL_MINUTES` | 取配置 `quotes.ttl_minutes` | 否 | 不是 0–10080 的整数 → 退出码 2，`invalid_env` |
| `REBAL_LOG_LEVEL` | `warn` | 否 | 不在 `error|warn|info|debug` → 退出码 2，`invalid_env` |
| `REBAL_QUOTE_URL` | `https://qt.gtimg.cn/q=` | 否 | 不是 `https://` 或 `http://127.0.0.1` 开头的 URL → 退出码 2，`invalid_env` |
| `REBAL_FX_URL` | `https://api.frankfurter.app` | 否 | 同上 |
| `REBAL_MOCK_QUOTES_FILE` | `<包目录>/fixtures/quotes.mock.json` | 否 | 不存在或 JSON 不合法 → 退出码 2，`mock_fixture_invalid` |
| `REBAL_MOCK_FX_FILE` | `<包目录>/fixtures/fx.mock.json` | 否 | 同上 |
| `NO_COLOR` | 未设置 | 否 | 只要存在（任意值）就不输出 ANSI 颜色 |
| `TZ` | 系统时区 | 否 | 非法时由 Node 自行回退到 UTC；所有时间戳按此变量格式化 |

取值优先级：命令行参数 > 环境变量 > `rebal.toml` > 内置默认值。例如 `--cash` 优先于
`contribution.amount`；`REBAL_QUOTE_PROVIDER` 优先于 `quotes.provider`。

- 任何日志、错误信息、`--json` 输出里，都不得出现密钥明文。v0.1.0 本身不需要任何密钥；为防以后加入，`http.js` 统一对 URL 中的 `token`、`key`、`api_key`、`secret` 查询参数打码为 `***`（测试 T41）。
- `REBAL_QUOTE_URL` 与 `REBAL_FX_URL` 只用于测试与自建代理；默认值是唯一会在正常使用中访问的主机。

### 2.2 `rebal.toml`

```toml
[portfolio]
name = "我的组合"              # 字符串，1–60 字符，默认 "我的组合"
base_currency = "CNY"         # 三个大写字母，默认 "CNY"

[contribution]
amount = 3000                 # 本币金额，≥0，默认不设置（此时 plan 必须带 --cash）

[policy]
allow_sell = false            # 布尔，默认 false
min_trade_value = 100         # 本币金额，0–1e9，默认 100
max_orders = 20               # 整数 1–100，默认 20

[quotes]
provider = "tencent"          # tencent | csv | mock
price_file = "prices.csv"     # provider=csv 时必填
ttl_minutes = 720             # 0–10080
timeout_ms = 8000             # 100–60000
retries = 2                   # 0–5

[fx]
provider = "frankfurter"      # frankfurter | static | mock
[fx.static]                   # provider=static 时必填，至少包含所有非本币
USD = 7.10
HKD = 0.91

[fees]
per_order = 1.5               # 本币金额，≥0，默认 0

[holdings]
path = "holdings.csv"
account_column = "account"    # 空字符串表示该列不存在
symbol_column = "symbol"
quantity_column = "quantity"
currency_column = "currency"  # 空字符串表示不用 CSV 里的货币列
price_column = "price"        # 空字符串表示不用 CSV 里的价格覆盖列
name_column = "name"

[targets]
us_equity = 0.50              # 每项 0–1，总和必须 = 1（容差 1e-6）
cn_equity = 0.20
bond = 0.30

[bands]
default = 0.03                # 0.0001–0.5，单位是"个百分点的小数"，0.03 = 3pp
us_equity = 0.02              # 可选，按类别覆盖

[classes.us_equity]
preferred_symbol = "VTI"      # 必填；买入该类时只买这一只

[assets.VTI]
class = "us_equity"           # 必填，必须是 targets 里的某个键
name = "Vanguard Total Stock Market ETF"
currency = "USD"              # 必填，三个大写字母
quote_id = "usVTI"            # 行情源里的代码；不填则用 symbol
lot_size = 1                  # 整数 1–1000000
```

### 2.3 校验规则（一次报全，不是遇到第一个就停）

`rebal` 在任何命令开始前校验配置与持仓；发现问题时**一次性列出全部问题**，每条格式为
`<文件>:<行号或字段路径>: <问题>（期望 …，实际 …）`，退出码 2，机器码取第一条问题的码。
未知字段（拼错的键）视为错误 `unknown_field`：静默忽略拼错的键会让用户以为配置生效了。

具体规则：

1. 顶层只允许 `portfolio`、`contribution`、`policy`、`quotes`、`fx`、`fees`、`holdings`、`targets`、`bands`、`classes`、`assets` 十一个表；其他键报 `unknown_field`。**每个表的内部同样只允许本文列出的键**，多出来的键（拼写错误）一律报 `unknown_field`，错误路径写到二级，例如 `quotes.providerr`。
2. `targets` 的键必须匹配 `[a-z0-9_]{1,40}`，否则 `invalid_class_id`；每个值必须是 0–1 的数字；`|总和 - 1| ≤ 1e-6` 接受，严格大于 1e-6 报 `targets_not_normalized`，错误信息里给出实际总和（保留 6 位小数）。
3. 每个 `targets` 的键必须在 `classes` 里有 `preferred_symbol`；`preferred_symbol` 必须在 `assets` 里定义。报 `missing_preferred_symbol`。
4. 每个 `assets.*.class` 必须是 `targets` 的键；报 `unknown_class`。
5. `assets.*.currency` 必须是三个大写字母；`quote_id` 必须是 `[A-Za-z0-9._-]{1,16}`；`lot_size` 必须是 1–1000000 的整数。
6. `bands` 的每个值必须在 0.0001–0.5 之间（含端点）；`bands.default` 必填。
7. `quotes.provider=csv` 时 `price_file` 必填、文件存在且表头包含 `symbol,price,currency,as_of` 四列，否则 `config_invalid`；`fx.provider=static` 时 `fx.static` 必须覆盖持仓里出现的所有非本币，且每个键是三个大写字母。
8. `bands` 的键只允许 `default` 与 `targets` 里出现的类别；`classes` 的键同样只允许 `targets` 里的类别，多出来报 `unknown_class`。
9. `quotes.provider` 不在 `tencent|csv|mock`、`fx.provider` 不在 `frankfurter|static|mock`、`quotes.retries` 不在 0–5、`quotes.ttl_minutes` 不在 0–10080，报 `config_invalid`，信息里列出允许值或范围。
10. `policy.max_orders` 必须是 1–100 的整数；`policy.min_trade_value` 与 `fees.per_order` 必须是 0–1e9 的数字；`contribution.amount` 必须是 0–1e9 的数字。
11. `holdings` 里非空的列名不得重复（空字符串表示该列不启用，可以重复出现）；`symbol_column`、`quantity_column` 不得为空字符串。
12. 退出码 2 的错误不写缓存、不写计划文件；有问题的字段全部列完后一次退出，不进入下一步。

### 2.4 持仓 CSV

- 编码 UTF-8（带不带 BOM 都行），分隔符 `,`，第一行是表头，单元格可带双引号（RFC 4180）。
- 文件 ≤ 5 MB，数据行 ≤ 5000；超出报 `holdings_too_large`。
- 每行字段：
  - `symbol`：`[A-Za-z0-9._-]{1,16}`，读入后转大写；
  - `quantity`：十进制数字，> 0，最多 6 位小数，≤ 1e12；
  - `account`（可选列）：1–40 字符，为空时记为 `default`；
  - `currency`（可选列）：三个大写字母，填写后覆盖 `assets.*.currency`；
  - `price`（可选列）：> 0 的十进制数字，填写后覆盖行情（视为"用户自报价"，不再请求行情源）；
  - `name`（可选列）：0–80 字符。
- 同一 `symbol` 出现在多行（不同账户）时合并求和；`currency` 冲突（两行填了不同的）报 `currency_conflict`，错误信息带符号名与两个值。
- 同一 `symbol` 多行都填了 `price` 且数值不同：取第一行的非空值，并在 `warnings` 里写「<符号> 多行价格不一致，取第一行」；不影响退出码。
- 持仓股数不要求是 `lot_size` 的整数倍（券商可能给出非整手持仓）；卖出时按 `lot_size` 向下取整，买入只按 `lot_size` 的倍数。
- 空行忽略；多余列忽略。**必需列**（`symbol_column`、`quantity_column`）缺失报 `holdings_missing_column`；**可选列**（`account`/`currency`/`price`/`name` 对应列名非空）在 CSV 里不存在时，视为该列未提供，不报错。
- 持仓里出现的每个 `symbol` 必须在 `assets` 里定义，否则报 `unknown_symbol`，错误信息里带行号和该符号。
- `assets` 里定义了但没有持仓的标的：允许，估值按 0 处理。
- 只有表头、没有数据行：允许，`totalBase = 0`，`status` 输出全 0 与一句 `还没有持仓`；`plan` 按目标比例把现金分配出去。
- 缓存与 TTL 一律用毫秒时间差判断，不用日期字符串，因此跨时区、跨日不会错判。

## 3. 数据模型

所有金额内部用浮点数计算，**输出时四舍五入到 2 位小数（half-up）**；比较用 1e-9 容差。

### 3.1 Holding

| 字段 | 类型 | 取值 / 约束 | 说明 |
|---|---|---|---|
| symbol | string | 大写，`[A-Z0-9._-]{1,16}` | 唯一键（与账户无关，汇总用） |
| account | string | 1–40 字符，默认 `default` | 只用于展示 |
| quantity | number | > 0，≤ 1e12，6 位小数 | 股数 |
| currency | string | ISO 4217 三字母 | 来自 CSV 覆盖列或 `assets` |
| priceOverride | number \| null | > 0 | CSV 的 `price` 列 |
| name | string | 0–80 字符 | 展示用 |

### 3.2 Asset

| 字段 | 类型 | 取值 / 约束 |
|---|---|---|
| symbol | string | 配置键名 |
| class | string | `targets` 的键之一 |
| name | string | 0–80 字符，默认 = symbol |
| currency | string | 三字母 |
| quoteId | string | `[A-Za-z0-9._-]{1,16}`，默认 = symbol |
| lotSize | integer | 1–1000000，默认 1 |

### 3.3 Class（资产类别，来自 `targets`）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 配置键名，1–40 字符，`[a-z0-9_]+` |
| targetWeight | number | 0–1 |
| band | number | 0.0001–0.5，`bands.<id>` 或 `bands.default` |
| preferredSymbol | string | 必须存在于 `assets` |

### 3.4 Quote

| 字段 | 类型 | 说明 |
|---|---|---|
| symbol | string | 大写的资产符号 |
| price | number | > 0，行情源给出的原生货币价格 |
| currency | string | 三字母 |
| fetchedAt | string | ISO 8601 带时区偏移，缓存写入时间 |
| source | `"tencent" \| "csv" \| "mock" \| "override"` | `override` 表示来自 CSV 的 price 列 |

### 3.5 FxRate

| 字段 | 类型 | 说明 |
|---|---|---|
| currency | string | 三字母 |
| rateToBase | number | > 0；**1 单位该货币 = `rateToBase` 单位本币** |
| fetchedAt | string | ISO 8601 |
| source | `"frankfurter" \| "static" \| "mock"` | |

### 3.6 Plan（计划文件，`.rebal/plans/<planId>.json`）

```json
{
  "schemaVersion": 1,
  "planId": "2026-10-29T21-45-00-04-00",
  "createdAt": "2026-10-29T21:45:00-04:00",
  "toolVersion": "0.1.0",
  "baseCurrency": "CNY",
  "cash": 6000,
  "policy": {"allowSell": false, "minTradeValue": 100, "maxOrders": 20},
  "pricesAsOf": {"VTI": "2026-10-29T21:44:12-04:00", "BND": "2026-10-29T21:44:12-04:00", "510300": "2026-10-29T21:44:12-04:00"},
  "snapshot": [
    {"symbol": "VTI", "quantity": 10, "accounts": {"ibkr": 10}},
    {"symbol": "BND", "quantity": 50, "accounts": {"ibkr": 50}},
    {"symbol": "510300", "quantity": 1000, "accounts": {"futu": 1000}}
  ],
  "orders": [
    {"symbol": "510300", "side": "buy", "classId": "cn_equity", "quantity": 900,
     "lotSize": 100, "unitPrice": 4, "currency": "CNY", "fxRate": 1,
     "value": 3600, "valueBase": 3600, "feeBase": 1.5},
    {"symbol": "VTI", "side": "buy", "classId": "us_equity", "quantity": 1,
     "lotSize": 1, "unitPrice": 300, "currency": "USD", "fxRate": 7,
     "value": 300, "valueBase": 2100, "feeBase": 1.5}
  ],
  "skipped": [{"classId": "bond", "reason": "overweight_no_sell"}],
  "warnings": ["债券超配 14.15pp，本次不卖出，可用 --sell 配平"],
  "before": {"totalBase": 49500, "classes": [{"id": "us_equity", "valueBase": 21000, "targetBase": 27750, "driftBase": -6750, "driftPp": -12.16, "outOfBand": true}]},
  "after": {"totalBase": 55497, "maxAbsDriftPp": 14.15, "classes": [...]},
  "remainingCash": 297,
  "feesTotal": 3
}
```

`skipped[].reason` 只有这几个值：`overweight_no_sell`（超配、本次不允许卖出）、`lot_too_expensive`（最小一手买不起）、`max_orders_reached`（订单数到 `max_orders`）、`fee_exceeds_cash`（够买一手但不够付手续费）、`sell_below_min_trade`、`sell_no_holdings`（首选符号持仓不够）、`below_min_trade`（整笔成交额低于 `min_trade_value`，下单被丢弃）。
`warnings[]` 是与 `skipped` 一一对应的中文句子（每个 `skipped` 一条），外加"使用缓存"这类提示。

`planId` 格式：`YYYY-MM-DDTHH-mm-ss-ZZ-ZZ`（本地时间的 ISO 8601，冒号换成 `-`）。
同秒内重复生成时追加 `-2`、`-3`（上限 `-9`，超过则等 1 秒）。
`.rebal/plans/latest.json` 是最近一次计划的副本，`rebal check` 读它。

### 3.7 Cache（`.rebal/cache.json`）

```json
{"schemaVersion": 1,
 "quotes": {"VTI": {"price": 300, "currency": "USD", "fetchedAt": "2026-10-29T21:44:12-04:00", "source": "tencent", "provider": "tencent", "quoteId": "usVTI"}},
 "fx": {"USD": {"rateToBase": 7, "fetchedAt": "2026-10-29T21:44:12-04:00", "source": "static"}}}
```

- 命中条件：`provider` 与 `quoteId`（汇率是 `currency` 与 `source`）一致，且 `now - fetchedAt <= ttl_minutes × 60000`。
- 文件损坏、`schemaVersion` 不是 1、单个条目字段缺失：只丢弃该条目，按未命中处理，不报错（测试 T26）。
- 写入用临时文件 + `rename` 原子替换；写失败只写一行 `warn` 日志，不影响本次结果。

`after.totalBase` 就是 5.6 的 `afterTotalBase`（含未花完的现金、已扣手续费）。

### 3.8 CheckReport

```json
{
  "schemaVersion": 1,
  "planId": "...",
  "checkedAt": "...",
  "items": [
    {"symbol": "VTI", "side": "buy", "planned": 3, "actual": 3, "status": "done"},
    {"symbol": "510300", "side": "buy", "planned": 1800, "actual": 1000, "status": "partial"}
  ],
  "unplanned": [{"symbol": "BND", "delta": -5}],
  "summary": {"done": 1, "partial": 1, "pending": 0, "over": 0, "reversed": 0, "unplanned": 1}
}
```

`status` 取值与判定（`delta = actual - planned`，容差 1e-6）：

| status | 条件 |
|---|---|
| `done` | `|delta| <= 1e-6` |
| `partial` | `0 < actual < planned`（买入）或 `0 > actual > planned`（卖出，`actual` 为负） |
| `pending` | `actual == 0`（容差内） |
| `over` | `actual > planned`（买入）或 `actual < planned`（卖出） |
| `reversed` | 方向相反（买入计划下 `actual < 0`，卖出计划下 `actual > 0`） |

`unplanned`：当前持仓相对计划快照的变化里，没有出现在 `orders` 里的符号（比如用户自己手买了别的）。
计划里的符号在当前持仓里不存在（被改名或清仓）→ `actual = 0`，按上表判为 `pending`；新出现的符号进 `unplanned`。

## 4. 命令行接口

所有命令都接受 `--dir <path>`（在该目录下找 `rebal.toml`、`holdings.csv`，状态目录默认 `<dir>/.rebal`；默认当前目录）、`--config <path>`、`--holdings <path>`、`--state-dir <path>`、`--json`、
`--offline`、`--color auto|always|never`、`--verbose`、`--quiet`。
布尔参数只有两种写法：`--flag` 开启、`--no-flag` 关闭；不接受 `--flag=false`、`--flag false`，
出现时按 `usage`（退出码 2）处理。

### 4.1 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含"无需操作"） |
| 1 | 内部错误（未预期的异常，打印 stack 到 stderr 与 `.rebal/last-error.log`） |
| 2 | 配置、参数或输入文件错误（`config_*`、`invalid_*`、`unknown_*`、`holdings_*`、`usage`） |
| 3 | 外部依赖失败（`quote_*`、`fx_*`、`network_*`、`timeout`） |
| 4 | 命令成功执行但没有可执行结果，或 `--strict` 判定失败（`no_actionable_orders`、`strict_failed`） |

全部机器码与退出码（实现时集中放在 `src/errors.js`，测试 T46 逐条断言）：

| 退出码 | 机器码 |
|---|---|
| 2 | `usage`、`invalid_input`、`invalid_env`、`config_not_found`、`config_exists`、`config_invalid`、`unknown_field`、`invalid_class_id`、`targets_not_normalized`、`missing_preferred_symbol`、`unknown_class`、`holdings_not_found`、`holdings_too_large`、`holdings_missing_column`、`holdings_invalid`、`unknown_symbol`、`currency_conflict`、`too_many_symbols`、`plan_not_found`、`plan_corrupt`、`state_dir_unwritable`、`mock_fixture_invalid`、`cash_required` |
| 3 | `quote_not_found`、`quote_invalid`、`quote_http_error`、`quote_rate_limited`、`fx_not_found`、`fx_invalid`、`network_error`、`network_redirect`、`timeout`、`response_too_large` |
| 4 | `no_actionable_orders`、`strict_failed` |
| 1 | `internal_error` |

### 4.2 `rebal init`

创建一个可运行的目录：`rebal.toml`、`holdings.csv`、`prices.csv`（`provider=csv` 时用）。

- 参数：`--dir <path>`（同全局选项，默认当前目录）、`--demo`（写入示例数据并把 `quotes.provider` 设为 `mock`）、`--force`（覆盖已存在文件）。
- 行为：目标文件任一已存在且没有 `--force` → 退出码 2，`config_exists`，列出冲突文件。
- 写出的文件：`rebal.toml`、`holdings.csv`；只有 `quotes.provider=csv` 时才写 `prices.csv`。`--demo` 写 `rebal.toml`（两个 provider 均为 `mock`）与 `holdings.csv`。
- stdout（成功）：每个创建的文件一行 `已创建 <相对路径>`，最后一行 `下一步：rebal status`。
- `--json`：`{"ok":true,"created":["rebal.toml","holdings.csv"]}`。
- 失败情况：目录不可写 → 退出码 2 `state_dir_unwritable`；`--demo` 的模板必须能在无网络下跑通。

### 4.3 `rebal status`

- 参数：`--strict`（有任一类别越界时退出码 4）。
- 取值：读配置 → 读持仓 → 取行情与汇率（见第 5 节）→ 汇总。
- stdout（人类可读）见 5.10；`--json` 输出 `{"schemaVersion":1,"baseCurrency":"CNY","totalBase":49500,"classes":[...],"accounts":[...],"quotes":[{"symbol":"VTI","price":300,"currency":"USD","fetchedAt":"...","stale":false,"source":"tencent"}],"fx":[...],"warnings":[...]}`。
- 持仓为空时，标题下打印一行 `还没有持仓`，表格部分不打印，退出码 0。
- 失败情况：行情缺失 → 退出码 3 `quote_not_found`，`error` 里列出取不到的符号；汇率缺失 → `fx_not_found`；全部在缓存且 `--offline` 时用缓存并在 `warnings` 里写「使用缓存，截至 …」。

### 4.4 `rebal plan`

核心命令。

- 参数：`--cash <amount>`（本币，≥0，≤1e9；缺省时用 `contribution.amount`，两者都没有 → 退出码 2 `cash_required`）、`--sell` / `--no-sell`（本次允许或禁止卖出，覆盖 `policy.allow_sell`；`--no-sell` 用于配置里默认允许卖出的情况）、`--no-save`（不写计划文件、不清理旧计划）。
- 行为：见第 5 节算法；成功后写 `.rebal/plans/<planId>.json` 与 `latest.json`，并按 5.9 清理旧计划。
- stdout：订单表格 + 合计 + 执行后偏离 + 计划文件路径（见 5.11）。
- `--json`：输出 Plan 对象（3.6）。
- 退出码：有 ≥1 笔订单 → 0，并按 5.9 写计划文件；0 笔订单（现金太少、已达目标、只有越界但禁止卖出且无法用现金补）→ 4 `no_actionable_orders`，**不写计划文件**，但 `--json` 仍输出完整 Plan（`orders: []`）。
- 失败情况：见第 6 节风险表与 4.1 退出码；行情缺失 `quote_not_found`(3)、汇率缺失 `fx_not_found`(3)、现金参数非法 `invalid_input`(2)、配置错误(2)。

### 4.5 `rebal check`

- 参数：`--plan <planId|latest>`（默认 `latest`）、`--strict`（有任一订单不是 `done` 时退出码 4）、`--json`。
- 行为：读计划 → 读当前持仓 → 聚合比较 → 输出。
- stdout：每笔计划订单一行（计划/实际/状态），`unplanned` 列表，汇总一行。
- 失败情况：计划文件不存在 → 退出码 2 `plan_not_found`，提示「先运行 rebal plan」；计划文件损坏（JSON 不合法或 `schemaVersion` 不是 1）→ 退出码 2 `plan_corrupt`。
- 退出码：0；`--strict` 且未全部 `done` → 4 `strict_failed`。

### 4.6 `rebal prices`

- 参数：`--refresh`（忽略 TTL 重新取）、`--offline`、`--json`。
- 行为：打印当前会使用的行情与汇率（含来源、获取时间、是否过期），不写计划。
- stdout：

```
代码    价格        货币   来源       获取时间              状态
VTI     $300.00     USD    腾讯行情   2026-10-29 21:44      新
日期    汇率(→CNY)  来源    获取时间              状态
USD     7.0000     静态    2026-10-29 00:00      新
```
  状态词固定两个：`新`（TTL 内）、`缓存`（超过 TTL 或 `--offline`）；取不到的符号不打印，直接报错。
- 失败情况同 `status`。`--refresh` 与 `--offline` 同时给出 → 退出码 2 `invalid_input`（互相矛盾）。

### 4.7 `rebal version` / `rebal help [command]`

- `rebal version` → 一行 `rebal 0.1.0`；`--json` → `{"name":"rebal","version":"0.1.0"}`。
- `rebal help` → 用法总览，退出码 0；`rebal help plan` → 该命令的参数与退出码。
- 未知命令或未知参数 → 退出码 2 `usage`，stderr 两行：`rebal: error: 未知命令 "foo"`、`提示：rebal help 查看全部命令`。

### 4.8 输出约定

- 人类可读内容（含警告）写 stdout；只有错误写 stderr。`--quiet` 抑制 stdout 里的警告段，`--json` 时警告进 `warnings` 字段。
- `--json` 时 stdout 只有**一个** JSON 对象（成功或错误），诊断信息全部走 stderr。
- `--verbose` 等价于 `REBAL_LOG_LEVEL=info`：stderr 增加请求次数、缓存命中、耗时；`REBAL_LOG_LEVEL=debug` 再加脱敏后的 URL 与响应前 200 字符。`--quiet` 等价于 `REBAL_LOG_LEVEL=error` 并隐藏 stdout 的提示行。
- 错误对象：`{"error":"<中文一句话>","code":"<机器码>","details":[{"path":"quotes.provider","message":"…"}]}`；`details` 可为空数组。
- 人类可读错误固定三段：第一行 `rebal: error: <哪里错了>`；若有对方返回的内容，第二行 `  对方返回：HTTP 503 <原文前 200 字符>`；最后一行 `  怎么办：<可执行的动作>`（例如 `换用 --offline 读取缓存，或稍后重试`）。
- 颜色只用于状态词（`越界` 红、`正常` 绿、`缓存` 黄），正文与表头不染色；`NO_COLOR` 存在、`--color never` 或非 TTY 时不输出 ANSI。

## 5. 核心流程与算法

### 5.1 一次运行的数据流

1. 解析参数 → 校验配置与持仓（一次报全）→ 2. 解析行情（缓存/网络/覆盖）→ 3. 解析汇率 → 4. 估值与汇总 → 5. 生成订单（纯函数）→ 6. 计算执行后偏离 → 7. 输出 → 8. 写计划文件（`plan` 才有）。

任何一步失败都按第 4.1 的退出码结束，且不写计划文件。

### 5.2 行情解析（`src/quotes/index.js`）

对每个持仓符号：

1. CSV 有 `price` 列 → 用该价格，`source=override`，不查缓存、不发请求。
2. 缓存命中（同一 provider、同一 `quote_id`、`now - fetchedAt <= ttl_minutes`）→ 用缓存，`stale=false`。
3. `--offline` 或有 `REBAL_OFFLINE=1`：只用缓存（忽略 TTL，`stale=true`），缺失则退出码 3 `quote_not_found`。
4. 否则请求行情源：
   - `provider=tencent`：GET `REBAL_QUOTE_URL` + 逗号分隔的 `quote_id`，每批最多 50 个；一次运行最多 200 个不同符号（超出报 `too_many_symbols`），因此最多 4 批，批与批之间至少间隔 1000 ms；响应按 5.3 解析。
   - `provider=csv`：读 `price_file`（表头 `symbol,price,currency,as_of`），缺失符号 → `quote_not_found`。
   - `provider=mock`：读 `REBAL_MOCK_QUOTES_FILE`，按 `quote_id` 查；缺失 → `quote_not_found`。
   - 成功写入缓存；失败按 5.4 重试，最终失败 → 退出码 3。
5. 每个符号的价格必须 > 0，否则 `quote_invalid`。

### 5.3 腾讯行情响应解析（`quotes/tencent.js`）

响应是 GBK 编码的 JS 变量赋值，一行一个符号：`v_usVTI="200~…~378.24~…";`。

- 按 `;` 分行、按 `v_<quote_id>="` 提取内容，再按 `~` 分段；**第 4 段（下标 3）是当前价**。
- 内容为空、没有匹配行、第 4 段不是正数 → 该符号 `quote_not_found`。
- 货币不在响应里取，一律用 `assets.*.currency` 或 CSV 覆盖列（已在配置校验阶段保证存在）。
- 解码：先用 `TextDecoder("gbk")`；Node 内置 ICU 不保证支持 GBK 时（`TextDecoder` 抛 `RangeError`）回退到按 Latin-1 读并把已知价格段按 ASCII 解析（价格与数字都是 ASCII，中文名不参与计算）。
- 响应体 > 1 MB 直接中止 → `response_too_large`。

### 5.4 HTTP 约定（`src/http.js`）

- 超时：`quotes.timeout_ms`（默认 8000），从发起到读完响应体计时。
- 重试：`quotes.retries`（默认 2，最多 5 次尝试），只对网络错误、HTTP 429、HTTP 5xx 重试；退避 **500 ms、1500 ms**（固定值，不加随机抖动，便于测试）。
- 4xx（429 除外）不重试，直接失败，错误信息带状态码与响应体前 200 字符。
- 不跟随重定向（`redirect: "manual"`）；3xx 视为失败 `network_redirect`，错误信息给出 `Location`。
- 并发度固定为 1（不并行）；单个请求最多 3 次尝试（首次 + 2 次重试）；一次运行最多 15 次 HTTP 尝试（4 批行情 × 3 + 1 次汇率 × 3）。

### 5.5 汇率（`src/fx/index.js`）

- 本币对自身 `rateToBase = 1`。
- `provider=static`：`[fx.static]` 里 `1 单位外币 = rateToBase 单位本币`。
- `provider=frankfurter`：GET `${REBAL_FX_URL}/latest?from=<base>&to=<其余货币逗号分隔>`；响应的 `rates[CUR]` 是"1 单位本币 = 多少 CUR"，因此 `rateToBase = 1 / rates[CUR]`；缺失货币 → `fx_not_found`。缓存与 TTL 规则同行情。
- `provider=mock`：读 `REBAL_MOCK_FX_FILE`。
- 汇率 > 0，否则 `fx_invalid`。

### 5.6 估值与汇总（`src/portfolio.js`）

- `valueBase(symbol) = quantity × price × fxRate(currency)`。
- `totalBase = Σ valueBase`；`classValue(c) = Σ` 该类别下所有符号。
- `targetAfterBase = totalBase + cash`；`targetValue(c) = targetWeight(c) × targetAfterBase`。`status` 没有 `cash`，视为 0；`plan` 用 `--cash`。
- `driftBase(c) = classValue(c) - targetValue(c)`；`driftPp(c) = driftBase(c) / targetAfterBase × 100`。
- `outOfBand(c) = |driftPp(c)| / 100 > band(c)`（严格大于；等于不算越界，测试 T29）。
- 账户汇总按 `account` 分组求和。

执行后的口径（只在 `plan` 里用）：`afterTotalBase = totalBase + cash - feesTotal`，即"把没花完的现金和手续费都算进去的期末总资产"；执行后的目标值按 `afterTotalBase` 重算，`afterDriftPp(c) = (执行后类别市值 - targetWeight(c) × afterTotalBase) / afterTotalBase × 100`。

### 5.7 生成订单（`src/allocate.js`，纯函数）

输入：`classes[]`（含 targetWeight、band、preferredSymbol）、`assets`、`holdings`、`prices`、`fx`、`cash`、`policy{allowSell,minTradeValue,maxOrders}`、`fees.perOrder`。
输出：`orders[]`、`skipped[]`、`warnings[]`、`after` 汇总。

1. `targetAfterBase = 总市值 + cash`；算每类的 `driftBase`、`outOfBand`。
2. **卖出阶段**（仅 `allowSell` 为真）：对每个 `driftBase > band × targetAfterBase` 的类别，卖出金额 `s = driftBase`；数量 `q = floor(s / (price × fx) / lotSize) × lotSize`，且 `q ≤ 该首选符号的持仓量`；`q = 0` 或成交额 `< minTradeValue` 时跳过，`skipped` 记 `sell_below_min_trade` 或 `sell_no_holdings`。卖出所得 `q × price × fx - perOrder` 加入可用现金。同一符号只产生一笔卖单。
3. **买入阶段**：维护 `plannedValue(c)`，初值 = `classValue(c) - 已卖出金额`；`need(c) = targetValue(c) - plannedValue(c)`。
   可用现金 `budget = cash + 卖出净额`。循环直到无进展或 `max_orders` 用尽（`max_orders` 是卖单与买单的总数上限）：
   - 候选 = 所有 `need(c) > 1e-9` 的类别；按 `need` 降序、同值按 `id` 升序排序；
   - 取第一个买得起的：`lotCost = price(preferred) × fx × lotSize`，若该类尚无订单还要加 `perOrder`；条件 `lotCost + 新增手续费 ≤ budget`；
   - 买一手：该符号订单数量 `+= lotSize`，`budget -= lotCost + 新增手续费`，`plannedValue(c) += lotCost`；
   - 若一个都买不起，结束循环。
4. 汇总 `after`：把订单应用到持仓快照上（买入加、卖出减），按 5.6 的"执行后口径"重算各类别市值与偏离；`feesTotal` 是本次全部订单的手续费之和，`remainingCash = cash + 卖出所得 - 买入金额 - feesTotal`。
5. 对结束后仍 `outOfBand` 的类别写 `warnings`，区分原因：`overweight_no_sell`（超配但不允许卖出）、`lot_too_expensive`（最小一手都买不起）、`max_orders_reached`、`fee_exceeds_cash`（现金够买一手但不够付手续费）。
6. 丢弃整笔成交额 `< minTradeValue` 的**买单**：把这些订单从 `orders` 里去掉、现金退回 `budget`、该类记 `skipped` 原因 `below_min_trade`；卖单已在第 2 步按同一阈值过滤。
7. 订单排序：卖单在前、买单在后，各自按 `classId` 升序、再按 `symbol` 升序（确定性输出）。
8. 所有金额四舍五入到 2 位小数；`quantity` 为整数（`lotSize` 的倍数）。

### 5.8 已验证的算例（测试必须逐字复现）

配置：本币 CNY，`fx.static = {USD = 7}`，`fees.per_order = 1.5`，`min_trade_value = 100`，
`max_orders = 20`，`bands.default = 0.03`；类别 `us_equity 0.50 / cn_equity 0.20 / bond 0.30`；
首选符号 `us_equity→VTI`、`cn_equity→510300`、`bond→BND`；`510300.lot_size = 100`。
持仓：VTI 10 股 @ $300，BND 50 股 @ $70，510300 1000 股 @ ¥4.00。
现金：¥6000。

总市值 `T = 21000 + 24500 + 4000 = 49500`；`T_after = 55500`；
目标值 `us 27750 / cn 11100 / bond 16650`；偏离 `us -6750 / cn -7100 / bond +7850`。

**（a）默认不卖出**：订单 **BUY 510300 × 900（¥3600）、BUY VTI × 1（¥2100）**，手续费 ¥3.00，
剩余现金 ¥297.00，`afterTotalBase = 49500 + 6000 - 3 = 55497`，
执行后偏离 `us -8.38pp / cn -6.31pp / bond +14.15pp`（`maxAbsDriftPp = 14.15`），
仍越界，`skipped` 记 `{"classId":"bond","reason":"overweight_no_sell"}`。退出码 **0**（有订单）。

**（b）`--sell`**：订单 **SELL BND × 16（¥7840）、BUY 510300 × 1800（¥7200）、BUY VTI × 3（¥6300）**，
手续费 ¥4.50，剩余现金 ¥335.50，`afterTotalBase = 55495.5`，
执行后偏离 `us -0.81pp / cn +0.18pp / bond +0.02pp`，全部在带内（`maxAbsDriftPp = 0.81`）。退出码 **0**。

算例的精确推导（两个子例都由 `allocate()` 单测逐字段断言，测试 T33、T34）：
- (a) 可用现金 6000；先买 `cn` 一手（400 + 1.5 手续费）、再买 `us` 一手（2100 + 1.5）、
  之后每手只扣 400 或 2100（手续费只收一次），共买入 510300 × 900、VTI × 1，
  余额 6000 - 3600 - 2100 - 3 = 297 < 400，停止。
- (b) 卖出 `bond`：`floor(7850 / 490 / 1) × 1 = 16` 股，得 7840 - 1.5；
  可用现金 13838.5；轮转买入 510300 × 1800（7200）、VTI × 3（6300），余额 13838.5 - 13500 - 3 = 335.5 < 400，停止。

### 5.9 计划文件

- 写：先写临时文件 `<planId>.json.tmp`，`fs.renameSync` 原子替换；`latest.json` 同样原子替换。任一步失败时删除临时文件、保留旧文件、退出码 2 `state_dir_unwritable`，并把原因写进 `.rebal/last-error.log`。
- 清理：保留最近 **52** 个计划文件（按 `planId` 排序），多出的删除；`latest.json` 不参与计数。
- 读取：`check --plan <id>` 只接受 `[A-Za-z0-9._-]{1,64}`，防止路径穿越；找不到 → `plan_not_found`。
- `plan --no-save` 不写文件、不清理。

### 5.10 人类可读输出（`status`）

```
我的组合 · 本币 CNY · 总市值 ¥49,500.00
行情 2026-10-29 21:44（腾讯行情）· 汇率 2026-10-29（Frankfurter）

资产类别   目标    当前    偏离      带宽   状态
美股       50.0%  42.4%   -7.6pp   3.0pp  越界
A股        20.0%   8.1%  -11.9pp   3.0pp  越界
债券       30.0%  49.5%  +19.5pp   3.0pp  越界

账户         市值(CNY)   占比
ibkr       45,500.00    91.9%
futu        4,000.00     8.1%

提示：3 个类别越界。运行 rebal plan --cash 3000 看这笔钱怎么买。
```

百分比保留 1 位小数；偏离用带符号的 `pp`；`状态` 用 `越界`/`正常` 两词。

### 5.11 人类可读输出（`plan`，按 100 列终端）

```
本次投入 ¥6,000.00（不卖出，只买）

方向  代码    名称                       类别     股数     价格      金额(CNY)  手续费
买入  510300  沪深300ETF                 A股       900    ¥4.00     3,600.00    1.50
买入  VTI     Vanguard Total Stock ETF   美股        1  $300.00     2,100.00    1.50

合计 2 笔 · 买入 ¥5,700.00 · 手续费 ¥3.00 · 剩余现金 ¥297.00
执行后  美股 -8.38pp · A股 -6.31pp · 债券 +14.15pp
警告    债券超配 14.15pp，本次不卖出；加 --sell 可以配平

计划已保存 .rebal/plans/2026-10-29T21-45-00-04-00.json
下期核对 rebal check
```

## 6. 风险与防护

| 风险 | 防护 | 测试 |
|---|---|---|
| 卖出造成意外的税务事件 | 默认 `allow_sell=false`，卖出必须显式 `--sell`；`plan` 只输出清单，从不连券商 | T24、T25 |
| 行情取不到时用 0 或旧价悄悄算出错误订单 | 价格缺失直接 `quote_not_found` 退出码 3，绝不回退到 0；缓存过期在输出里标 `缓存` 并进 `warnings` | T14、T16、T18 |
| 缓存过期导致按几周前的价格下单 | `ttl_minutes` 默认 720；超 TTL 必须重新请求；`--offline` 用缓存时在 stdout 明确写"缓存截至 …" | T17、T18 |
| 汇率方向搞反（乘除颠倒） | 3.5 与 5.5 明确定义"1 单位外币 = rateToBase 本币"；单测用 USD→CNY 双向对照 | T15 |
| 非法配置被静默接受 | 未知字段报错；一次报全；退出码 2 且不写缓存/计划 | T3、T4、T5 |
| 覆盖用户文件 | `init` 已存在文件时必须 `--force`；计划文件原子替换；从不写 `holdings.csv` | T2、T33 |
| 路径穿越（`check --plan ../../etc/passwd`） | planId 白名单正则 | T34 |
| 计划文件损坏后崩溃 | 读回时校验 `schemaVersion` 与必填字段，坏了报 `plan_corrupt` 而不是抛异常 | T35 |
| 巨型响应拖死进程 | 响应体 ≤ 1 MB，超了中止 | T20 |
| 网络错误信息里带密钥 | 统一打码 `token/key/api_key/secret` 查询参数；日志不打印完整请求头 | T41 |
| 币种冲突导致市值错算 | 同一符号不同币种直接报 `currency_conflict` | T10 |
| 结果不可复现（浮点/顺序） | 订单排序规则固定；金额统一四舍五入到 2 位；同秒计划 ID 递增 | T26、T27 |
| 依赖被投毒 | 只两个纯 JS 依赖，版本固定，`npm ci` 按 lockfile 安装；`npm audit` 在 CI 里跑 | — |

## 7. Mock 与离线

- `REBAL_QUOTE_PROVIDER=mock` + `REBAL_FX_PROVIDER=mock`：所有价格与汇率来自 `fixtures/*.json`，**不发起任何网络请求**（测试用假 HTTP 服务器断言零请求）。
- mock 行为规则：完全查表，无随机数；缺失符号 → `quote_not_found`；fixture 里的 `fetchedAt` 固定为 `2026-01-01T00:00:00+00:00`。
- `rebal init --demo` 生成的配置把两个 provider 都设为 `mock`，因此 `rebal init --demo && cd <dir> && rebal plan --cash 3000` 在断网机器上也能得到固定结果（README 的第一个演示就用它）。
- `--offline` 不等于 mock：离线仍用真实 provider 的名字，只读缓存。

## 8. 其他约定

### 8.1 时间与本地化

- 时间戳一律 ISO 8601 带本地时区偏移（如 `2026-10-29T21:45:00-04:00`）。
- 日期比较用毫秒时间戳，不用字符串。
- 所有面向用户的文案用简体中文；机器码、JSON 字段用英文。

### 8.2 数值显示

- 金额：千分位逗号、2 位小数、带本币符号（`¥`、`$`、`HK$`、`€`；未知货币用 `CUR ` 前缀）。
- 百分比：1 位小数；偏离：1 位小数 + `pp`；股数：整数分千分位。

### 8.3 不建模现金的理由

现金余额在券商侧每天变化，让用户维护只会带来错误数据；目标比例只对证券。需要现金仓位的
用户把货币基金/短债 ETF 作为一个资产类别。见 `notes/决定.md` 第 8 条。

## 9. 测试要求

全部用例在 `node:test` 下跑，用临时目录、mock provider、假 HTTP 服务器和注入时钟；**不联网**。
连续跑 3 遍必须全绿。用例共 49 条，编号即测试名的一部分（`test/…` 里写成 `T12 …`）。

**F1 配置（T1–T8）**
- T1 合法配置能加载，`targets` 总和 0.999999 也接受。
- T2 `init` 创建三个文件；已存在时无 `--force` 返回 2 `config_exists` 并列出冲突文件。
- T3 未知顶层键报 `unknown_field`，一次列出全部未知键。
- T4 `targets` 总和 1.1 → `targets_not_normalized`，错误信息含实际总和。
- T5 `preferred_symbol` 未定义 / `assets.class` 不在 targets → `missing_preferred_symbol` / `unknown_class`，两条同时出现时都列出来。
- T6 `lot_size=0`、`bands.default=0`、`timeout_ms=50` 各自报错，错误信息带字段路径。
- T7 环境变量非法（`REBAL_QUOTE_PROVIDER=foo`、`REBAL_OFFLINE=maybe`、`REBAL_HTTP_TIMEOUT_MS=abc`）→ 退出码 2 `invalid_env`，列出允许值。
- T8 只认 `REBAL_` 前缀：设置 `OPENAI_API_KEY`、`QUOTE_PROVIDER` 不影响任何行为（断言配置对象里没有读到）。

**F2 持仓（T9–T13）**
- T9 正常 CSV（含 BOM、引号字段、空行）解析正确；同一符号多账户合并求和。
- T10 同一符号两行币种冲突 → `currency_conflict`，错误带符号与两个币种。
- T11 缺 `quantity` 列 → `holdings_missing_column`，带行号。
- T12 未知符号 → `unknown_symbol`，带行号与符号；数量为 0 或负数 → `holdings_invalid`。
- T13 5001 行 → `holdings_too_large`；6 MB 文件 → 同上（不读完整文件，按大小先判）。

**F3 行情与汇率（T14–T22）**
- T14 tencent 解析：多符号一次取回，第 4 段是价格；空内容/缺行 → `quote_not_found`。
- T15 汇率方向：USD→CNY 用 `1/rates[USD]`，断言 7.0 与 0.142857 两个方向都对。
- T16 行情源返回 500 → 重试 2 次后 `quote_http_error`（错误含 HTTP 503 与响应体前 200 字符）；断言总共 3 次请求。
- T17 429 → 重试 2 次后 `quote_rate_limited`；断言退避为 500 ms、1500 ms（注入时钟，不真的等）。
- T18 4xx（403）不重试，1 次请求后失败。
- T19 超时 → `timeout`，消息含超时毫秒数；注入一个永不响应的服务器。
- T20 响应体 2 MB → `response_too_large`。
- T21 302 重定向 → `network_redirect`，错误含 Location，不跟随。
- T22 CSV provider 与 mock provider 各自能取到价格；csv 文件缺符号 → `quote_not_found`；mock 模式下断言假 HTTP 服务器收到的请求数为 0。

**F4 缓存（T23–T27）**
- T23 第一次取行情写缓存；第二次（TTL 未到）不再发请求（假服务器请求数 1）。
- T24 超过 TTL 后重新请求（注入时钟推进 721 分钟）。
- T25 `--offline` 用缓存并标 `stale=true`，stdout 含"缓存截至"；无缓存时 `quote_not_found`。
- T26 缓存文件损坏（非法 JSON）时视为无缓存，重新请求，不崩溃。
- T27 `--refresh` 忽略 TTL；`--refresh --offline` → 退出码 2 `invalid_input`。

**F5 估值与状态（T28–T32）**
- T28 多币种估值：USD 持仓按 7.0 折算，总市值与各类占比与手算一致（容忍 0.01）。
- T29 偏离与 `outOfBand` 判定：`|driftPp| > band×100` 才算越界，等于时不算。
- T30 `status --strict` 有越界 → 退出码 4；全部在带内 → 0。
- T31 `status --json` 的字段集合与 4.3 一致（逐字段断言，含 `stale`、`source`）。
- T32 账户汇总：同账户多符号求和；`account` 为空的行记为 `default`。

**F6 计划算法（T33–T40）**
- T33 算例 (a) 逐字段复现 5.8（订单、数量、金额、手续费、剩余现金、执行后偏离、`skipped` 原因）。
- T34 算例 (b) `--sell` 逐字段复现 5.8。
- T35 现金太少（¥50，最小一手 ¥400）→ 0 笔订单，退出码 4 `no_actionable_orders`，`--json` 仍输出 `orders: []` 与 `warnings` 含 `lot_too_expensive`。
- T36 已经配平（偏离都在带内、cash=0）→ 0 笔订单，退出码 4。
- T37 `max_orders=1` 时只生成 1 笔订单（卖单与买单合计 ≤ 1），`skipped` 含 `max_orders_reached`；手续费按订单收一次，不会因为手续费被重复计入而少买一手（断言 `budget` 余额与手算一致）。
- T38 `min_trade_value=5000` 时小额买单被过滤（`sell_below_min_trade` / 买入跳过），不会生成低于阈值的订单。
- T39 首选符号持仓为 0 但类别超配（`allowSell`）→ `sell_no_holdings`，不产生负持仓。
- T40 金额四舍五入：`0.005` 进位到 `0.01`；订单金额与手续费合计不超过"现金 + 卖出所得"（逐笔断言）。

**F7 计划文件与核对（T41–T44）**
- T41 计划写入是原子的：把 state 目录指向一个普通文件、使写入必然失败，断言不留下 `.tmp` 文件、退出码 2 `state_dir_unwritable`，且 `last-error.log` 有记录。
- T42 保留 52 个：注入时钟生成 55 个计划，最旧的 3 个被删，`latest.json` 指向最后一个。
- T43 `check` 五种状态各一例（done / partial / pending / over / reversed）＋ `unplanned` 列表；`--strict` 在非全 done 时退出码 4。
- T44 `check --plan ../../etc/passwd` → 退出码 2 `plan_not_found`（正则不匹配）；损坏的 plan → `plan_corrupt`。

**F8 输出、退出码与安全（T45–T47）**
- T45 人类可读输出的列宽：`status` 表格在 `COLUMNS=60` 时降级为逐行列表，不出现被截断的数字；`--color never` 无 ANSI 转义。
- T46 退出码全表：`unknown_field`(2)、`holdings_missing_column`(2)、`cash_required`(2)、`plan_not_found`(2)、`quote_not_found`(3)、`timeout`(3)、`fx_not_found`(3)、`no_actionable_orders`(4)、`strict_failed`(4) 九种失败，逐个断言退出码与机器码；另有一个人为抛异常用例断言退出码 1 与 `.rebal/last-error.log` 含 stack。
- T47 密钥打码：`redactUrl()` 对 `?token=abc123`、`?key=`、`?api_key=`、`?secret=`、`https://user:abc123@host` 五种输入都输出 `***`，无敏感参数时原样返回；再用一个 401 假服务器走一次真实请求，断言 stderr 与 `--json` 里不出现 `abc123`。

**F9 并发与重启（T48）**
- T48 同一秒内连续两次 `plan` → 第二个 `planId` 加 `-2`，两份文件都在，`latest.json` 指向后者；再用 CLI 子进程跑 `status` 生成缓存、第二个子进程跑 `status --offline` → 命中缓存、零网络请求（进程重启后的状态可用）。

**F10 边界输入（T49）**
- T49 只有表头的持仓 CSV：`status` 退出码 0、总市值 0、输出 `还没有持仓`；`plan --cash 3000` 按目标比例生成买单（首选符号一手买得起就买），不报错。

**补充要求**
- 每个用例自己建临时目录（`mkdtemp`），结束后删除；不允许写用户的真实 `~/.rebal`。
- 等待一律用 `waitFor(条件, 2000ms)` 轮询，不用固定 sleep。
- 时钟：`ctx.now` 可注入，缓存 TTL、计划 ID、退避全部走它。
- 出现偶发失败必须修根因；不允许加 `retry` 或跳过用例。
