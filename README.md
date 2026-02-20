# Obsidian MCP Server

MCP (Model Context Protocol) server for direct Obsidian vault access. Works without Obsidian running.

## Features

23 tools for complete vault management and deterministic multi-project workflows:

### Core Tools
| Tool | Description |
|------|-------------|
| `vault_read` | Read a single note |
| `vault_batch_read` | Read multiple notes at once |
| `vault_write` | Create or update a note |
| `vault_append` | Append content to existing note |
| `vault_delete` | Delete a note |
| `vault_move` | Move or rename notes |

### Discovery Tools
| Tool | Description |
|------|-------------|
| `vault_list` | List files/folders |
| `vault_tree` | Get folder hierarchy |
| `vault_search` | Search text across all notes |
| `vault_recent` | Find recently modified files |
| `vault_find_by_tag` | Find docs by frontmatter tag |
| `vault_frontmatter` | Query/update YAML metadata |

### Maintenance Tools
| Tool | Description |
|------|-------------|
| `vault_backlinks` | Find docs linking to a given doc |
| `vault_broken_links` | Find broken wiki-links |
| `vault_stats` | Vault health and statistics |
| `vault_stale_state_checks` | Stale-state checks across project contexts/trackers |
| `vault_daily_note` | Access daily notes |
| `vault_context_bootstrap` | Load startup context pack in one call |
| `vault_upsert_section` | Replace or insert a specific markdown section |

### Flywheel Macro Tools (Deterministic)
| Tool | Description |
|------|-------------|
| `vault_start_session` | Resolve active project + run scoped bootstrap + summarize priorities/blockers/next actions |
| `vault_checkpoint` | Update project context + append session log + pointer note + optional tracker sync |
| `vault_tracker_sync` | Structured tracker sync (JSON state + rendered table + sync log) |
| `vault_resume` | Deterministic post-compact resume from project context/session log/tracker |

## Setup

### 1. Install Dependencies

```bash
cd obsidian-mcp
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Configure Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### 4. Restart Cursor

The MCP server loads on Cursor startup.

## Configuration

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `OBSIDIAN_VAULT_PATH` | Full path to your Obsidian vault folder | Yes |

## Usage Examples

### Start session (deterministic)
```text
vault_start_session
```

### Start session with project override
```text
vault_start_session override_project_context_path="Work/Projects/AI Tools/MCP - Obsidian AI Cortex/_Context.md"
```

### Scoped bootstrap (no cross-project recency bleed)
```text
vault_context_bootstrap project_context_path="Work/Projects/AI Tools/MCP - Obsidian AI Cortex/_Context.md" include_recent=true recent_path="Work/Projects/AI Tools/MCP - Obsidian AI Cortex"
```

### Deterministic checkpoint
```text
vault_checkpoint priorities=["Validate startup macro in Cursor","Validate resume macro in Claude"] blockers=["None"] next_actions=["Run end-to-end test","Document edge cases","Tune thresholds"]
```

### Structured tracker sync
```text
vault_tracker_sync updates=[{"id":"E18","status":"In Validation","note":"Ready for QA"}]
```

### Resume after compact
```text
vault_resume
```

### Stale-state checks
```text
vault_stale_state_checks tracker_stale_days=7 validation_stale_days=14 project_context_stale_days=14
```

## Structured Tracker Model

`vault_tracker_sync` maintains machine-first tracker sections:

- `## Tracker State (JSON)` — canonical structured issue state
- `## Tracker Table` — rendered markdown view from canonical JSON
- `## Tracker Sync Log` — deterministic audit trail of updates

This reduces ambiguous table edits and token-heavy revalidation.

## Development

### Build
```bash
npm run build
```

### Watch mode
```bash
npm run dev
```

## Tech Stack

- Node.js / TypeScript
- MCP SDK (`@modelcontextprotocol/sdk`)
- gray-matter (frontmatter parsing)
- zod (parameter validation)

## Security

- No credentials stored in code
- Vault path configured via environment variable
- Direct filesystem access (no network calls)
- Path traversal blocked (paths cannot escape vault root)
- Frontmatter `updated` is auto-refreshed on write/append/frontmatter updates

## License

MIT
