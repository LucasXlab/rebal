# Reddit（英文，未发布）

适用版块：r/Bogleheads、r/personalfinance、r/ETFs。

**注意版规**：r/Bogleheads 与 r/personalfinance 对自我推广有严格限制（通常要求账号有一定历史、
且不能纯广告）。发之前先看版规；如果版规不允许，就只回答别人关于"跨账户再平衡怎么算"的问题，
在答案里顺带提到工具，而不是单独发帖。

## 版本 A：r/Bogleheads（偏"方法"）

**Title:** I got tired of computing cross-account rebalancing by hand, so I wrote a CLI for it

**Body:**

I keep a 3-fund-ish allocation across two brokers: an onshore account in CNY and an offshore one in USD. Once a month I contribute, and once a month I redo the same calculation — convert everything to one currency, add up each sleeve, compare to target, then figure out whether the new money can even buy whole lots.

The part that kept biting me: whole-lot constraints. My target says "add to US equities", but one lot of VTI is a large fraction of the monthly contribution, so some months the right answer is "buy the A-share sleeve instead". Doing that in a spreadsheet means manually stepping lot by lot.

So I wrote `rebal`, a small Node CLI. You keep a holdings CSV; it does the arithmetic and prints an order list plus the drift you will be left with:

```
方向  代码    名称        类别   股数    价格       金额  手续费
────────────────────────────────────────────────────────────────
买入  510300  沪深300ETF  A股   1,400  ¥4.073  ¥5,702.20   ¥0.00

合计 1 笔 · 买入 ¥5,702.20 · 手续费 ¥0.00 · 剩余现金 ¥297.80
执行后  美股 -7.3pp · A股 -3.4pp · 债券 +10.3pp
```

Design choices that are opinionated, and I would like pushback on:

- **Selling off by default.** New money only, so it never creates a taxable event you did not ask for.
- **Band-based.** It only touches a sleeve outside its band (default ±3pp), because constantly nudging 0.5pp positions is churn.
- **Explains omissions.** Every sleeve it skipped prints the arithmetic: one lot costs X, you have Y.
- **No dashboard, no charts, no broker login.** It is a one-second command you run once a month.

It does not do tax lots, TLH, or backtesting, and it will not place orders.

Caveats: quotes come from a Chinese public endpoint (Tencent) and FX from ECB daily reference rates, so it is estimate-grade, not trading-grade. The UI is Chinese-only at the moment.

Repo: https://github.com/LucasXlab/rebal — MIT, 62 tests, no network in tests.

I would especially like to hear from people rebalancing across multiple brokers: how do you handle the lot-size problem, and do you use bands or calendar-based rebalancing?

## 版本 B：r/personalfinance（偏"省时间"）

**Title:** A free CLI that turns "how should I invest this month's contribution?" into a concrete order list

**Body:**

Every month I had the same 20-minute ritual: open two brokerage accounts, note the balances, convert currencies, work out which part of my allocation was behind, then try to buy whole lots without overshooting.

I turned it into a command. You describe your target allocation once in a TOML file and keep your positions in a CSV; each month you run one command with the amount you are investing and it prints what to buy, how many shares, and what your allocation looks like afterwards.

```
合计 1 笔 · 买入 ¥5,702.20 · 手续费 ¥0.00 · 剩余现金 ¥297.80
执行后  美股 -7.3pp · A股 -3.4pp · 债券 +10.3pp
```

It also tells you why it did *not* buy something, which I found was the real time sink — "US equities are 7.3pp short but one lot costs ¥2,519.75 and you have ¥297.80 left".

Free, MIT, runs locally, no account or signup, no data leaves your machine (it fetches quotes and FX rates from public endpoints, that is all). Node.js required.

It only generates a list — you still place the trades yourself. Selling is disabled by default.

Repo: https://github.com/LucasXlab/rebal

(Not financial advice; prices are estimates from a public endpoint, not trading data.)
