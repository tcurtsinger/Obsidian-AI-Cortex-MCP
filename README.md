# Obsidian AI Cortex MCP

Generic MCP (Model Context Protocol) server for direct Obsidian vault access.  
It works with Claude Desktop, Claude Code, Codex, Cursor, and other MCP clients.

## What It Does

- Read, write, append, move, and delete markdown notes.
- Search across your vault and inspect folder structure.
- Manage frontmatter and daily notes.
- Run vault health checks (backlinks, broken links, freshness, context integrity).
- Load startup context in one call and safely upsert markdown sections.

## Tools Included

### Core
| Tool | Description |
|------|-------------|
| `vault_read` | Read one note |
| `vault_batch_read` | Read multiple notes |
| `vault_write` | Create or overwrite a note |
| `vault_append` | Append content to a note |
| `vault_delete` | Delete a note |
| `vault_move` | Move or rename a note |

### Discovery
| Tool | Description |
|------|-------------|
| `vault_list` | List files and folders |
| `vault_tree` | Return folder hierarchy |
| `vault_search` | Full-text search |
| `vault_recent` | Recently modified notes |
| `vault_find_by_tag` | Find notes by frontmatter tags |
| `vault_frontmatter` | Get/set frontmatter |

### Maintenance
| Tool | Description |
|------|-------------|
| `vault_backlinks` | Find notes linking to a target note |
| `vault_broken_links` | Find unresolved wiki links |
| `vault_stats` | Vault health and stats |
| `vault_daily_note` | Read/create daily notes |
| `vault_context_bootstrap` | Load core context notes + recent changes |
| `vault_upsert_section` | Replace or insert a markdown section by heading |

## Quick Start

```bash
git clone https://github.com/tcurtsinger/Obsidian-AI-Cortex-MCP.git
cd Obsidian-AI-Cortex-MCP
npm install
npm run build
```

## Server Configuration

Set this required environment variable:

| Variable | Required | Description |
|----------|----------|-------------|
| `OBSIDIAN_VAULT_PATH` | Yes | Absolute path to your Obsidian vault |

Use this MCP server definition in your client config:

```json
{
  "mcpServers": {
    "obsidian-ai-cortex": {
      "command": "node",
      "args": ["/absolute/path/to/Obsidian-AI-Cortex-MCP/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your-vault"
      }
    }
  }
}
```

## Client Examples

### Codex CLI

```bash
codex mcp add obsidian-ai-cortex \
  --env OBSIDIAN_VAULT_PATH="/absolute/path/to/your-vault" \
  -- node "/absolute/path/to/Obsidian-AI-Cortex-MCP/dist/index.js"
```

### Cursor

Add the same server block to your Cursor MCP config (commonly `.cursor/mcp.json`).

### Claude Desktop / Claude Code

Add the same server block to your MCP server configuration for each app.

## Optional Context Convention

If you keep these notes, `vault_context_bootstrap` and `vault_stats` become more useful:

- `Home.md`
- `_Context/Now.md`
- `_Context/Project.md`
- `_Context/Index.md`

You can still use all tools without this structure.

## Usage Examples

```text
vault_read path="Home.md"
vault_search query="roadmap" limit=10
vault_context_bootstrap project_context_path="_Context/Project.md"
vault_upsert_section path="_Context/Now.md" heading="Current Sprint" level=2 content="- Task 1"
vault_stats
```

## Security

- Path traversal is blocked (tools cannot escape vault root).
- No credentials are required or stored.
- Frontmatter `updated` is auto-refreshed on write/append/frontmatter updates.

## Development

```bash
npm run build
npm run dev
```

## License

MIT
