# dsh-toolkit

[中文](README.md)

| Project | Description |
|---|---|
| `tools/update-dsh.mjs` | Upgrade control: managed install, backup, smoke test, config diff, rollback, channels, prune |
| `tools/migrate-dsh.mjs` | Whole-workbench pack and restore: data, config, plugins, remote inventory |
| `dsh-remote/` | Multi-server remote panel: SSH-tunnel or local direct mode, web UI + launchd resident |
| `plugins/dsh-plugin-amend/` | Plugin example: amend history via surface-replace, log stays append-only |
| `skills/gpu-partition/` | Remote-GPU workspace template (ssh/rsync) |

Change log (verification, dead ends) in [CHANGELOG.md](CHANGELOG.md).

## Environment

macOS (Apple Silicon), Node 22+, zero dependencies (Node built-ins only)

## License

MIT
