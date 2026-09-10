# dsh-toolkit

A record of the changes I made to DeepSeek Harness (`dsh`). Not an open-source project — a personal archive.

[中文](README.md)

| Project | Description |
|---|---|
| `tools/update-dsh.mjs` | Upgrade control: managed install, backup, smoke test, config diff, rollback, channels, prune |
| `tools/migrate-dsh.mjs` | Whole-workbench pack and restore: data, config, plugins, remote inventory |
| `dsh-remote/` | Multi-server remote panel: SSH-tunnel or local direct mode, web UI + launchd resident |
| `plugins/dsh-plugin-amend/` | Plugin example: amend history via surface-replace, log stays append-only |
| `skills/gpu-partition/` | Remote-GPU workspace template (ssh/rsync) |

## Log

- `update-dsh`: 0.1.0-rc.6 → 0.1.1-rc.2 → 0.1.2-alpha.5 all verified (backup, config diff, smoke, switch, rollback)
- `migrate-dsh`: full run verified (pack → restore into a fresh home → reinstall engine → real boot)
- `dsh-plugin-amend`: surface-replace verified (surface layer replaced, original log stays append-only)
- `dsh-remote`: panel and instances run as launchd residents; tunnel mode requires passwordless SSH; stale-PID "false alive" fixed
- Dead end: a true system mount of a remote directory (WebDAV / SMB / FUSE-T) on macOS 26 + Apple Silicon

## Environment

macOS (Apple Silicon), Node 22+, zero dependencies (Node built-ins only)

## License

MIT
