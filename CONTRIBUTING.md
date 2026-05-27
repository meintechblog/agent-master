# Contributing to agent-master

Thanks for taking a look. agent-master is a small, opinionated project: one Node server, one HTML file, one JSON registry. PRs that respect that scope are very welcome.

## Areas where help is especially wanted

- **Linux support.** Spawn/stop currently relies on AppleScript driving Terminal.app. A `tmux`, `kitty`, or `gnome-terminal` variant would unlock Linux.
- **iTerm2 support.** Similar story — iTerm2 has a proper scripting API; an alternative spawner using that would be cleaner than AppleScript.
- **OAuth token refresh** for `/api/plan-usage`. Right now the token is read from keychain as-is; when it expires the endpoint returns an error.
- **Additional registry fields.** If you've got a setup where a field would be useful (e.g. Docker container ID, Kubernetes namespace, …), open an issue or PR.

## Local development

```bash
git clone https://github.com/meintechblog/agent-master.git
cd agent-master
cp data/registry.example.json data/registry.json     # edit afterwards
node --watch server.mjs                              # auto-restart on edit
# open http://localhost:7890
```

There are no dependencies to install (the only npm `dependencies` field is `{}`). `npx ccusage` is downloaded lazily on first cost-overlay request.

## Style

- **Short, focused functions.** Most functions in `server.mjs` are under 30 lines; please keep it that way.
- **No npm dependencies if avoidable.** Use Node 18+ built-ins (`node:http`, global `fetch`, `node:child_process`, `node:fs/promises`, `URL`).
- **No build step.** `public/index.html` is plain HTML + vanilla JS + a `<style>` block. No bundler, no transpiler, no framework.
- **Server stays single-file.** If `server.mjs` grows past ~1000 lines, that's a sign to step back, not to add a `lib/` folder.
- **Comments are rare.** Default to none. Only add a comment when the *why* is non-obvious (a subtle invariant, a workaround for a specific bug).

## Commit messages

Conventional-style is fine but not required. Optimize for "would someone skimming `git log` understand what changed?". One line is usually enough.

## Before opening a PR

1. Run `node server.mjs` and load the UI locally — confirm your change doesn't break the dashboard.
2. If you added a new endpoint or registry field, update `docs/API.md` or `docs/REGISTRY.md`.
3. If you changed install/uninstall flow, smoke-test `bash install.sh` end-to-end.

## Reporting bugs

Open an issue. Include:

- Your macOS version + Node version (`sw_vers && node -v`)
- What you ran (`bash install.sh`, `node server.mjs`, etc.)
- Logs: `tail -50 ~/codex/agent-master/data/server.stderr.log`
- The browser console if it's a UI bug

## Security issues

See [SECURITY.md](SECURITY.md). Don't open public issues for vulnerabilities.
