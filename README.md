# nev-dru's Claude Code plugins

Personal plugin marketplace for [Claude Code](https://claude.com/claude-code).

## Install

```
/plugin marketplace add nev-dru/claude-plugins
```

## Plugins

| Plugin | Repo | Description |
|---|---|---|
| `agents-md` | [nev-dru/agents-md-plugin](https://github.com/nev-dru/agents-md-plugin) | Generate, audit, and maintain evidence-based AGENTS.md context files. |
| `pseudoplan` | [`pseudoplan/`](./pseudoplan) (in this repo) | Plan code changes as reviewable pseudocode, approved in the browser before any code is written; also reviews existing diffs. |

Install a plugin with:

```
/plugin install agents-md@nev-dru
```

## Adding a plugin

Each plugin lives in its own repo with a `.claude-plugin/plugin.json`, or in a subfolder here with `"source": "./folder"`.
To list it here, add an entry to `.claude-plugin/marketplace.json`:

```json
{
  "name": "my-plugin",
  "source": { "source": "github", "repo": "nev-dru/my-plugin-repo" },
  "description": "What it does."
}
```
