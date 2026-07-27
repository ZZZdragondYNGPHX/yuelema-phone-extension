# 发布审核工作流

## 目的与术语

本扩展通过 Git URL 被其他用户安装，所以 `main` 只能承载已经由项目负责人明确认可的稳定版本。

- **候选分支**：`release/v<版本>`，例如 `release/v1.0.1`。这是审核入口，不是 `main`。
- **审核版**：候选分支上的已提交、已推送、已验证快照；版本号直接使用最终拟发布的 `X.Y.Z`，以确保审核和正式版指向同一提交。
- **正式发布**：用户在当前对话明确说“审核通过”“正式发版”或等效指令后，才把**同一个候选提交**快进合并到 `main`、推送 `main`、打 `vX.Y.Z` 标签并发布 GitHub Release。
- **真机验收**：在真实 SillyTavern 中的独立验证。它不由 Node 测试、分支推送、GitHub Release 或本文件替代。

GitHub 的 **draft/pre-release** 可用来展示审核说明，但它本身不会让 Git URL 安装的用户自动获得代码；不能把它误报为正式发布。

## 候选准备（禁止改 main）

1. 先确认 `main` 和 `origin/main` 一致，记录基线 SHA；盘点已有脏文件，绝不把来源不明的改动混入。
2. 从 `main` 创建 `release/vX.Y.Z`。候选期间只在该分支提交和推送：
   ```powershell
   git switch main
   git pull --ff-only origin main
   git switch -c release/vX.Y.Z
   ```
3. 仅对扩展本身的发布，把 `manifest.json`、`package.json`、`src/app-shell.js` 的 `UI_VERSION`、静态检查锚点、关于页更新日志、相关测试和 README 同步为同一个 `X.Y.Z`。若本次还改了角色卡合同或产物，再单独同步角色卡版本并构建；纯扩展 UI 修复不可伪称角色卡已更新。
4. 更新 `../实现进度与交接.md` 与相关策划文档，写明候选范围、精确 SHA、验证证据、未做的真机项，以及“尚未进入 main”。
5. 先运行最小回归，再运行完整门禁：
   ```powershell
   node --check .\src\app-shell.js
   npm run check
   node --test
   node --input-type=module -e "await import('./index.js'); console.log('ok')"
   git diff --check
   ```
6. 只暂存经过审查的文件；检查暂存差异，再提交候选：
   ```powershell
   git add -- <explicit files>
   git diff --cached --check
   git diff --cached --stat
   git commit -m "fix: <summary> (vX.Y.Z review)"
   git push -u origin release/vX.Y.Z
   ```

候选推送只会公开审核分支；它不会变更 `origin/main`。若可用 GitHub draft Release，可创建为 **Draft** 并附上候选 SHA、影响范围、测试和真机验收清单；没有 API/CLI 权限时不要伪造“已创建 GitHub Release”。

## 用户审核

向用户提供候选分支 URL / SHA、已验证项、明确未验证项，以及可复现的真机步骤。普通用户的 Git URL 保持 `main`；审核应使用单独的测试环境、临时 checkout 或项目负责人控制的安装副本，绝不覆盖正在使用的稳定安装。

审核结论只有两种：

- **未通过 / 要修改**：继续在同一候选分支修复、重新验证、重新推送；`main` 不动。
- **明确通过**：才进入下一节。沉默、仅说“看一下”、本地检查全绿或候选推送成功都不是授权。

## 正式推广（须当前对话明确授权）

1. 在独立 detached worktree 对候选提交做一次精确快照复验，避免把工作树未提交内容带入。
2. 确认候选与 `main` 可快进；若 `main` 已推进，停止并请用户决定是否重新基于 `main` 审核，不能静默 rebase/merge。
3. 快进、推送、打同一提交的带注释标签，然后创建非 draft GitHub Release：
   ```powershell
   git switch main
   git pull --ff-only origin main
   git merge --ff-only release/vX.Y.Z
   git push origin main
   git tag -a vX.Y.Z -m "约了吗小手机 vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. 复核 `origin/main` 和标签都指向审核 SHA；在 `../实现进度与交接.md` 分别记录“GitHub main/标签/Release 已发布”和“真机验收状态”。

## 回滚

审核期直接停止使用候选分支即可，`main` 无须回滚。正式版若出现问题，先从稳定 `main` 建立下一条 `release/vX.Y.Z+1` 修复候选；不要 force-push、改写已发布标签或强推用户正在使用的 `main` 历史。