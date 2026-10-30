# 发布前检查清单

以下每一条都需要**你手动做**。自动化只能到这里为止。

## 1. 仓库与身份

- [ ] 确认 GitHub 账号：按工作区约定用 `maintainer` 认证、推到 `LucasXlab` 组织。
      ```bash
      gh auth switch --hostname github.com --user maintainer
      gh api user --jq .login        # 必须是 maintainer
      ```
- [ ] 新建仓库 `LucasXlab/rebal`（public，不要初始化 README，本地已有）。
- [ ] 把 README 与 `docs/` 里所有 `LucasXlab/rebal` 链接核对一遍（现在是占位用的真实预期地址）。
- [ ] 推送：`git remote add origin git@github.com:LucasXlab/rebal.git && git push -u origin main`。
- [ ] 推送标签：`git push origin v0.1.0`。

## 2. 发布前必须自己再验一遍

- [ ] 在**另一个目录** clone 一份，按 README 的快速开始从零跑：
      `npm ci` → `init --demo` → `status` → `plan --cash 6000` → `check`。
- [ ] 打开 GitHub 上的 README，确认徽章、图片、表格、相对链接都能正常显示
      （GitHub 上相对链接 `docs/features.md` 要能点开）。
- [ ] 确认 `.rebal/`、`rebal.toml`、`holdings.csv` 没有被提交（`.gitignore` 已覆盖，但要眼看一遍 `git status`）。
- [ ] 确认仓库里没有真实的持仓数据、没有本地绝对路径、没有邮箱或密钥：
      ```bash
      git grep -nE '/Users/|/tmp/|@[a-z0-9.-]+\.(com|cn|org)' -- . ':!launch'
      ```

## 3. 明确要说的话（README 里已写，发帖时别漏）

- [ ] 它**只生成清单，不代下单**。
- [ ] **默认不卖出**（避免意外税务事件）。
- [ ] 行情来自腾讯公开接口，**服务条款未核实**，仅供个人估算参考。
- [ ] 汇率是 ECB 日参考价，不是实时汇率。
- [ ] 界面目前只有中文。

## 3.5 公开前给过程记录打码

`notes/` 是过程记录（选题、决定、审稿、安装实录、真实运行），会出现本机绝对路径
（`/Users/...`、`/private/tmp/...`）。这些不是密钥，但没必要公开。二选一：

- [ ] 方案 A：把 `notes/` 从公开仓库移除（`git rm -r --cached notes`，加进 `.gitignore`），
      自己留一份在别处——它们是给你复盘用的，不是给用户看的。
- [ ] 方案 B：保留但把路径替换成 `<工作目录>`，然后重新过一遍 `git diff notes/`。

同理，`SPEC.md`、`DESIGN.md` 里如果引用了本机路径也要改成相对路径。

## 4. 发帖

- [ ] `launch/show-hn.md`：Show HN 一次只能发一条，标题不要改得太营销。
- [ ] `launch/v2ex.md`：先看投资节点置顶规则；建议发在 `程序员` 节点。
- [ ] `launch/reddit.md`：r/Bogleheads 与 r/personalfinance 对自我推广有限制，先读版规；
      如果发不了帖，就只在别人的相关问题下回答并在签名/末尾提一句。
- [ ] **一次只发一个平台**，看完第一波反馈再决定下一个。

## 5. 发布之后

- [ ] 把 issue 模板加上（bug / feature），并在 README 的"已知限制"里补充真实反馈中出现的问题。
- [ ] 如果有人说"数字对不上"，先确认是不是行情时间差（README 已注明数字会变）。
- [ ] 打 `v0.1.1` 之前，把 CHANGELOG 补上；CI 会校验 tag 与 `package.json`、`src/version.js` 三者一致。
