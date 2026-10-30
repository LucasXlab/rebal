# rebal

Turns "what should I buy with this month's contribution?" into a list of orders you can actually place.

[![tests](https://img.shields.io/badge/tests-62%20passed-brightgreen)](test/)
[![node](https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-2-blueviolet)](package.json)

A cross-account, multi-currency DCA and rebalancing CLI. You keep a holdings CSV; it works out which symbols to buy or sell this month, how many shares or lots of each, and how far off target you will still be afterwards.

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

Both screenshots are **real output** from 2026-10-29 23:10 (Tencent quotes + Frankfurter FX, 1 USD ≈ 6.66 CNY).

> The interface is Chinese-only for now. That is a deliberate choice: it is being built for Chinese retail investors who hold both onshore (A-share) and offshore (US/HK) accounts, and every message — including the "why didn't it buy this one" explanations — has to read naturally. An English UI is on the roadmap; the code and `SPEC.md` are in English where it matters.

## Before you use it

1. **It only produces a list. It never places orders.** There is no broker integration, and it will not trade for you. You type the orders yourself.
2. **Selling is off by default.** `policy.allow_sell = false` means it only buys with new money. Use `plan --sell` or change the config if you want it to trim overweight positions — **selling can trigger a taxable event, and that call is yours**.
3. **Quotes come from Tencent's public endpoint, and its terms of service have not been verified.** Treat prices as an estimate, not as trading data. When a quote cannot be fetched it fails loudly instead of substituting 0, and you can switch to `provider = "csv"` for fully self-supplied prices.
4. **FX rates are ECB daily reference rates** (Frankfurter). They do not update on weekends or holidays and are not live.
5. **`holdings.csv` and `.rebal/` contain your real positions.** They are gitignored. Please do not paste them into issues.

## Good fit

- You hold assets across two or more accounts (e.g. an A-share broker plus an offshore broker) and want one target allocation across all of them.
- You invest a fixed amount every month and are tired of working out by hand which sleeve is short and whether the cash covers a lot.
- Your holdings are ETFs or shares that trade in whole lots, and you already know your target weights and tolerance bands.

## Not a good fit

- **You want automated trading or a portfolio dashboard.** No GUI, no charts, no broker connection.
- **You want tax lots, return attribution, or backtesting.** It answers exactly one question: what to buy now.
- **More than 5,000 holding rows, or intraday data.** It is a one-second CLI; quotes are cached for 12 hours by default (`quotes.ttl_minutes`).

## Quick start

Requires Node.js ≥ 20.11. No database, no server, no API key.

```bash
git clone https://github.com/LucasXlab/rebal.git
cd rebal
npm ci

# Offline demo — no network, nothing to fill in
node bin/rebal.js init --demo
node bin/rebal.js status
node bin/rebal.js plan --cash 6000
```

Then switch to your own portfolio:

```bash
mkdir ~/my-portfolio && cd ~/my-portfolio
node /path/to/rebal/bin/rebal.js init     # writes rebal.toml + holdings.csv
$EDITOR rebal.toml                        # targets, class names, symbols
$EDITOR holdings.csv                      # your actual positions
node /path/to/rebal/bin/rebal.js status
```

To get a `rebal` command instead of typing `node bin/rebal.js`:

```bash
cd /path/to/rebal && npm link
```

### Minimal config

```toml
[portfolio]
name = "我的组合"
base_currency = "CNY"

[contribution]
amount = 6000              # default monthly contribution; used when --cash is omitted

[policy]
allow_sell = false         # buy with new money only
min_trade_value = 100      # skip orders below this (in base currency)
max_orders = 20

[quotes]
provider = "tencent"       # tencent | csv | mock
ttl_minutes = 720

[fx]
provider = "frankfurter"   # frankfurter | static | mock

[targets]                  # must sum to exactly 1
us_equity = 0.5
cn_equity = 0.2
bond = 0.3

[bands]                    # how far off counts as out of band: 0.03 = 3 percentage points
default = 0.03

[classes.us_equity]
name = "美股"              # optional display name; falls back to the class id
preferred_symbol = "VTI"   # the only symbol this sleeve buys

[assets.VTI]
class = "us_equity"
name = "Vanguard Total Stock Market ETF"
currency = "USD"
quote_id = "usVTI"         # quote id prefix picks the market: us / sh / sz / hk
```

Holdings CSV (`currency`, `price`, `name` may be empty; a `price` makes it skip the network):

```csv
symbol,quantity,account,currency,price,name
VTI,10,ibkr,,,
BND,50,ibkr,,,
510300,1000,futu,,,
```

## Commands

| Command | What it does |
|---|---|
| `rebal init [--demo] [--force]` | Writes `rebal.toml` and `holdings.csv`; `--demo` uses built-in sample data and works offline |
| `rebal status [--strict]` | Current value, weight, drift and band status per sleeve |
| `rebal plan [--cash <amount>] [--sell] [--no-save]` | The order list plus post-trade drift |
| `rebal check [--plan <id\|latest>] [--strict]` | Did last period's plan get executed? |
| `rebal prices [--refresh]` | What was actually fetched, including upstream names so you can spot a mistyped id |
| `rebal help [<command>]` | Usage |

Global flags: `--dir` (project directory, default cwd), `--state-dir` (default `<dir>/.rebal`), `--json`, `--offline`, `--color auto|always|never`, `--verbose` (request count, cache hits, latency).

Exit codes: `0` ok · `1` internal bug · `2` bad input or config · `3` external data unavailable · `4` ran fine but produced nothing to execute (already balanced, or `--strict` not satisfied).

## How it decides

1. Fetch prices and FX, convert everything to the base currency, total each sleeve.
2. Target value = (current total + this contribution) × target weight.
3. **Sells first, then buys.** It only sells when `allow_sell` is on and a sleeve is beyond its band; proceeds join the cash available.
4. Buys one lot at a time, always the most-short sleeve, and records why it stopped when cash runs out.
5. Reports post-trade drift, and explains each sleeve it did not touch in money terms ("one lot costs ¥2,519.75, you have ¥297.80 left").

The full algorithm and edge cases are in [`SPEC.md`](SPEC.md) §5; terminal formatting rules are in [`DESIGN.md`](DESIGN.md).

## Docs

| Doc | Contents |
|---|---|
| [`docs/features.md`](docs/features.md) | Every feature in detail, what each config key means |
| [`SPEC.md`](SPEC.md) | The contract: fields, validation rules, algorithm, 49 test cases |
| [`DESIGN.md`](DESIGN.md) | Terminal output spec: colors, number formats, width breakpoints, error blocks |
| [`docs/external-apis.md`](docs/external-apis.md) | What Tencent and Frankfurter actually return, including failure modes |
| [`docs/development.md`](docs/development.md) | Local dev, running tests, adding features |
| [`docs/deviations.md`](docs/deviations.md) | Where the implementation deviates from SPEC, and why |
| [`CHANGELOG.md`](CHANGELOG.md) | Version history |

## Upgrading

```bash
cd /path/to/rebal && git pull && npm ci
node bin/rebal.js version
```

During 0.x the config and CSV formats may change. After upgrading, run `rebal status` first.
The `.rebal/` state directory (cache and saved plans) is disposable — delete it any time.

## Known limitations

- Only Tencent for quotes and only ECB reference rates for FX. For other markets, use `provider = "csv"`.
- No automatic split/merge adjustment; after a split, edit the share counts in `holdings.csv`.
- If your contribution day is not a trading day, nothing is shifted automatically — pick a day yourself.

## License

[MIT](LICENSE).
