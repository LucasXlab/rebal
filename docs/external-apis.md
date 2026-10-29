# 已核实的外部接口

代码里用到的外部接口只有两个：腾讯行情（价格）与 Frankfurter（汇率）。两者都不需要
API key。下面每条都写清"核实方式、核实日期、请求、返回、我们依赖的字段、失败长什么样"。
没实测过的接口不写进代码。核实日期：**2026-10-29**，环境：macOS，Node v25.6.1，curl 8.x。

## 1. 腾讯行情 `https://qt.gtimg.cn/q=<代码1>,<代码2>`

- **官方文档**：没有公开的接口文档。这是腾讯财经网页用的行情接口，字段位置靠社区长期使用
  和实测确认。**这是本项目最大的外部风险**：字段位置没有契约保证，所以只在 `quotes/tencent.js`
  一处解析，并且只用第 4 段（下标 3）的价格；解析结果有单测和假服务器覆盖，接口一变只会
  表现为 `quote_not_found`/`quote_invalid`，不会算出错误订单。
- **核实方式**：2026-10-29 用 curl 与 Node `fetch` 各请求一次，并检查 GBK 解码。
- **请求**：`GET https://qt.gtimg.cn/q=usAAPL,usVTI,sh600519,hk00700`。无鉴权头，无 cookie。
  代码段与市场前缀：美股 `us<代码>`，沪市 `sh<代码>`，深市 `sz<代码>`，港股 `hk<代码>`。
- **编码**：GBK。用 `new TextDecoder('gbk')` 解码（Node 20+ 官方构建带 full-icu，实测
  v25.6.1 可解）；ICU 不支持 GBK 时回退为按 Latin-1 读，价格与数字是 ASCII，不受影响。
- **返回**：一行一个代码，形如 `v_usAAPL="…";`，字段用 `~` 分隔。实测片段（截断）：

  ```
  v_usAAPL="200~苹果~AAPL.OQ~348.91~343.83~348.00~42365859~0~…~USD~…";
  v_usVTI="200~美国全股市ETF-Vanguard~VTI.AM~378.24~379.17~377.50~…~USD~…";
  v_sh600519="1~贵州茅台~600519~1354.00~1330.75~1349.99~…~CNY~…";
  v_hk00700="100~腾讯控股~00700~377.600~387.600~386.000~…~HKD~…";
  ```

  我们依赖的只有：**按 `;` 分行 → 匹配 `v_<quote_id>="` → 内容按 `~` 分段 → 下标 3 是当前价**。
  货币不从响应里取（位置随市场不同，不可靠），用配置里的 `assets.*.currency`。
- **失败长什么样**（实测）：
  - 代码不存在：仍返回 200 与一行数据，但价格是 `0.000`
    （`v_usZZZZ="200~ZZZZ~ZZZZ.N~0.000~0.000~…"`）。代码按"价格必须 > 0"判为 `quote_not_found`。
  - 查询串为空：返回 `v_pv_none_match="1";`，同样按 `quote_not_found` 处理。
  - 网络不可达/被墙：由 `http.js` 统一映射为 `network_error` / `timeout`。
- **限流**：官方没有说明。实测连续 4 次请求无异常。代码自己限制为"每批之间至少 1000 ms、
  一次运行最多 4 批"，把请求量压到每周 1–4 次的量级。
- **未核实**：腾讯的服务条款是否允许这种自动请求；中国大陆以外是否长期可用。README 的
  「使用前须知」写明"行情来自腾讯财经的公开接口，可能延迟、可能取不到，取不到时工具会
  直接报错而不是猜一个价格"，并给出 `provider=csv` 的自报价方案。

## 2. Frankfurter `https://api.frankfurter.app/latest`

- **官方文档**：<https://www.frankfurter.app/docs/>（2026-10-29 访问，HTTP 200）。
- **核实方式**：2026-10-29 用 curl 实测三次（正常、本币为 CNY、货币不存在），并核对返回值
  与 ECB 参考汇率的方向。
- **请求**：`GET https://api.frankfurter.app/latest?from=CNY&to=USD,HKD`。无鉴权。
- **返回**（实测，2026-10-29）：

  ```json
  {"amount":1.0,"base":"CNY","date":"2026-10-29","rates":{"HKD":1.1778,"USD":0.15011}}
  ```

  `rates[X]` 的含义是 **1 单位 `base` 等于多少 `X`**。因此换算到本币：
  `rateToBase(X) = 1 / rates[X]`。例：`1 / 0.15011 = 6.6618`，即 1 USD = 6.6618 CNY。
- **失败长什么样**（实测）：货币代码不存在 → HTTP **404**，响应体 `{"message":"not found"}`，
  代码映射为 `fx_not_found` 并在错误信息里带上该货币代码。
- **限流**：文档未给具体数字；代码每次运行最多请求 1 次，并有 12 小时缓存。
- **数据范围**：ECB 参考汇率，工作日更新，周末与节假日沿用上一交易日。**不是实时汇率**：
  README 写明"汇率是 ECB 日参考价，周末不更新"。

## 3. 依赖包（安装时联网，运行时不联网）

| 包 | 版本 | 用途 | 核实方式 |
|---|---|---|---|
| `smol-toml` | 1.9.1 | TOML 解析 | 2026-10-29 查 npm registry `/smol-toml/latest`，`engines.node >= 18` |
| `csv-parse` | 7.0.3 | CSV 解析 | 2026-10-29 查 npm registry `/csv-parse/latest` |

两个都是纯 JS、无原生编译、无 postinstall 脚本。`package-lock.json` 随仓库提交，安装用 `npm ci`。

## 4. 试过但不采用的行情源

| 源 | 实测结果（2026-10-29） | 不采用的原因 |
|---|---|---|
| Stooq `https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv` | HTTP 404；历史数据接口返回 200 但响应体是一段需要浏览器执行 SHA-256 工作量证明的 JS（`This site requires JavaScript to verify your browser`） | 有反爬，不能稳定程序化调用 |
| Stooq `https://stooq.com/q/d/l/?s=aapl.us&i=d` | 同上（200 + JS 验证脚本） | 同上 |
| Yahoo `https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d` | HTTP 429 `Too Many Requests` | 无凭据访问被限流，稳定性不可控 |
| 东方财富 `https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43,f57,f58` | HTTP 302（需要跟随与额外参数） | 未完成核实，不写进代码 |
| CoinGecko `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd` | HTTP 200，`{"bitcoin":{"usd":79563}}` | v0.1.0 不建模加密货币（见 SPEC 非目标），先不接 |

## 5. 怎么复现这些核实

```bash
# 1. 行情（应看到 v_usAAPL="200~苹果~…~<价格>~…"）
curl -s 'https://qt.gtimg.cn/q=usAAPL' | iconv -f gbk -t utf-8 | cut -c1-120

# 2. 汇率（应看到 base/date/rates 三个键）
curl -s 'https://api.frankfurter.app/latest?from=CNY&to=USD'

# 3. 不存在的货币（应为 404 与 {"message":"not found"}）
curl -s -o /dev/null -w '%{http_code}\n' 'https://api.frankfurter.app/latest?from=CNY&to=XXX'
```
