# dsh-toolkit

A set of utilities, plugins and skills built around [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — making the agent framework **upgradable, migratable, remote-capable and domain-adaptable**.

> DSH itself is the upstream-maintained engine. This repository is the **user-side engineering layer** around it: it fills capabilities the framework does not ship yet (upgrade management, whole-workbench migration, multi-server remote control, message amendment, remote-GPU usage templates).
>
> **This repository is where I maintain my own modifications and upgrades to DSH long-term.** New capabilities follow the structure described in [docs/MAINTAINING.md](docs/MAINTAINING.md) (Chinese).

[中文文档](README.md) | English

## Components

| Component | Purpose |
|---|---|
| [`tools/update-dsh.mjs`](tools/update-dsh.mjs) | **Upgrade management**: managed installs (independent of the npx cache), backup → prefetch → smoke test → config diff → switch → rollback; supports multiple dist-tags (`latest`/`next`/`alpha`) and `prune` to clean old versions |
| [`tools/migrate-dsh.mjs`](tools/migrate-dsh.mjs) | **Whole-workbench migration**: pack data/config/plugins/remote inventory into one archive and restore it on a new machine (rewrites absolute paths, reinstalls the engine, smoke-tests the result) |
| [`dsh-remote/`](dsh-remote/) | **Multi-server remote panel**: manage each server as its own dsh workspace — SSH-tunnel mode or local direct mode — with a web control panel and an optional local supervisor (launchd) |
| [`plugins/dsh-plugin-amend/`](plugins/dsh-plugin-amend/) | **Example plugin**: amend conversation history using the same surface-replace mechanism as compaction, keeping the durable log append-only |
| [`skills/`](skills/) | **Remote-GPU partition template**: teach a local agent to read/write remote files and run training over ssh/rsync |
| [`docs/USAGE.md`](docs/USAGE.md) | Command cheat-sheet (version-independent — still valid after upgrades) |

## Quick start

Requires **Node 22+** and a working `dsh`.

```sh
git clone <this-repo> && cd dsh-toolkit

# 1) Upgrade management
node tools/update-dsh.mjs status     # current/latest version and all dist-tags
node tools/update-dsh.mjs update     # backup → prefetch → smoke → diff → confirm → switch
node tools/update-dsh.mjs rollback   # one-command rollback

# 2) Migration (new machine / new server)
node tools/migrate-dsh.mjs pack      # produces dsh-migrate-*.tar.gz
node tools/migrate-dsh.mjs restore <archive>   # restore on the target machine

# 3) Remote panel (optional: run it as a resident service)
bash dsh-remote/install-supervisor.sh install
node dsh-remote/cli.mjs list / connect <name> / open <name>
```

Skills: copy `skills/*` into `$DSH_HOME/skills/` (default `~/.dsh/skills/`) and they are discovered automatically — the standard agent preset already mounts the skill provider, so no configuration change is needed.

Plugin:

```sh
cd ~/.dsh && dsh plugin --profile web add <path-to-this-repo>/plugins/dsh-plugin-amend
```

## Design principles

- **Engine and user layer stay separate**: the framework itself belongs to upstream; this repo only adds user-side capabilities — no fork, no core patches
- **Data first**: sessions, config and plugins are plain files, and neither upgrades nor migrations touch them (automatic backup before an upgrade, one-command rollback after)
- **Verify before switching**: upgrades and restores both run a smoke test and a config diff; a failure means no switch
- **Zero dependencies**: every tool uses only Node built-ins; the remote panel relies solely on ssh/rsync and OS-provided facilities

## Known limitations

- Tools target macOS/Linux (Windows untested)
- `dsh-plugin-amend` only replaces message text (hide/restore are not implemented); showing amendments in the UI needs a client-side Definition (see that plugin's README)
- `dsh-remote` tunnel mode requires passwordless SSH — a detached background connection cannot type a password
- Turning a remote directory into a **true system mount** (WebDAV/SMB/FUSE-T) hits OS restrictions and upstream bugs on macOS 26 (Apple Silicon); this repo ships no mounting solution — use VS Code Remote-SSH to browse remote files instead

## License

MIT — see [LICENSE](LICENSE)
