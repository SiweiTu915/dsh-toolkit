# dsh-toolkit

Some tools, plugins and skills I put together while using [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) myself.

Not a framework, not a product for others — just the things I kept re-doing on my own machine, gradually turned into scripts and put here. **Made for my own use; take what's useful. No promise of generality, no support.**

[中文](README.md)

## Why these exist

dsh is still in rc/alpha, so an upgrade can easily break something and a new machine means setting everything up again. These are the gaps I kept hitting:

- **`tools/update-dsh.mjs`** — upgrades without guesswork: back up, prefetch the new version, smoke-test it, diff the config, and only then switch; rollback is one command. Also handles channels like `alpha` and cleans up old versions.
- **`tools/migrate-dsh.mjs`** — pack sessions, settings, plugins and the remote inventory into one archive, restore it on a new machine.
- **`dsh-remote/`** — I have more than one machine and wanted each of them to be its own workspace, managed from a single panel (connect / open / status).
- **`plugins/dsh-plugin-amend/`** — sometimes I want to amend a sentence in past conversation without breaking the append-only log; this uses the same surface-replace mechanism as compaction.
- **`skills/gpu-partition/`** — remote GPU boxes as pure compute: the local agent does the work over ssh/rsync. This one is a template I extracted from my own setup.

## Layout

| Path | What it is |
|---|---|
| `tools/update-dsh.mjs` | Upgrade management (managed install / update / rollback / prune) |
| `tools/migrate-dsh.mjs` | Whole-workbench pack & restore |
| `dsh-remote/` | Multi-server remote panel (SSH tunnel or local direct; web UI + resident service) |
| `plugins/dsh-plugin-amend/` | Example plugin: amend history while keeping the log append-only |
| `skills/gpu-partition/` | Remote-GPU workspace template (ssh/rsync) |
| `docs/USAGE.md` | Command cheat-sheet, mostly still valid after upgrades (Chinese) |

## Usage

Needs **Node 22+** and a working `dsh`.

```sh
git clone <this-repo> && cd dsh-toolkit

node tools/update-dsh.mjs status     # what version am I on, what channels exist
node tools/update-dsh.mjs update     # backup → prefetch → smoke → diff → confirm → switch
node tools/update-dsh.mjs rollback   # when it goes wrong

node tools/migrate-dsh.mjs pack              # → dsh-migrate-*.tar.gz
node tools/migrate-dsh.mjs restore <archive> # on the target machine
```

Remote panel (optionally as a resident service):

```sh
bash dsh-remote/install-supervisor.sh install
node dsh-remote/cli.mjs list / connect <name> / open <name>
```

Skills: copy `skills/*` into `$DSH_HOME/skills/` (default `~/.dsh/skills/`) and they are picked up automatically — no config change needed.

Plugin:

```sh
cd ~/.dsh && dsh plugin --profile web add <path-to-this-repo>/plugins/dsh-plugin-amend
```

## Honest notes

- I run this on **macOS (Apple Silicon)**; the tools have only been tried on macOS/Linux, not Windows
- Zero dependencies — Node built-ins only; the remote panel uses just ssh/rsync and what the OS ships
- **dsh is moving fast**, so any of this may need to follow it; I fix things as my own use requires, and compatibility isn't promised
- Traps I already hit, so you don't have to:
  - `dsh-plugin-amend` only replaces message **text** (hide/restore not implemented); showing amendments in the UI needs a client-side Definition
  - `dsh-remote` tunnel mode **requires passwordless SSH** — a detached connection can't type a password
  - On **macOS 26 + Apple Silicon**, turning a remote directory into a **real system mount** (WebDAV / SMB / FUSE-T) basically doesn't work (OS restrictions + upstream bugs). Don't burn time on it — use VS Code Remote-SSH to browse remote files.

## License

MIT, do whatever — see [LICENSE](LICENSE)
