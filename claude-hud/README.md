# claude-hud setup for Claude Code (Windows + Git Bash)

How I run [claude-hud](https://github.com/jarrodwatts/claude-hud) (v0.8.0) as the Claude Code status line on Windows, with Git Bash as the shell Claude Code uses for commands.

## Requirements

- Claude Code v1.0.80+
- Node.js 18+ on `PATH` (required on Windows; macOS/Linux can also use Bun). On Windows: `winget install OpenJS.NodeJS.LTS`
- Git for Windows (Git Bash), since the status line command below is a POSIX shell snippet

## 1. Install the plugin

```bash
claude plugin marketplace add jarrodwatts/claude-hud
claude plugin install claude-hud@claude-hud
```

Or inside Claude Code: `/plugin marketplace add jarrodwatts/claude-hud`, then `/plugin install claude-hud`.

The install puts the built HUD in `~/.claude/plugins/cache/claude-hud/claude-hud/<version>/dist/index.js`.

## 2. Status line wrapper

Instead of the command `/claude-hud:setup` writes, I use a wrapper in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cols=${COLUMNS:-}; case \"$cols\" in \"\"|*[!0-9]*) cols=$(stty size </dev/tty 2>/dev/null | awk '{print $2}');; esac; case \"$cols\" in \"\"|*[!0-9]*) cols=120;; esac; export COLUMNS=$(( cols > 4 ? cols - 4 : 1 )); plugin_dir=$(ls -1d \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"/plugins/cache/*/claude-hud/*/ 2>/dev/null | sort -V | tail -1); exec node \"${plugin_dir}dist/index.js\"",
    "refreshInterval": 60
  }
}
```

What it does:

1. **Width.** Takes `COLUMNS`, falls back to `stty size` on the terminal, then to 120. It exports the width minus 4, so the HUD never wraps against the edge of the prompt box.
2. **Newest build.** Finds every cached `claude-hud/<version>/` under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/` and picks the highest version (`sort -V | tail -1`). A plugin update is picked up without editing settings, and `CLAUDE_CONFIG_DIR` setups work too.
3. **Runs the build directly** with `exec node .../dist/index.js`. It does not go through the plugin system, so the HUD keeps rendering even if you disable the plugin (for example to hide its slash commands).
4. **`refreshInterval: 60`** re-runs the HUD every 60 seconds between messages, so the session duration and usage-reset countdowns don't go stale. Claude Code otherwise only re-runs the status line after an interaction. Use 5 if you want faster countdowns; each refresh re-runs the command.

## 3. Display config

`~/.claude/plugins/claude-hud/config.json`:

```json
{
  "display": {
    "showTools": true,
    "showAgents": true,
    "showTodos": true,
    "showDuration": true,
    "showConfigCounts": true,
    "showSessionName": true,
    "showSkills": true,
    "showCompactions": true,
    "showEffortLevel": true
  }
}
```

Tool, skill, agent and todo lines are hidden by default and only appear while there is activity. `/claude-hud:configure` edits this file interactively and keeps manual keys it doesn't manage.

## Offline variant (no GitHub access)

On a machine that can't reach GitHub (so `marketplace add` fails), copy the plugin over by hand:

1. On a machine that has it, copy `dist/`, `commands/` and `package.json` from `~/.claude/plugins/cache/claude-hud/claude-hud/<version>/`.
2. Put them anywhere on the target, e.g. `~/.claude/plugins/claude-hud/`.
3. Point the status line at that copy with an absolute path, forward slashes:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/path/to/.claude/plugins/claude-hud/dist/index.js\"",
    "refreshInterval": 60
  }
}
```

`dist/` is the prebuilt bundle, so no `npm install` is needed. `commands/` only matters if you also want the `/claude-hud:*` commands.

## Check it

Run the command by hand with sample stdin:

```bash
echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/tmp"},"cwd":"/tmp","transcript_path":"","session_id":"x"}' | COLUMNS=120 node "$(ls -1d ~/.claude/plugins/cache/*/claude-hud/*/ | sort -V | tail -1)dist/index.js"
```

You should see the model badge, the directory and a context bar.

## Troubleshooting

- **Nothing shows after setup.** Settings reload automatically, but the status line only renders after your next message. If it still doesn't show, restart Claude Code.
- **HUD is blank in every session.** Check that `CLAUDE_HUD_DISABLE` isn't set (for example exported from a shell profile). `CLAUDE_HUD_DISABLE=1 claude` is the intended way to start one session without it.
- **Config changes are ignored.** Invalid JSON in `config.json` silently falls back to the defaults. Validate it, or delete it and rerun `/claude-hud:configure`.
- **`node: command not found`.** Claude Code runs the status line in Git Bash; make sure `node` resolves there (`which node`). If it doesn't, put the full path to `node` in the `exec` call instead.
