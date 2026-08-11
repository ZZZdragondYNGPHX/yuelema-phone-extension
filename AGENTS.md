# 约了吗小手机 - Agent Instructions

## Dual-remote release gate (must read before Git work)

This repository has two fixed remotes:

- `origin` — private `yuelema-phone-extension-dev`; its `main` is the **Dev** integration line.
- `public` — public `yuelema-phone-extension`; `release/vX.Y.Z` is the **Beta** review line and `main` is the only **Stable** user-facing line.

For normal work, commit and push only to `origin`. Never mirror `origin/main` to `public` automatically.

Only when the user explicitly says “发布到公开仓库” may a verified, exact `origin` commit be pushed to `public/release/vX.Y.Z`. That creates or updates the public Beta candidate only: do **not** push `public/main`, create a version tag, or create a formal GitHub Release. Feedback fixes continue through `origin` first, then update the same public release branch.

Only after the user explicitly approves the named public Beta SHA in the current conversation (“审核通过”, “正式发版”, or an equivalent instruction) may that **same** commit be fast-forwarded to `public/main`, tagged `vX.Y.Z`, and published as a formal GitHub Release. A local/remote candidate branch, tests, a GitHub draft, and a push are **not** approval and are **not** SillyTavern runtime acceptance.

Read `RELEASE_REVIEW.md` for the exact verification and promotion sequence. Preserve the controlled MVU/security contracts and record the private Dev SHA, public Beta branch/SHA, user decision, and remaining real-host checks in `../实现进度与交接.md`.