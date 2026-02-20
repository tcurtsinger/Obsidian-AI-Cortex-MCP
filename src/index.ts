/**
 * Obsidian MCP Server
 * 
 * Direct filesystem access to Obsidian vaults for:
 * - Reading and writing notes
 * - Searching across the vault
 * - Managing daily notes
 * - Frontmatter operations
 * - File/folder listing and management
 * 
 * Works without Obsidian running - direct file access.
 * 
 * Configuration via environment variables:
 *   OBSIDIAN_VAULT_PATH - Path to your Obsidian vault (required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVaultTools } from "./tools/vault.js";

// Validate vault path is configured
function getVaultPath(): string {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  
  if (!vaultPath) {
    console.error("ERROR: OBSIDIAN_VAULT_PATH environment variable is required");
    console.error("Set it to the full path of your Obsidian vault folder");
    process.exit(1);
  }
  
  return vaultPath;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.error("Starting Obsidian MCP Server...");
  
  // Validate configuration
  const vaultPath = getVaultPath();
  console.error(`Vault path: ${vaultPath}`);
  
  // Create MCP server
  const server = new McpServer({
    name: "obsidian-mcp",
    version: "1.2.0"
  });
  
  // Register all vault tools
  console.error("Registering tools...");
  registerVaultTools(server, vaultPath);
  console.error("Tool registration complete");
  
  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error("Obsidian MCP Server running");
}

// Handle errors
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
