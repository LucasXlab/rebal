# 配平 rebal

把"这个月这笔钱该买什么"变成一张能照着下单的清单。

[![tests](https://img.shields.io/badge/tests-62%20passed-brightgreen)](test/)
[![node](https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-2-blueviolet)](package.json)

跨账户、多币种的定投与再平衡工具。你维护一份持仓 CSV，它算出"按目标比例，本次该买卖哪些标的、各多少股"，并告诉你执行后离目标还差多少。

```
$ rebal status
我的组合 · 本币 CNY · 总市值 ¥53,046.42
行情 2026-10-29 23:10（腾讯行情） · 汇率 2026-10-29 23:10（Frankfurter）

资产类别        市值   目标   当前     偏离   带宽  状态
────────────────────────────────────────────────────────
美股      ¥25,197.52  50.0%  47.5%   -2.5pp  3.0pp  正常
A股        ¥4,073.00  20.0%   7.7%  -12.3pp  3.0pp  越界
债券      ¥23,775.90  30.0%  44.8%  +14.8pp  3.0pp  越界

账户  市值(CNY)   占比
──────────────────────
ibkr  48,973.42  92.3%
futu   4,073.00   7.7%

提示：2 个类别越界。运行 rebal plan --cash <金额> 看这笔钱怎么买。
```

```
$ rebal plan --cash 6000
我的组合 · 本币 CNY · 总市值 ¥53,046.42
本次投入 ¥6,000.00 · 价格来自 腾讯行情

方向  代码    名称        类别   股数    价格       金额  手续费
────────────────────────────────────────────────────────────────
买入  510300  沪深300ETF  A股   1,400  ¥4.073  ¥5,702.20   ¥0.00

合计 1 笔 · 买入 ¥5,702.20 · 手续费 ¥0.00 · 剩余现金 ¥297.80
执行后  美股 -7.3pp · A股 -3.4pp · 债券 +10.3pp

警告
  美股 还差 7.3pp，但一手 1 股约 ¥2,519.75，现金只剩 ¥297.80，买不起
  A股 还差 3.4pp，但一手 100 股约 ¥407.30，现金只剩 ¥297.80，买不起
  债券 超配 10.3pp，本次不卖出；加 --sell 可以配平

计划已保存：.rebal/plans/2026-10-29T23-10-22-04-00.json
成交后更新 holdings.csv，再运行 rebal check
```

以上两段是**真实运行输出**（2026-10-29 23:10，腾讯行情 + Frankfurter 汇率，1 USD ≈ 6.66 CNY；
行情会变，数字对不上是正常的）。

## 使用前须知

1. **它只生成清单，不代下单。** 没有任何券商接口，也不会替你交易；所有订单要你自己在券商里敲。
2. **默认不卖出。** `policy.allow_sell = false`：只用新钱买入，不会为了配平卖掉已有持仓。想让它卖，用 `plan --sell` 或改配置——**卖出可能产生税务事件，请自己判断**。
3. **行情来自腾讯公开接口，未核实服务条款。** 仅供个人估算参考，不是交易依据。取不到价格时它会直接报错退出（不会用 0 元糊过去），也可以用 `provider = "csv"` 完全自报价。
4. **汇率是 ECB 日参考价**（Frankfurter），周末与节假日不更新，不是实时汇率。
5. **`holdings.csv` 与 `.rebal/` 是你的真实持仓**，已在 `.gitignore` 里，不会被提交；也请不要贴到 issue 里。

## 适用于

- 你有 2 个以上账户（比如 A 股券商 + 港美股券商），想按一个统一的目标比例配平。
- 你每月定投一笔钱，每次都要自己算"这笔钱该补哪个类别、够不够一手"，算烦了。
- 你的持仓是 ETF 或股票这类按"股数"下单的标的，且知道自己的目标比例与容忍带宽。

## 不适用于

- **想要自动交易或组合跟踪看板。** 这里没有 GUI、没有曲线图、不连券商。
- **想要税务计算、收益归因、回测。** 它只回答"现在买什么"。
- **持仓超过 5000 行、或需要分钟级实时行情。** 它是一次运行 1 秒的命令行工具，行情缓存默认 12 小时（`quotes.ttl_minutes`）。

## 快速开始

需要 Node.js ≥ 20.11（不需要数据库、不需要服务器、不需要 API key）。

```bash
git clone https://github.com/LucasXlab/rebal.git
cd rebal
npm ci

# 先看离线示例（不需要网络、不需要你填任何东西）
node bin/rebal.js init --demo
node bin/rebal.js status
node bin/rebal.js plan --cash 6000
```

觉得顺手，再换成你自己的组合：

```bash
mkdir ~/my-portfolio && cd ~/my-portfolio
node /path/to/rebal/bin/rebal.js init     # 生成 rebal.toml + holdings.csv
$EDITOR rebal.toml                        # 改目标比例、类别名、标的
$EDITOR holdings.csv                      # 填真实持仓
node /path/to/rebal/bin/rebal.js status
```

想直接用 `rebal` 命令（而不是 `node bin/rebal.js`）：

```bash
cd /path/to/rebal && npm link    # 之后全局可用 rebal
```

### 最小配置

复制下面这份就能跑（`rebal init` 生成的就是它，只是多几条注释）：

```toml
[portfolio]
name = "我的组合"
base_currency = "CNY"

[contribution]
amount = 6000              # 每月默认投入；plan 不带 --cash 时用它

[policy]
allow_sell = false         # 默认只用新钱买，不卖已有持仓
min_trade_value = 100      # 低于这个金额（本币）的订单不下
max_orders = 20

[quotes]
provider = "tencent"       # tencent | csv | mock
ttl_minutes = 720

[fx]
provider = "frankfurter"   # frankfurter | static | mock

[targets]                  # 目标比例，加起来必须等于 1
us_equity = 0.5
cn_equity = 0.2
bond = 0.3

[bands]                    # 偏离多少算越界：0.03 = 3 个百分点
default = 0.03

[classes.us_equity]        # name 是给人看的类别名，可省略
name = "美股"
preferred_symbol = "VTI"   # 买入这个类别时只买这一只

[assets.VTI]
class = "us_equity"
name = "Vanguard Total Stock Market ETF"
currency = "USD"
quote_id = "usVTI"         # 行情源里的代码：us 美股 / sh 沪市 / sz 深市 / hk 港股
```

持仓 CSV（`currency` / `price` / `name` 三列可留空；`price` 填了就用你的自报价，不联网）：

```csv
symbol,quantity,account,currency,price,name
VTI,10,ibkr,,,
BND,50,ibkr,,,
510300,1000,futu,,,
```

## 命令

| 命令 | 作用 |
|---|---|
| `rebal init [--demo] [--force]` | 生成 `rebal.toml` 与 `holdings.csv`；`--demo` 用内置示例数据，完全离线 |
| `rebal status [--strict]` | 当前各类别的市值、比例、偏离与是否越界 |
| `rebal plan [--cash <金额>] [--sell] [--no-save]` | 这笔钱怎么买：订单清单 + 执行后偏离 |
| `rebal check [--plan <id\|latest>] [--strict]` | 上期计划成交了没有 |
| `rebal prices [--refresh]` | 只用来看行情与汇率取到了什么（含上游名称，便于核对代码没写错） |
| `rebal help [<命令>]` | 用法 |

全局参数：`--dir <目录>`（项目目录，默认当前目录）、`--state-dir <目录>`（状态目录，默认 `<dir>/.rebal`）、`--json`（机器可读）、`--offline`（只用缓存，不联网）、`--color auto\|always\|never`、`--verbose`（打印请求次数、缓存命中、耗时）。

退出码：`0` 成功 · `1` 程序缺陷 · `2` 输入或配置有错 · `3` 外部数据取不到 · `4` 跑通了但没有可执行结果（例如已经配平、或 `--strict` 下没全完成）。

## 它是怎么算的

1. 按你配置的行情源取价、按汇率折算成本币，算出每个类别当前市值。
2. 目标市值 = （当前总市值 + 本次投入）× 目标比例。
3. **先卖后买**：只有 `allow_sell` 且某类别超出带宽时才卖，卖出净额进入本次可用现金。
4. 用现金按"缺得最多"的顺序逐手买入，一次买一手，买不起就跳过并记下原因。
5. 汇总执行后的偏离，并逐条解释**为什么某个类别没买**（"一手要 ¥2,519.75、你只剩 ¥244.60"这种）。

完整算法与边界情况见 [`SPEC.md`](SPEC.md) 第 5 节；终端输出的排版规范见 [`DESIGN.md`](DESIGN.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/features.md`](docs/features.md) | 每个功能的细节、配置项含义、常见用法 |
| [`SPEC.md`](SPEC.md) | 唯一契约：字段、校验规则、算法、49 个测试用例 |
| [`DESIGN.md`](DESIGN.md) | 终端输出规范：颜色、数字格式、宽度降级、错误块 |
| [`docs/external-apis.md`](docs/external-apis.md) | 腾讯行情与 Frankfurter 的实测记录、失败长什么样 |
| [`docs/development.md`](docs/development.md) | 本地开发、跑测试、加功能 |
| [`docs/deviations.md`](docs/deviations.md) | 与 SPEC 的偏差及理由（每条都写明为什么不按规格做） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更 |

## 升级

```bash
cd /path/to/rebal && git pull && npm ci
node bin/rebal.js version    # 确认版本
```

`rebal.toml` 与 `holdings.csv` 的格式在 0.x 期间可能变，升级后先跑 `rebal status` 看有没有报错；
状态目录 `.rebal/` 里的缓存与计划可以随时删掉，下次运行会重建。

## 已知限制

- 行情源只有腾讯（A 股 / 港股 / 美股），汇率只有 ECB 参考价；其他市场请用 `provider = "csv"` 自报价。
- 不做拆股/合并的自动调整：发生拆股后请自己改 `holdings.csv` 的股数。
- 定投日不是交易日时不会自动顺延，需要你自己选一天运行。

## 许可

[MIT](LICENSE)。
