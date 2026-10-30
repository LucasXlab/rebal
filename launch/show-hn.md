# Show HN（英文，未发布）

**Title:** Show HN: Rebal – a CLI that turns "what should I buy this month?" into an order list

**URL:** https://github.com/LucasXlab/rebal

---

I hold ETFs in two brokers — one onshore in China, one offshore in USD — and every month I was doing the same boring thing: add up both accounts, convert to CNY, work out which sleeve was short, then check whether the cash even covered one lot. Twenty minutes of spreadsheet work to place two orders.

So I wrote a CLI for it. You keep a holdings CSV; it fetches quotes, produces the order list, and tells you how far off target you will still be after placing it.

What I think makes it worth posting:

**It explains why it didn't buy something.** This was the actual pain. A rebalancer that says "buy ¥5,702 of 510300" is not enough — you want to know why the other two sleeves got nothing. Every skipped sleeve comes with the arithmetic:

```
警告
  美股 还差 7.3pp，但一手 1 股约 ¥2,519.75，现金只剩 ¥297.80，买不起
  债券 超配 10.3pp，本次不卖出；加 --sell 可以配平
```

(One lot of VTI costs ¥2,519.75, you have ¥297.80 left; bonds are 10.3pp overweight, selling is off by default.)

**Selling is off by default.** A rebalancer that silently sells to rebalance can hand you a tax bill you did not ask for. `allow_sell = false` is the default; the tool only deploys new money unless you opt in.

**It fails loudly.** If a quote cannot be fetched there is no fallback to 0.00 — it exits 3 with the symbol named. There is a 12-hour cache and an `--offline` flag that serves only from cache.

**It will not buy the wrong thing quietly.** The quote id prefix picks the market (`us`/`sh`/`sz`/`hk`); if that market's currency disagrees with the asset's configured currency, it refuses to continue rather than converting at the wrong rate. `rebal prices` also prints the upstream security name, because a one-character typo can resolve to a real, different ticker.

Implementation notes, since this is HN:

- Node.js ≥ 20.11, pure ESM, plain JS with JSDoc — no TypeScript build step.
- Two runtime dependencies (`smol-toml`, `csv-parse`), both pinned.
- 63 tests via `node:test`. No network in tests (loopback fake servers), no fixed sleeps (injected clock), temp dirs only.
- Terminal output is specced separately from behavior — `DESIGN.md` lists 14 things it deliberately does *not* do (box drawing, emoji, colored headers) and three width breakpoints.
- Chinese-only UI for now; it is built for people holding A-share and US/HK accounts together. `SPEC.md` and source comments are in English.

What it deliberately does not do: place orders, chart anything, compute tax lots, or backtest.

Happy to hear what is missing — especially from anyone who rebalances across brokers.
