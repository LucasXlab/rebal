import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { IssueList, RebalError } from '../src/errors.js';
import { readHoldings, checkSymbolsKnown } from '../src/holdings.js';
import { HOLDINGS_CSV, makeTempDir, writeFile } from './helpers.js';
import { normalizeConfig } from '../src/config.js';
import { parse } from 'smol-toml';
import { validToml } from './helpers.js';

/** 默认列映射。 */
const MAPPING = {
  accountColumn: 'account',
  symbolColumn: 'symbol',
  quantityColumn: 'quantity',
  currencyColumn: 'currency',
  priceColumn: 'price',
  nameColumn: 'name',
};

/** 从默认配置取 assets。 */
function defaultAssets() {
  const issues = new IssueList();
  const cfg = normalizeConfig(parse(validToml()), issues, 'rebal.toml');
  assert.equal(issues.length, 0, JSON.stringify(issues.issues));
  return cfg.assets;
}

test('T9 正常 CSV（含 BOM、引号字段、空行）解析正确；同一符号多账户合并求和', (t) => {
  const dir = makeTempDir(t);
  const csv =
    '\uFEFFsymbol,quantity,account,currency,price,name\n' +
    'VTI,10,ibkr,,,"Vanguard Total Stock Market ETF"\n' +
    '\n' +
    '"510300",500,futu,,,\n' +
    '510300,500,futu2,,,\n' +
    'BND,50,ibkr,,,\n';
  const file = writeFile(dir, 'holdings.csv', csv);
  const holdings = readHoldings(file, MAPPING);

  assert.equal(holdings.items.length, 4);
  assert.equal(holdings.bySymbol.size, 3);
  const cn = holdings.bySymbol.get('510300');
  assert.equal(cn.quantity, 1000);
  assert.equal(cn.accounts.get('futu'), 500);
  assert.equal(cn.accounts.get('futu2'), 500);
  assert.equal(holdings.bySymbol.get('VTI').name, 'Vanguard Total Stock Market ETF');
  assert.deepEqual(holdings.warnings, []);
});

test('T10 同一符号两行币种冲突 → currency_conflict，错误带符号与两个币种', (t) => {
  const dir = makeTempDir(t);
  const file = writeFile(
    dir,
    'holdings.csv',
    'symbol,quantity,account,currency\nVTI,10,ibkr,USD\nVTI,5,futu,CNY\n',
  );
  assert.throws(
    () => readHoldings(file, MAPPING),
    (err) => {
      assert.ok(err instanceof RebalError);
      assert.equal(err.code, 'currency_conflict');
      assert.match(err.message, /USD/);
      assert.match(err.message, /CNY/);
      return true;
    },
  );
});

test('T11 缺 quantity 列 → holdings_missing_column，带实际表头', (t) => {
  const dir = makeTempDir(t);
  const file = writeFile(dir, 'holdings.csv', 'symbol,shares\nVTI,10\n');
  assert.throws(
    () => readHoldings(file, MAPPING),
    (err) => {
      assert.equal(err.code, 'holdings_missing_column');
      assert.match(err.message, /quantity/);
      assert.match(err.message, /symbol,shares/);
      return true;
    },
  );
});

test('T12 未知符号 → unknown_symbol（带行号）；数量为 0 或负数 → holdings_invalid', (t) => {
  const dir = makeTempDir(t);
  const file = writeFile(dir, 'holdings.csv', HOLDINGS_CSV);
  const holdings = readHoldings(file, MAPPING);
  const issues = new IssueList();
  checkSymbolsKnown(holdings, defaultAssets(), issues);
  assert.equal(issues.length, 0);

  const unknownFile = writeFile(dir, 'unknown.csv', 'symbol,quantity\nTSLA,3\n');
  const unknown = readHoldings(unknownFile, MAPPING);
  const unknownIssues = new IssueList();
  checkSymbolsKnown(unknown, defaultAssets(), unknownIssues);
  assert.equal(unknownIssues.issues[0].code, 'unknown_symbol');
  assert.match(unknownIssues.issues[0].message, /第 2 行/);

  for (const quantity of ['0', '-5']) {
    const badFile = writeFile(dir, `bad-${quantity}.csv`, `symbol,quantity\nVTI,${quantity}\n`);
    assert.throws(
      () => readHoldings(badFile, MAPPING),
      (err) => {
        assert.equal(err.code, 'holdings_invalid');
        return true;
      },
      `quantity=${quantity} 应该报错`,
    );
  }
});

test('T13 5001 行 → holdings_too_large；6 MB 文件 → 同上（先判大小，不解析）', (t) => {
  const dir = makeTempDir(t);
  const header = 'symbol,quantity\n';
  const rows = Array.from({ length: 5001 }, () => 'VTI,1').join('\n');
  const big = writeFile(dir, 'big.csv', header + rows + '\n');
  assert.throws(
    () => readHoldings(big, MAPPING),
    (err) => {
      assert.equal(err.code, 'holdings_too_large');
      return true;
    },
  );

  // 稀疏文件：瞬间造出 6 MB，不写 6 MB 数据（测试要快）
  const hugePath = path.join(dir, 'huge.csv');
  fs.writeFileSync(hugePath, header);
  fs.truncateSync(hugePath, 6 * 1024 * 1024);
  assert.ok(fs.statSync(hugePath).size > 5 * 1024 * 1024);
  assert.throws(
    () => readHoldings(hugePath, MAPPING),
    (err) => {
      assert.equal(err.code, 'holdings_too_large');
      return true;
    },
  );
});
