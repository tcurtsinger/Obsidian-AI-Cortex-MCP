# Obsidian AI Cortex MCP

Deterministic, filesystem-native MCP server for Obsidian vaults.

Use it to let AI agents (Cursor, Claude Code, Codex, etc.) safely read/write notes, route to the correct project context, checkpoint before compact, and resume exactly where work left off.

> Works without Obsidian running. Uses direct filesystem access.

---

## Why this exists

Most AI coding workflows fail in long sessions because of:

- cross-project context bleed
- stale or missing session memory after compact
- trackers drifting out of sync
- token-heavy startup context gathering

This server solves that with a **deterministic flywheel** built into MCP tools.

---

## What you get

- **23 vault tools** (read/write/search/discovery/maintenance)
- **Deterministic session macros**:
  - `vault_start_session`
  - `vault_checkpoint`
  - `vault_tracker_sync`
  - `vault_resume`
- **Structured tracker model** (machine-first JSON + rendered table + sync log)
- **Project-scoped bootstrap** to avoid recency bleed
- **Stale-state health checks** for project contexts + trackers
- **Path-safety guardrails** (path traversal blocked to vault root)
- **Auto `updated` frontmatter touch** on write/append/frontmatter updates

---

## Install

### Prerequisites

- Node.js **18+**
- An Obsidian vault folder on local disk

### 1) Clone

```bash
git clone https://github.com/tcurtsinger/Obsidian-AI-Cortex-MCP.git
cd Obsidian-AI-Cortex-MCP
```

### 2) Install dependencies

```bash
npm install
```

### 3) Build

```bash
npm run build
```

### 4) Configure your MCP client

Set `OBSIDIAN_VAULT_PATH` to your vault root.

Example (Cursor-style MCP config):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/Obsidian-AI-Cortex-MCP/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

---

## Starter Vault (demo)

A ready-to-use demo vault is included at:

- `starter-vault/`

This is the fastest way to validate your MCP setup and deterministic flywheel behavior.

### What is included

- `_Context/Now.md` with `active_project_context`
- one demo project context
- one configured tracker (`tracker_path`)
- one demo session log
- minimal prompt templates

### Starter vault layout

```text
starter-vault/
?? Home.md
?? _Context/
?  ?? Now.md
?? Prompts/
?  ?? Index.md
?  ?? 00 - Start Macro.md
?  ?? 01 - Checkpoint Macro.md
?  ?? 02 - Tracker Sync Macro.md
?  ?? 03 - Resume Macro.md
?? Work/
   ?? Projects/
   ?  ?? Projects Index.md
   ?  ?? AI Tools/
   ?     ?? MCP - Demo Project/
   ?        ?? _Context.md
   ?        ?? Defect & Enhancement Tracker.md
   ?        ?? Session Logs/2026-02-20.md
   ?? Session End Logs/
      ?? Index.md
      ?? 2026-02-20.md
```

### Recommended setup

Copy the starter vault to a separate location before using it (so your repo working tree stays clean):

**macOS/Linux**

```bash
cp -R starter-vault "$HOME/Obsidian-AI-Cortex-Starter-Vault"
```

**Windows PowerShell**

```powershell
Copy-Item -Path .\starter-vault -Destination "$env:USERPROFILE\Documents\Obsidian-AI-Cortex-Starter-Vault" -Recurse
```

Then set `OBSIDIAN_VAULT_PATH` to that copied folder and run:

```text
Use Obsidian MCP for this session.
Run start macro now.
```

---

## Quick start (recommended workflow)

In a brand-new chat, use:

```text
Use Obsidian MCP for this session.
Run start macro now.
```

Or with explicit project override:

```text
Use Obsidian MCP for this session.
Run start macro now.
override_project_context_path="Work/Projects/<Area>/<Project Name>/_Context.md"
```

Then use these one-liners during work:

- `Run checkpoint macro now.`
- `Run tracker sync macro now.`
- `Run resume macro now.`

---

## Deterministic flywheel model

### Session start

`vault_start_session`:

1. Resolves active project context path
2. Runs scoped bootstrap
3. Returns **target-project-only** summary:
   - priorities
   - blockers
   - next 3 actions

### Checkpoint

`vault_checkpoint`:

- updates project context sections (if provided)
- appends canonical project session log
- maintains pointer note
- optionally runs tracker sync

### Tracker sync

`vault_tracker_sync`:

- updates canonical tracker JSON state
- re-renders tracker table
- appends sync audit log
- supports structured `updates` payload for deterministic edits

### Resume

`vault_resume` restores from:

1. project `_Context.md`
2. `_Context/Now.md` routing metadata
3. latest project session log
4. tracker (if configured)

---

## Structured tracker format

Trackers are maintained in this canonical shape:

~~~md
## Tracker State (JSON)

```json
[]
```

## Tracker Table
| ID | Type | Status | Priority | Updated | Title | Note |

## Tracker Sync Log
- <timestamp> | updated=... | created=... | deleted=... | unresolved=...
~~~

**Rule:** JSON state is canonical. Table is a rendered view.

---

## Tool catalog (23)

### Core tools

- `vault_read`
- `vault_batch_read`
- `vault_write`
- `vault_append`
- `vault_delete`
- `vault_move`

### Discovery tools

- `vault_list`
- `vault_tree`
- `vault_search`
- `vault_recent`
- `vault_find_by_tag`
- `vault_frontmatter`

### Maintenance tools

- `vault_backlinks`
- `vault_broken_links`
- `vault_stats`
- `vault_daily_note`
- `vault_context_bootstrap`
- `vault_upsert_section`
- `vault_stale_state_checks`

### Deterministic macro tools

- `vault_start_session`
- `vault_checkpoint`
- `vault_tracker_sync`
- `vault_resume`

---

## High-value usage examples

### Start session with project override

```text
vault_start_session override_project_context_path="Work/Projects/AI Tools/MCP - Obsidian AI Cortex/_Context.md"
```

### Scoped bootstrap (avoid cross-project recency bleed)

```text
vault_context_bootstrap project_context_path="Work/Projects/AI Tools/MCP - Obsidian AI Cortex/_Context.md" include_recent=true recent_path="Work/Projects/AI Tools/MCP - Obsidian AI Cortex"
```

### Checkpoint with explicit status

```text
vault_checkpoint priorities=["Validate start/checkpoint/resume in all IDEs"] blockers=["None"] next_actions=["Run stale checks","Review tracker drift","Finalize docs"] summary_note="Milestone checkpoint"
```

### Deterministic tracker update

```text
vault_tracker_sync updates=[{"id":"E18","status":"In Validation","note":"Ready for QA"}]
```

### Resume after compact

```text
vault_resume
```

### Run stale-state health checks

```text
vault_stale_state_checks tracker_stale_days=7 validation_stale_days=14 project_context_stale_days=14
```

---

## Suggested vault conventions

These are conventions that make the macros most reliable:

- `_Context/Now.md` contains routing metadata and `active_project_context`
- project details live in `Work/Projects/.../_Context.md`
- project logs live in:
  - `Work/Projects/<Area>/<Project>/Session Logs/YYYY-MM-DD.md`
- root `Work/Session End Logs/` remains pointer-only
- trackers are configured via project frontmatter key:
  - `tracker_path: Work/Projects/<Area>/<Project>/Defect & Enhancement Tracker.md`

---

## Scripts

```bash
npm run build   # compile TypeScript to dist/
npm run dev     # tsc --watch
npm run start   # run built server
```

---

## Security model

- No secrets hard-coded in repo
- Vault location provided only via environment variable
- Path normalization + vault-root boundary checks
- Direct local filesystem operations (no required external API)

---

## Troubleshooting

### `OBSIDIAN_VAULT_PATH environment variable is required`
Set the env var in your MCP client config and restart the client.

### Wrong project loaded at start
Your `active_project_context` in `_Context/Now.md` is likely stale. Either:
- update that pointer, or
- pass `override_project_context_path` to `vault_start_session`

### Tracker sync says no tracker configured
Add `tracker_path` in project `_Context.md` frontmatter.

---

## Tech stack

- TypeScript
- Node.js
- `@modelcontextprotocol/sdk`
- `gray-matter`
- `zod`

---

## License

MIT

If you use this in production AI workflows, consider opening issues/PRs with edge cases from real multi-project sessions.
