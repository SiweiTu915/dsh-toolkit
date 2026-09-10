# dsh-toolkit

[中文](README.md)

| Project | Description |
|---|---|
| `tools/update-dsh.mjs` | Upgrade control: managed install, backup, smoke test, config diff, rollback, channels, prune |
| `tools/migrate-dsh.mjs` | Whole-workbench pack and restore: data, config, plugins, remote inventory |
| `dsh-remote/` | Multi-server remote panel: SSH-tunnel or local direct mode, web UI + launchd resident; `workbench.mjs` creates a remote-mounted workbench in one click; `rw.mjs` edits remote files without a local copy |
| `plugins/dsh-{fs,subprocess,bash,directory-picker}-sftp/` | Move the whole execution world to the remote host: one provider per seam, so `read`/`write`/`edit`, `bash`, `glob`/`grep` and "Add workspace" all run on the remote machine while the local side keeps only a 0-byte mount point |
| `plugins/dsh-plugin-amend/` | Plugin example: amend history via surface-replace, log stays append-only |
| `plugins/dsh-remote-ui/` | Client plugin example: sidebar trigger plus a right-side remote file drawer |
| `skills/gpu-partition/` | Remote-GPU workspace template (mounted mode + rw.mjs) |

Change log (verification, dead ends) in [CHANGELOG.md](CHANGELOG.md).

## Environment

macOS (Apple Silicon), Node 22+, zero dependencies (Node built-ins only)

## License

MIT
