# 约了吗小手机 - Agent Instructions

## Release gate (must read before Git work)

`main` is the **only stable user-facing branch**. Do not commit directly to it, push it, tag it, or create a public GitHub Release from it unless the user explicitly confirms in the current conversation that the named review candidate is approved and may be promoted.

Every user-impacting change starts from `main` on `release/v<next-version>` (for example `release/v1.0.1`). That branch is the user review target and must be pushed to `origin` before any request to promote it. Read `RELEASE_REVIEW.md` for the required candidate, verification, review, and promotion sequence.

A local or remote release branch, tests, a GitHub draft, and a push are **not** approval and are **not** SillyTavern runtime acceptance. Preserve the controlled MVU/security contracts and record the exact candidate SHA, test results, user decision, and remaining real-host checks in `../实现进度与交接.md`.