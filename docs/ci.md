# Continuous integration

GitHub Actions runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
for pull requests targeting `main`, pushes to `main`, and manual dispatches.
Runs use read-only repository permissions and cancel obsolete runs for the same
pull request or ref.

The workflow has two stable checks suitable for pull-request branch protection:

- **Node / verify** — Node 22, `npm ci`, TypeScript validation, the complete
  Node test suite, production build, Local Hub JavaScript syntax checks, and
  npm audits. The local suite is expected to take around 1–2 minutes because
  of its lifecycle stress test.
- **Android / verify** — Java 17 with the repository Gradle wrapper, Android
  unit tests, and `assembleDebug`.

The npm audit gate fails on HIGH or CRITICAL vulnerabilities. Known MODERATE
findings do not fail CI. npm audit depends on npm registry/network
availability, so a registry outage can fail the CI job.

CI requires no repository secrets, does not deploy or publish artifacts, and
does not use ADB, an emulator, or physical Quest hardware. It proves software
and build integrity; real-device behavior still requires hardware validation.

Recommended required pull-request checks:

- Node / verify
- Android / verify
