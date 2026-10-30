/**
 * `rebal init` 写出来的模板。示例数据与 fixtures 里的 mock 一致，所以 --demo 完全离线可跑。
 */

export const TEMPLATE_TOML = `# 配平 rebal 的配置。改完运行 rebal status 看结果。
# 字段说明见 README 的"配置"一节（docs/features.md）。
[portfolio]
name = "我的组合"
base_currency = "CNY"

[contribution]
# 每月默认投入多少本币；plan 不带 --cash 时用这个数
amount = 6000

[policy]
# 卖出必须显式允许：默认只用新钱买，不卖已有持仓（避免意外税务事件）
allow_sell = false
# 低于这个金额的订单不下（避免"买 30 块"这种噪音）
min_trade_value = 100
# 一次最多几笔订单
max_orders = 20

[quotes]
provider = "tencent"     # tencent | csv | mock
ttl_minutes = 720        # 价格缓存 12 小时
timeout_ms = 8000
retries = 2

[fx]
provider = "frankfurter" # frankfurter | static | mock

[fees]
per_order = 0            # 每笔订单的手续费（本币）

[holdings]
path = "holdings.csv"
symbol_column = "symbol"
quantity_column = "quantity"
account_column = "account"
currency_column = "currency"
price_column = "price"
name_column = "name"

# 目标比例：加起来必须等于 1
[targets]
us_equity = 0.5
cn_equity = 0.2
bond = 0.3

# 偏离多少算越界：0.03 = 3 个百分点
[bands]
default = 0.03

# name 是给人看的类别名（可省略，省略时输出用类别 ID）
[classes.us_equity]
name = "美股"
preferred_symbol = "VTI"

[classes.cn_equity]
name = "A股"
preferred_symbol = "510300"

[classes.bond]
name = "债券"
preferred_symbol = "BND"

# quote_id 是行情源里的代码，前缀决定市场：us 美股 / sh 沪市 / sz 深市 / hk 港股。
# 不填则用证券代码本身。
[assets.VTI]
class = "us_equity"
name = "Vanguard Total Stock Market ETF"
currency = "USD"
quote_id = "usVTI"

[assets.510300]
class = "cn_equity"
name = "沪深300ETF"
currency = "CNY"
quote_id = "sh510300"
lot_size = 100

[assets.BND]
class = "bond"
name = "Vanguard Total Bond Market ETF"
currency = "USD"
quote_id = "usBND"
`;

export const TEMPLATE_HOLDINGS = `symbol,quantity,account,currency,price,name
VTI,10,ibkr,,,
BND,50,ibkr,,,
510300,1000,futu,,,
`;

export const DEMO_TOML = `# 示例配置：行情与汇率都用内置示例数据，不需要联网。
[portfolio]
name = "示例组合"
base_currency = "CNY"

[contribution]
amount = 6000

[policy]
allow_sell = false
min_trade_value = 100
max_orders = 20

[quotes]
provider = "mock"
ttl_minutes = 720
timeout_ms = 8000
retries = 2

[fx]
provider = "mock"

[fees]
per_order = 1.5

[holdings]
path = "holdings.csv"
symbol_column = "symbol"
quantity_column = "quantity"
account_column = "account"
currency_column = "currency"
price_column = "price"
name_column = "name"

[targets]
us_equity = 0.5
cn_equity = 0.2
bond = 0.3

[bands]
default = 0.03

[classes.us_equity]
name = "美股"
preferred_symbol = "VTI"

[classes.cn_equity]
name = "A股"
preferred_symbol = "510300"

[classes.bond]
name = "债券"
preferred_symbol = "BND"

# quote_id 是行情源里的代码，前缀决定市场：us 美股 / sh 沪市 / sz 深市 / hk 港股。
# 不填则用证券代码本身。
[assets.VTI]
class = "us_equity"
name = "Vanguard Total Stock Market ETF"
currency = "USD"
quote_id = "usVTI"

[assets.510300]
class = "cn_equity"
name = "沪深300ETF"
currency = "CNY"
quote_id = "sh510300"
lot_size = 100

[assets.BND]
class = "bond"
name = "Vanguard Total Bond Market ETF"
currency = "USD"
quote_id = "usBND"
`;

export const DEMO_HOLDINGS = `symbol,quantity,account,currency,price,name
VTI,10,ibkr,,,
BND,50,ibkr,,,
510300,1000,futu,,,
`;
