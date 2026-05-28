# OpenClaw Ops Mirror Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an operations-focused workspace in `/Users/hulki/codex/openclaw` that documents the local OpenClaw setup and provides repeatable healthcheck and diagnostics scripts for future outages.

**Architecture:** This repo will stay intentionally small. It will point at the live OpenClaw installation and runtime paths, while keeping local docs, wrappers, tests, and incident artifacts under version control so outage response starts from a known structure instead of an empty directory.

**Tech Stack:** Markdown, POSIX shell/Bash, Git, OpenClaw CLI

---

### Task 1: Bootstrap The Workspace

**Files:**
- Create: `tests/bootstrap_test.sh`
- Create: `.gitignore`

**Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -euo pipefail

git rev-parse --is-inside-work-tree >/dev/null 2>&1
test -f .gitignore
```

**Step 2: Run test to verify it fails**

Run: `bash tests/bootstrap_test.sh`
Expected: FAIL because the directory is not yet a Git repository and `.gitignore` does not exist.

**Step 3: Write minimal implementation**

```bash
git init
cat > .gitignore <<'EOF'
.DS_Store
incidents/*/
!incidents/.gitkeep
EOF
```

**Step 4: Run test to verify it passes**

Run: `bash tests/bootstrap_test.sh`
Expected: PASS

**Step 5: Commit**

```bash
git add .gitignore tests/bootstrap_test.sh
git commit -m "chore: bootstrap openclaw ops mirror"
```

### Task 2: Add The Entry Docs

**Files:**
- Create: `README.md`
- Create: `docs/runbook.md`
- Create: `tests/docs_entry_test.sh`

**Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -euo pipefail

test -f README.md
test -f docs/runbook.md
grep -q "openclaw gateway status" README.md
grep -q "openclaw logs --follow" docs/runbook.md
```

**Step 2: Run test to verify it fails**

Run: `bash tests/docs_entry_test.sh`
Expected: FAIL because the docs do not exist yet.

**Step 3: Write minimal implementation**

```md
# README.md
## First Response
- Run `openclaw gateway status`
- Run `./scripts/healthcheck.sh`
- Run `./scripts/collect-diagnostics.sh`
```

```md
# docs/runbook.md
## Live Inspection
- `openclaw gateway status`
- `openclaw logs --follow`
```

**Step 4: Run test to verify it passes**

Run: `bash tests/docs_entry_test.sh`
Expected: PASS

**Step 5: Commit**

```bash
git add README.md docs/runbook.md tests/docs_entry_test.sh
git commit -m "docs: add incident entry points"
```

### Task 3: Capture The Local OpenClaw Topology

**Files:**
- Create: `docs/architecture.md`
- Create: `tests/architecture_test.sh`

**Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -euo pipefail

grep -q "/Users/hulki/.openclaw/workspace" docs/architecture.md
grep -q "/Users/hulki/.openclaw/openclaw.json" docs/architecture.md
grep -q "127.0.0.1:18789" docs/architecture.md
```

**Step 2: Run test to verify it fails**

Run: `bash tests/architecture_test.sh`
Expected: FAIL because the architecture doc does not exist yet.

**Step 3: Write minimal implementation**

```md
# docs/architecture.md
- Workspace root: `/Users/hulki/.openclaw/workspace`
- Config: `/Users/hulki/.openclaw/openclaw.json`
- Gateway: `127.0.0.1:18789`
- LaunchAgent: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
- Runtime log example: `/tmp/openclaw/openclaw-2026-03-11.log`
```

**Step 4: Run test to verify it passes**

Run: `bash tests/architecture_test.sh`
Expected: PASS

**Step 5: Commit**

```bash
git add docs/architecture.md tests/architecture_test.sh
git commit -m "docs: record local openclaw topology"
```

### Task 4: Implement The Healthcheck Script

**Files:**
- Create: `scripts/healthcheck.sh`
- Create: `tests/healthcheck_test.sh`

**Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -euo pipefail

output="$(bash scripts/healthcheck.sh 2>&1 || true)"
printf '%s' "$output" | grep -q "Gateway status"
printf '%s' "$output" | grep -q "Dashboard URL"
```

**Step 2: Run test to verify it fails**

Run: `bash tests/healthcheck_test.sh`
Expected: FAIL because the script does not exist yet.

**Step 3: Write minimal implementation**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Gateway status"
openclaw gateway status
echo "Dashboard URL: http://127.0.0.1:18789/"
echo "RPC URL: ws://127.0.0.1:18789"
```

**Step 4: Run test to verify it passes**

Run: `bash tests/healthcheck_test.sh`
Expected: PASS

Then run: `bash -n scripts/healthcheck.sh`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/healthcheck.sh tests/healthcheck_test.sh
git commit -m "feat: add openclaw healthcheck"
```

### Task 5: Implement Diagnostics Collection And Log Helpers

**Files:**
- Create: `scripts/collect-diagnostics.sh`
- Create: `scripts/follow-logs.sh`
- Create: `incidents/.gitkeep`
- Create: `incidents/templates/incident.md`
- Create: `tests/diagnostics_test.sh`

**Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -euo pipefail

test -x scripts/collect-diagnostics.sh
test -x scripts/follow-logs.sh
test -f incidents/templates/incident.md
```

**Step 2: Run test to verify it fails**

Run: `bash tests/diagnostics_test.sh`
Expected: FAIL because the scripts and incident template do not exist yet.

**Step 3: Write minimal implementation**

```bash
#!/usr/bin/env bash
set -euo pipefail

incident_dir="incidents/$(date +%F-%H%M%S)"
mkdir -p "$incident_dir"
openclaw gateway status > "$incident_dir/gateway-status.txt" || true
openclaw logs --follow
```

```md
# incidents/templates/incident.md
## Summary
## Timeline
## Commands Run
## Findings
## Next Action
```

Split the helper responsibilities so:
- `scripts/collect-diagnostics.sh` creates the timestamped bundle and writes files
- `scripts/follow-logs.sh` only runs `openclaw logs --follow`

**Step 4: Run test to verify it passes**

Run: `bash tests/diagnostics_test.sh`
Expected: PASS

Then run:
- `bash -n scripts/collect-diagnostics.sh`
- `bash -n scripts/follow-logs.sh`

Expected: PASS

**Step 5: Commit**

```bash
git add scripts/collect-diagnostics.sh scripts/follow-logs.sh incidents/.gitkeep incidents/templates/incident.md tests/diagnostics_test.sh
git commit -m "feat: add diagnostics collection helpers"
```

### Task 6: Final Verification And Dry Run

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook.md`

**Step 1: Write the failing verification checklist**

```bash
test -f README.md
test -f docs/runbook.md
bash tests/bootstrap_test.sh
bash tests/docs_entry_test.sh
bash tests/architecture_test.sh
bash tests/healthcheck_test.sh
bash tests/diagnostics_test.sh
```

**Step 2: Run verification to expose gaps**

Run the checklist above.
Expected: Anything unclear in docs or broken in scripts shows up before the final polish.

**Step 3: Write minimal implementation**

Update `README.md` and `docs/runbook.md` until:
- the first response flow matches the scripts exactly
- all known local facts are consistent
- the diagnostics workflow is documented end-to-end

**Step 4: Run verification to confirm final state**

Run:

```bash
bash tests/bootstrap_test.sh
bash tests/docs_entry_test.sh
bash tests/architecture_test.sh
bash tests/healthcheck_test.sh
bash tests/diagnostics_test.sh
bash -n scripts/healthcheck.sh
bash -n scripts/collect-diagnostics.sh
bash -n scripts/follow-logs.sh
```

Expected: PASS

**Step 5: Commit**

```bash
git add README.md docs/runbook.md
git commit -m "docs: finalize openclaw incident workspace"
```
