# 双 Remote 发布审核工作流

## 目的与术语

本扩展采用私有开发、公开 Beta、公开 Stable 的三层交付。remote 名称和职责不得互换：

| Remote / branch | 职责 | 是否可供普通用户安装 |
| --- | --- | --- |
| `origin/main` | 私有 **Dev** 开发主线 | 否 |
| `public/release/vX.Y.Z` | 公开 **Beta** 审核候选 | 仅审核者/测试环境 |
| `public/main` | 公开 **Stable** 稳定线 | 是 |

- **私有 Dev SHA**：已提交到 `origin`、可供持续开发的精确提交。
- **公开 Beta SHA**：从私有 Dev SHA 选定并推送到 `public/release/vX.Y.Z` 的审核快照。
- **正式发布**：用户在当前对话明确说“审核通过”“正式发版”或等效指令，批准**命名的 Beta SHA**后，才把同一提交推广到 `public/main`、打 `vX.Y.Z` tag 并创建 GitHub Release。
- **真机验收**：真实 SillyTavern 中的独立验证；Node 测试、分支推送、GitHub Release 或本文件均不能替代它。

GitHub 的 Draft/Pre-release 可展示审核说明，但不会让 Git URL 普通安装自动转到 Stable，也不等于用户批准。

## 日常开发（只到私有 origin）

1. 盘点工作树，绝不混入来源不明的改动：
   ```powershell
   git status --short --branch
   git fetch origin
   ```
2. 在 `origin` 的开发分支进行修改、验证、提交和推送。`origin/main` 是 Dev 集成线；不得把日常提交推送或镜像到 `public`。
3. 每个功能阶段更新 `../实现进度与交接.md`，写明私有 Dev SHA、验证结果和未做的真机项。

## 公开 Beta（仅在用户明确说“发布到公开仓库”后）

1. 检查代码状态并拉取私有 Dev 主线：
   ```powershell
   git status --short --branch
   git fetch origin public
   git switch main
   git pull --ff-only origin main
   ```
   工作树必须干净；记录将发布的精确 `origin/main` SHA 和版本 `X.Y.Z`。
2. 确认 `public/main` 是该 Dev SHA 的祖先；若公开 Stable 已推进或历史分叉，停止并请用户决定，绝不 force-push：
   ```powershell
   git merge-base --is-ancestor public/main origin/main
   ```
3. 运行适用的本地门禁，并更新进度文档：
   ```powershell
   node --check .\src\app-shell.js
   npm run check
   node --test
   node --input-type=module -e "await import('./index.js'); console.log('ok')"
   git diff --check
   ```
4. 仅将这个精确 Dev SHA 推送为公开 Beta：
   ```powershell
   $sha = git rev-parse origin/main
   git push public "${sha}:refs/heads/release/vX.Y.Z"
   git ls-remote --heads public release/vX.Y.Z
   ```
   此步骤**不得**推 `public/main`、不得打 tag、不得创建正式 GitHub Release。

向用户报告公开 Beta 分支 URL/SHA、已验证项、明确未验证项及可复现真机步骤，等待反馈。

## Beta 反馈与修复

1. 修复、验证、提交先进入 `origin`。
2. 重新运行门禁，记录新的私有 Dev SHA。
3. 仍只有在用户明确说“发布到公开仓库”后，才把该精确 SHA 更新到同一个 `public/release/vX.Y.Z`；若远端候选分支不允许快进，停止并说明情况，绝不 force-push。
4. `public/main`、tag 与正式 Release 在此阶段保持不变。

## 正式 Stable 推广（须当前对话明确授权）

1. 用户必须明确批准**精确的** `public/release/vX.Y.Z` SHA；沉默、仅说“看一下”、全绿测试、Beta 推送成功或 Draft/Pre-release 都不是授权。
2. 在独立干净 worktree 做精确快照复验，随后获取远端引用：
   ```powershell
   git fetch origin public
   git rev-parse public/release/vX.Y.Z
   git ls-remote --heads public main release/vX.Y.Z
   ```
3. 确认 Beta SHA 与已批准 SHA 相同，且 `public/main` 可快进至该提交；否则停止并请用户决定。禁止改写已发布历史或强推。
4. 将**同一** Beta SHA 推广到公开 Stable、打带注释 tag 并创建非 Draft GitHub Release：
   ```powershell
   $sha = '<approved-beta-sha>'
   git push public "${sha}:refs/heads/main"
   git tag -a vX.Y.Z $sha -m "约了吗小手机 vX.Y.Z"
   git push public vX.Y.Z
   ```
5. 复核 `public/main` 和 `vX.Y.Z` 指向已批准 SHA；在 `../实现进度与交接.md` 分别记录 Beta、Stable、tag、Release 和真机验收状态。

## 回滚

Beta 期停止更新 `public/release/vX.Y.Z` 即可，`public/main` 无须回滚。Stable 出现问题时，从 `origin` 建立后续修复并重新走 Dev → Beta → Stable；不要 force-push、改写已发布 tag 或强推公开 Stable 历史。