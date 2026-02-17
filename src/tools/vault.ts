/**
 * Obsidian Vault Tools
 * 
 * Direct filesystem operations for Obsidian vaults:
 * - Read/write/delete notes
 * - Search across vault
 * - Daily notes
 * - Frontmatter management
 * - File listing and tree view
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";

/**
 * Helper: Check if a path exists
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper: Ensure directory exists for a file path
 */
async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Helper: Get all markdown files recursively
 */
async function getMarkdownFiles(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // Skip hidden files/folders (like .obsidian, .git)
      if (entry.name.startsWith('.')) continue;
      
      if (entry.isDirectory()) {
        // Recursively get files from subdirectories
        const subFiles = await getMarkdownFiles(fullPath, baseDir);
        files.push(...subFiles);
      } else if (entry.name.endsWith('.md')) {
        // Store relative path from vault root
        const relativePath = path.relative(baseDir, fullPath);
        files.push(relativePath);
      }
    }
  } catch (error) {
    // Directory might not exist or be inaccessible
    console.error(`Error reading directory ${dir}: ${error}`);
  }
  
  return files;
}

/**
 * Helper: Format date for daily notes (YYYY-MM-DD)
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Helper: normalize a user-supplied relative path and block vault traversal.
 */
function normalizeRelativePath(userPath: string): string {
  const raw = userPath.trim().replace(/\\/g, "/");
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error(`Absolute paths are not allowed: ${userPath}`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path escapes vault root: ${userPath}`);
  }
  return normalized === "." ? "" : normalized;
}

/**
 * Helper: normalize note paths and ensure .md extension.
 */
function normalizeNotePath(userPath: string): string {
  const normalized = normalizeRelativePath(userPath);
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

/**
 * Helper: Resolve a normalized relative path to an absolute vault path.
 */
function resolveVaultPath(vaultRoot: string, relativePath: string): string {
  const normalizedRelative = normalizeRelativePath(relativePath);
  const fullPath = path.resolve(vaultRoot, normalizedRelative || ".");
  const rel = path.relative(vaultRoot, fullPath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    throw new Error(`Path escapes vault root: ${relativePath}`);
  }
  return fullPath;
}

/**
 * Helper: today's date in YYYY-MM-DD.
 */
function getTodayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Helper: add/update frontmatter.updated.
 */
function touchUpdated(frontmatter: Record<string, any>): Record<string, any> {
  return {
    ...frontmatter,
    updated: getTodayIsoDate(),
  };
}

/**
 * Helper: normalize frontmatter updated date value to YYYY-MM-DD when possible.
 */
function normalizeUpdatedDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Helper: extract wiki-link targets from markdown.
 */
function extractWikiLinkTargets(markdown: string): Set<string> {
  const links = new Set<string>();
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1].trim().replace(/\\/g, "/").replace(/\.md$/i, "");
    if (!target) continue;
    links.add(target.toLowerCase());
    links.add(path.posix.basename(target).toLowerCase());
  }
  return links;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Registers all vault tools with the MCP server
 */
export function registerVaultTools(server: McpServer, vaultPath: string): void {
  const vaultRoot = path.resolve(vaultPath);

  function resolveNotePath(notePath: string): { normalizedPath: string; fullPath: string } {
    const normalizedPath = normalizeNotePath(notePath);
    return {
      normalizedPath,
      fullPath: resolveVaultPath(vaultRoot, normalizedPath),
    };
  }

  function resolveDirectoryPath(dirPath: string): { normalizedPath: string; fullPath: string } {
    const normalizedPath = normalizeRelativePath(dirPath);
    return {
      normalizedPath,
      fullPath: resolveVaultPath(vaultRoot, normalizedPath),
    };
  }

  // ============================================================
  // READ NOTE
  // ============================================================
  
  server.tool(
    "vault_read",
    `Read a note from the Obsidian vault.

Args:
  - path (string, required): Path to the note relative to vault root (e.g., 'Projects/MyProject.md')
  - include_frontmatter (boolean): Whether to parse and include frontmatter separately (default: true)

Returns:
  Note content, optionally with parsed frontmatter`,
    {
      path: z.string().describe("Path to note relative to vault root"),
      include_frontmatter: z.boolean().default(true).describe("Parse frontmatter separately")
    },
    async ({ path: notePath, include_frontmatter }) => {
      try {
        const { normalizedPath, fullPath } = resolveNotePath(notePath);
        
        // Check if file exists
        if (!await pathExists(fullPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Note not found: ${normalizedPath}`
              }, null, 2)
            }]
          };
        }
        
        // Read file content
        const rawContent = await fs.readFile(fullPath, 'utf-8');
        
        if (include_frontmatter) {
          // Parse frontmatter
          const { data: frontmatter, content } = matter(rawContent);
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                path: normalizedPath,
                frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
                content: content.trim()
              }, null, 2)
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                path: normalizedPath,
                content: rawContent
              }, null, 2)
            }]
          };
        }
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // WRITE NOTE
  // ============================================================
  
  server.tool(
    "vault_write",
    `Create or update a note in the Obsidian vault.

Args:
  - path (string, required): Path to the note relative to vault root
  - content (string, required): The markdown content to write
  - frontmatter (object, optional): YAML frontmatter to add/update
  - mode (string): 'overwrite' (default), 'append', or 'prepend'

Returns:
  Success status and file path`,
    {
      path: z.string().describe("Path to note relative to vault root"),
      content: z.string().describe("Markdown content to write"),
      frontmatter: z.record(z.any()).optional().describe("YAML frontmatter object"),
      mode: z.enum(["overwrite", "append", "prepend"]).default("overwrite").describe("Write mode")
    },
    async ({ path: notePath, content, frontmatter, mode }) => {
      try {
        const { normalizedPath, fullPath } = resolveNotePath(notePath);
        
        // Ensure parent directory exists
        await ensureDir(fullPath);
        
        let finalContent: string;
        let existingContent = "";
        let existingFrontmatter: Record<string, any> = {};

        if (await pathExists(fullPath)) {
          const rawContent = await fs.readFile(fullPath, "utf-8");
          const parsed = matter(rawContent);
          existingContent = parsed.content;
          existingFrontmatter = parsed.data;
        }
        
        if (mode === "overwrite") {
          // Preserve existing frontmatter by default and keep updated date fresh.
          const mergedFrontmatter = frontmatter
            ? { ...existingFrontmatter, ...frontmatter }
            : existingFrontmatter;

          if (Object.keys(mergedFrontmatter).length > 0) {
            finalContent = matter.stringify(content, touchUpdated(mergedFrontmatter));
          } else {
            finalContent = matter.stringify(content, { updated: getTodayIsoDate() });
          }
        } else {
          // Merge frontmatter if provided
          const mergedFrontmatter = frontmatter 
            ? { ...existingFrontmatter, ...frontmatter }
            : existingFrontmatter;
          
          // Combine content based on mode
          const combinedContent = mode === "append"
            ? `${existingContent}\n\n${content}`
            : `${content}\n\n${existingContent}`;
          
          if (Object.keys(mergedFrontmatter).length > 0) {
            finalContent = matter.stringify(combinedContent.trim(), touchUpdated(mergedFrontmatter));
          } else {
            finalContent = matter.stringify(combinedContent.trim(), { updated: getTodayIsoDate() });
          }
        }
        
        // Write the file
        await fs.writeFile(fullPath, finalContent, 'utf-8');
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Note ${mode === "overwrite" ? "saved" : mode + "ed"} successfully`,
              path: normalizedPath
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // DELETE NOTE
  // ============================================================
  
  server.tool(
    "vault_delete",
    `Delete a note from the Obsidian vault.

Args:
  - path (string, required): Path to the note relative to vault root

Returns:
  Success status`,
    {
      path: z.string().describe("Path to note relative to vault root")
    },
    async ({ path: notePath }) => {
      try {
        const { normalizedPath, fullPath } = resolveNotePath(notePath);
        
        // Check if file exists
        if (!await pathExists(fullPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Note not found: ${normalizedPath}`
              }, null, 2)
            }]
          };
        }
        
        // Delete the file
        await fs.unlink(fullPath);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Note deleted successfully",
              path: normalizedPath
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // LIST FILES/FOLDERS
  // ============================================================
  
  server.tool(
    "vault_list",
    `List files and folders in the Obsidian vault.

Args:
  - path (string, optional): Path relative to vault root (default: root)
  - recursive (boolean): Include subdirectories (default: false)
  - include_content_preview (boolean): Include first 100 chars of each note (default: false)

Returns:
  List of files and folders`,
    {
      path: z.string().default("").describe("Path relative to vault root"),
      recursive: z.boolean().default(false).describe("Include subdirectories"),
      include_content_preview: z.boolean().default(false).describe("Include content preview")
    },
    async ({ path: dirPath, recursive, include_content_preview }) => {
      try {
        const { normalizedPath: normalizedDirPath, fullPath } = resolveDirectoryPath(dirPath);
        
        // Check if directory exists
        if (!await pathExists(fullPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Directory not found: ${normalizedDirPath || "/"}`
              }, null, 2)
            }]
          };
        }
        
        interface FileInfo {
          name: string;
          type: "file" | "folder";
          path: string;
          preview?: string;
        }
        
        const items: FileInfo[] = [];
        
        if (recursive) {
          // Get all markdown files recursively
          const files = await getMarkdownFiles(fullPath, vaultRoot);
          
          for (const filePath of files) {
            const item: FileInfo = {
              name: path.basename(filePath),
              type: "file",
              path: filePath
            };
            
            if (include_content_preview) {
              try {
                const content = await fs.readFile(resolveVaultPath(vaultRoot, filePath), 'utf-8');
                const { content: body } = matter(content);
                item.preview = body.substring(0, 100).trim() + (body.length > 100 ? "..." : "");
              } catch {
                item.preview = "(unable to read)";
              }
            }
            
            items.push(item);
          }
        } else {
          // List immediate children only
          const entries = await fs.readdir(fullPath, { withFileTypes: true });
          
          for (const entry of entries) {
            // Skip hidden files/folders
            if (entry.name.startsWith('.')) continue;
            
            const relativePath = normalizedDirPath ? `${normalizedDirPath}/${entry.name}` : entry.name;
            
            if (entry.isDirectory()) {
              items.push({
                name: entry.name,
                type: "folder",
                path: relativePath
              });
            } else if (entry.name.endsWith('.md')) {
              const item: FileInfo = {
                name: entry.name,
                type: "file",
                path: relativePath
              };
              
              if (include_content_preview) {
                try {
                  const content = await fs.readFile(path.join(fullPath, entry.name), 'utf-8');
                  const { content: body } = matter(content);
                  item.preview = body.substring(0, 100).trim() + (body.length > 100 ? "..." : "");
                } catch {
                  item.preview = "(unable to read)";
                }
              }
              
              items.push(item);
            }
          }
        }
        
        // Sort: folders first, then files, alphabetically
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        
        return {
          content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                path: normalizedDirPath || "/",
                count: items.length,
                items: items
              }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // SEARCH VAULT
  // ============================================================
  
  server.tool(
    "vault_search",
    `Search for text across all notes in the vault.

Args:
  - query (string, required): Text to search for (case-insensitive)
  - path (string, optional): Limit search to a specific folder
  - include_content (boolean): Include matching line in results (default: true)
  - limit (number): Max results to return (default: 20)

Returns:
  List of matching notes with context`,
    {
      query: z.string().describe("Text to search for"),
      path: z.string().default("").describe("Limit search to folder"),
      include_content: z.boolean().default(true).describe("Include matching lines"),
      limit: z.number().min(1).max(100).default(20).describe("Max results")
    },
    async ({ query, path: searchPath, include_content, limit }) => {
      try {
        const { normalizedPath: normalizedSearchPath, fullPath: searchDir } = resolveDirectoryPath(searchPath);
        
        // Check if directory exists
        if (!await pathExists(searchDir)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Directory not found: ${normalizedSearchPath || "/"}`
              }, null, 2)
            }]
          };
        }
        
        // Get all markdown files
        const files = await getMarkdownFiles(searchDir, vaultRoot);
        
        interface SearchResult {
          path: string;
          matches: Array<{
            line: number;
            content: string;
          }>;
        }
        
        const results: SearchResult[] = [];
        const queryLower = query.toLowerCase();
        
        for (const filePath of files) {
          if (results.length >= limit) break;
          
          try {
            const content = await fs.readFile(resolveVaultPath(vaultRoot, filePath), 'utf-8');
            const lines = content.split('\n');
            
            const matches: Array<{ line: number; content: string }> = [];
            
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(queryLower)) {
                matches.push({
                  line: i + 1,
                  content: include_content ? lines[i].trim().substring(0, 200) : ""
                });
              }
            }
            
            if (matches.length > 0) {
              results.push({
                path: filePath,
                matches: matches.slice(0, 5) // Limit matches per file
              });
            }
          } catch {
            // Skip files that can't be read
            continue;
          }
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              query: query,
              search_path: normalizedSearchPath || "/",
              result_count: results.length,
              results: results
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // MOVE/RENAME NOTE
  // ============================================================
  
  server.tool(
    "vault_move",
    `Move or rename a note in the vault.

Args:
  - from_path (string, required): Current path of the note
  - to_path (string, required): New path for the note

Returns:
  Success status with old and new paths`,
    {
      from_path: z.string().describe("Current note path"),
      to_path: z.string().describe("New note path")
    },
    async ({ from_path, to_path }) => {
      try {
        const fromResolved = resolveNotePath(from_path);
        const toResolved = resolveNotePath(to_path);
        const normalizedFrom = fromResolved.normalizedPath;
        const normalizedTo = toResolved.normalizedPath;
        const fullFromPath = fromResolved.fullPath;
        const fullToPath = toResolved.fullPath;
        
        // Check if source exists
        if (!await pathExists(fullFromPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Source note not found: ${normalizedFrom}`
              }, null, 2)
            }]
          };
        }
        
        // Check if destination already exists
        if (await pathExists(fullToPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Destination already exists: ${normalizedTo}`
              }, null, 2)
            }]
          };
        }
        
        // Ensure destination directory exists
        await ensureDir(fullToPath);
        
        // Move the file
        await fs.rename(fullFromPath, fullToPath);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Note moved successfully",
              from: normalizedFrom,
              to: normalizedTo
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // DAILY NOTE
  // ============================================================
  
  server.tool(
    "vault_daily_note",
    `Get or create today's daily note.

Args:
  - date (string, optional): Date in YYYY-MM-DD format (default: today)
  - folder (string, optional): Folder for daily notes (default: 'Daily Notes')
  - template (string, optional): Content template for new notes
  - create_if_missing (boolean): Create note if it doesn't exist (default: true)

Returns:
  Daily note content or creation status`,
    {
      date: z.string().optional().describe("Date in YYYY-MM-DD format"),
      folder: z.string().default("Daily Notes").describe("Folder for daily notes"),
      template: z.string().optional().describe("Template for new notes"),
      create_if_missing: z.boolean().default(true).describe("Create if missing")
    },
    async ({ date, folder, template, create_if_missing }) => {
      try {
        // Use provided date or today
        const noteDate = date || formatDate(new Date());
        const normalizedFolder = normalizeRelativePath(folder);
        const notePath = normalizeNotePath(normalizedFolder ? `${normalizedFolder}/${noteDate}` : noteDate);
        const fullPath = resolveVaultPath(vaultRoot, notePath);
        
        // Check if note exists
        const exists = await pathExists(fullPath);
        
        if (exists) {
          // Read existing note
          const rawContent = await fs.readFile(fullPath, 'utf-8');
          const { data: frontmatter, content } = matter(rawContent);
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                exists: true,
                path: notePath,
                date: noteDate,
                frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
                content: content.trim()
              }, null, 2)
            }]
          };
        } else if (create_if_missing) {
          // Create new daily note
          await ensureDir(fullPath);
          
          // Default template if none provided
          const defaultTemplate = `# ${noteDate}\n\n## Tasks\n\n- [ ] \n\n## Notes\n\n`;
          const noteContent = template || defaultTemplate;
          
          // Add default frontmatter
          const frontmatter = {
            date: noteDate,
            created: new Date().toISOString(),
            updated: getTodayIsoDate(),
          };
          
          const finalContent = matter.stringify(noteContent, frontmatter);
          await fs.writeFile(fullPath, finalContent, 'utf-8');
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                exists: false,
                created: true,
                path: notePath,
                date: noteDate,
                message: "Daily note created"
              }, null, 2)
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                exists: false,
                created: false,
                path: notePath,
                date: noteDate,
                message: "Daily note does not exist"
              }, null, 2)
            }]
          };
        }
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // GET VAULT TREE
  // ============================================================
  
  server.tool(
    "vault_tree",
    `Get the full folder structure of the vault as a tree.

Args:
  - path (string, optional): Start from a specific folder
  - max_depth (number, optional): Maximum depth to traverse (default: 5)

Returns:
  Tree structure of folders and files`,
    {
      path: z.string().default("").describe("Starting folder"),
      max_depth: z.number().min(1).max(10).default(5).describe("Max depth")
    },
    async ({ path: startPath, max_depth }) => {
      try {
        const { normalizedPath: normalizedStartPath, fullPath: rootPath } = resolveDirectoryPath(startPath);
        
        // Check if directory exists
        if (!await pathExists(rootPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Directory not found: ${normalizedStartPath || "/"}`
              }, null, 2)
            }]
          };
        }
        
        interface TreeNode {
          name: string;
          type: "folder" | "file";
          children?: TreeNode[];
        }
        
        // Recursive function to build tree
        async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
          if (depth > max_depth) return [];
          
          const nodes: TreeNode[] = [];
          
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
              // Skip hidden files/folders
              if (entry.name.startsWith('.')) continue;
              
              if (entry.isDirectory()) {
                const children = await buildTree(path.join(dir, entry.name), depth + 1);
                nodes.push({
                  name: entry.name,
                  type: "folder",
                  children: children
                });
              } else if (entry.name.endsWith('.md')) {
                nodes.push({
                  name: entry.name,
                  type: "file"
                });
              }
            }
          } catch {
            // Skip inaccessible directories
          }
          
          // Sort: folders first, then files
          nodes.sort((a, b) => {
            if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          
          return nodes;
        }
        
        const tree = await buildTree(rootPath, 1);
        
        return {
          content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                root: normalizedStartPath || "/",
                tree: tree
              }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // UPDATE FRONTMATTER
  // ============================================================
  
  server.tool(
    "vault_frontmatter",
    `Get or update frontmatter (YAML metadata) for a note.

Args:
  - path (string, required): Path to the note
  - action (string): 'get', 'set', or 'merge' (default: 'get')
  - data (object, optional): Frontmatter data for set/merge operations

Returns:
  Current or updated frontmatter`,
    {
      path: z.string().describe("Path to note"),
      action: z.enum(["get", "set", "merge"]).default("get").describe("Action to perform"),
      data: z.record(z.any()).optional().describe("Frontmatter data")
    },
    async ({ path: notePath, action, data }) => {
      try {
        const { normalizedPath, fullPath } = resolveNotePath(notePath);
        
        // Check if file exists
        if (!await pathExists(fullPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Note not found: ${normalizedPath}`
              }, null, 2)
            }]
          };
        }
        
        // Read current content
        const rawContent = await fs.readFile(fullPath, 'utf-8');
        const { data: currentFrontmatter, content } = matter(rawContent);
        
        if (action === "get") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                path: normalizedPath,
                frontmatter: currentFrontmatter
              }, null, 2)
            }]
          };
        }
        
        if (!data) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "Data is required for set/merge operations"
              }, null, 2)
            }]
          };
        }
        
        // Determine new frontmatter
        const newFrontmatter = action === "set" 
          ? data 
          : { ...currentFrontmatter, ...data };
        const touchedFrontmatter = touchUpdated(newFrontmatter);
        
        // Write updated content
        const finalContent = matter.stringify(content, touchedFrontmatter);
        await fs.writeFile(fullPath, finalContent, 'utf-8');
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              path: normalizedPath,
              action: action,
              frontmatter: touchedFrontmatter
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // APPEND TO NOTE (Quick add without full read-write cycle)
  // ============================================================
  
  server.tool(
    "vault_append",
    `Append content to an existing note (convenience tool for session logs, running notes).

Args:
  - path (string, required): Path to the note relative to vault root
  - content (string, required): Content to append
  - separator (string, optional): Separator before new content (default: "\\n\\n---\\n\\n")
  - position (string, optional): 'end' or 'start' (default: 'end')

Returns:
  Success status`,
    {
      path: z.string().describe("Path to note relative to vault root"),
      content: z.string().describe("Content to append"),
      separator: z.string().default("\n\n---\n\n").describe("Separator before new content"),
      position: z.enum(["end", "start"]).default("end").describe("Where to add content")
    },
    async ({ path: notePath, content, separator, position }) => {
      try {
        const { normalizedPath, fullPath } = resolveNotePath(notePath);
        
        // Check if file exists
        if (!await pathExists(fullPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Note not found: ${normalizedPath}. Use vault_write to create new notes.`
              }, null, 2)
            }]
          };
        }
        
        // Read existing content
        const rawContent = await fs.readFile(fullPath, 'utf-8');
        const { data: frontmatter, content: existingContent } = matter(rawContent);
        
        // Combine content based on position
        const newContent = position === "end"
          ? `${existingContent.trim()}${separator}${content}`
          : `${content}${separator}${existingContent.trim()}`;
        
        // Write back with preserved frontmatter and refreshed updated date.
        const finalContent = matter.stringify(newContent, touchUpdated(frontmatter));
        
        await fs.writeFile(fullPath, finalContent, 'utf-8');
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Content ${position === "end" ? "appended" : "prepended"} successfully`,
              path: normalizedPath
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // RECENT FILES (Find recently modified files)
  // ============================================================
  
  server.tool(
    "vault_recent",
    `Find recently modified files in the vault.

Args:
  - days (number, optional): Files modified in last N days (default: 7)
  - path (string, optional): Limit to specific folder
  - limit (number, optional): Max results (default: 20)

Returns:
  List of recently modified files with dates`,
    {
      days: z.number().min(1).max(365).default(7).describe("Files modified in last N days"),
      path: z.string().default("").describe("Limit to folder"),
      limit: z.number().min(1).max(100).default(20).describe("Max results")
    },
    async ({ days, path: searchPath, limit }) => {
      try {
        const { normalizedPath: normalizedSearchPath, fullPath: searchDir } = resolveDirectoryPath(searchPath);
        
        // Check if directory exists
        if (!await pathExists(searchDir)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Directory not found: ${normalizedSearchPath || "/"}`
              }, null, 2)
            }]
          };
        }
        
        // Get all markdown files
        const files = await getMarkdownFiles(searchDir, vaultRoot);
        
        // Calculate cutoff date
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        
        interface RecentFile {
          path: string;
          modified: string;
          days_ago: number;
        }
        
        const recentFiles: RecentFile[] = [];
        
        for (const filePath of files) {
          try {
            const stats = await fs.stat(resolveVaultPath(vaultRoot, filePath));
            
            if (stats.mtime >= cutoffDate) {
              const daysAgo = Math.floor((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24));
              recentFiles.push({
                path: filePath,
                modified: stats.mtime.toISOString(),
                days_ago: daysAgo
              });
            }
          } catch {
            // Skip files we can't stat
            continue;
          }
        }
        
        // Sort by modification date (newest first)
        recentFiles.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
        
        // Limit results
        const limitedResults = recentFiles.slice(0, limit);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              search_path: normalizedSearchPath || "/",
              days: days,
              result_count: limitedResults.length,
              total_found: recentFiles.length,
              files: limitedResults
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // BATCH READ (Read multiple files at once)
  // ============================================================
  
  server.tool(
    "vault_batch_read",
    `Read multiple notes in a single call.

Args:
  - paths (array, required): Array of paths relative to vault root
  - include_frontmatter (boolean): Parse frontmatter separately (default: true)

Returns:
  Array of note contents in the same order as requested`,
    {
      paths: z.array(z.string()).min(1).max(20).describe("Array of paths to read"),
      include_frontmatter: z.boolean().default(true).describe("Parse frontmatter separately")
    },
    async ({ paths, include_frontmatter }) => {
      try {
        interface ReadResult {
          path: string;
          success: boolean;
          frontmatter?: Record<string, any> | null;
          content?: string;
          error?: string;
        }
        
        const results: ReadResult[] = [];
        
        for (const notePath of paths) {
          const { normalizedPath, fullPath } = resolveNotePath(notePath);
          
          if (!await pathExists(fullPath)) {
            results.push({
              path: normalizedPath,
              success: false,
              error: "Note not found"
            });
            continue;
          }
          
          try {
            const rawContent = await fs.readFile(fullPath, 'utf-8');
            
            if (include_frontmatter) {
              const { data: frontmatter, content } = matter(rawContent);
              results.push({
                path: normalizedPath,
                success: true,
                frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
                content: content.trim()
              });
            } else {
              results.push({
                path: normalizedPath,
                success: true,
                content: rawContent
              });
            }
          } catch (err) {
            results.push({
              path: normalizedPath,
              success: false,
              error: err instanceof Error ? err.message : "Read error"
            });
          }
        }
        
        const successCount = results.filter(r => r.success).length;
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              requested: paths.length,
              successful: successCount,
              failed: paths.length - successCount,
              results: results
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // FIND BY TAG (Find docs with specific frontmatter tags)
  // ============================================================
  
  server.tool(
    "vault_find_by_tag",
    `Find notes by frontmatter tags.

Args:
  - tags (array, required): Tags to search for
  - match (string): 'any' matches notes with any tag, 'all' requires all tags (default: 'any')
  - path (string, optional): Limit search to folder

Returns:
  List of notes matching the tag criteria`,
    {
      tags: z.array(z.string()).min(1).describe("Tags to search for"),
      match: z.enum(["any", "all"]).default("any").describe("Match any or all tags"),
      path: z.string().default("").describe("Limit to folder")
    },
    async ({ tags, match, path: searchPath }) => {
      try {
        const { normalizedPath: normalizedSearchPath, fullPath: searchDir } = resolveDirectoryPath(searchPath);
        
        if (!await pathExists(searchDir)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Directory not found: ${normalizedSearchPath || "/"}`
              }, null, 2)
            }]
          };
        }
        
        const files = await getMarkdownFiles(searchDir, vaultRoot);
        
        interface TagResult {
          path: string;
          tags: string[];
          title?: string;
        }
        
        const results: TagResult[] = [];
        const searchTags = tags.map(t => t.toLowerCase());
        
        for (const filePath of files) {
          try {
            const content = await fs.readFile(resolveVaultPath(vaultRoot, filePath), 'utf-8');
            const { data: frontmatter } = matter(content);
            
            const docTags: string[] = Array.isArray(frontmatter.tags) 
              ? frontmatter.tags.map((t: any) => String(t).toLowerCase())
              : [];
            
            let matches = false;
            if (match === "any") {
              matches = searchTags.some(t => docTags.includes(t));
            } else {
              matches = searchTags.every(t => docTags.includes(t));
            }
            
            if (matches) {
              results.push({
                path: filePath,
                tags: frontmatter.tags || [],
                title: frontmatter.title
              });
            }
          } catch {
            continue;
          }
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              search_tags: tags,
              match_mode: match,
              search_path: normalizedSearchPath || "/",
              result_count: results.length,
              results: results
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // BACKLINKS (Find docs that link to a given doc)
  // ============================================================
  
  server.tool(
    "vault_backlinks",
    `Find notes that link to a specific note (backlinks).

Args:
  - path (string, required): Path to the note to find backlinks for

Returns:
  List of notes that contain wiki-links to the specified note`,
    {
      path: z.string().describe("Path to find backlinks for")
    },
    async ({ path: targetPath }) => {
      try {
        const normalizedTarget = normalizeNotePath(targetPath);
        const targetName = path.basename(normalizedTarget, '.md');
        
        // Get all markdown files
        const files = await getMarkdownFiles(vaultRoot, vaultRoot);
        
        interface BacklinkResult {
          path: string;
          links: Array<{
            line: number;
            context: string;
          }>;
        }
        
        const results: BacklinkResult[] = [];
        
        // Patterns to match wiki-links
        // [[FileName]] or [[path/to/FileName]] or [[FileName|Display]]
        const escapedTargetName = escapeRegExp(targetName);
        const escapedTargetPath = escapeRegExp(normalizedTarget.replace('.md', ''));
        const linkPatterns = [
          new RegExp(`\\[\\[${escapedTargetName}\\]\\]`, 'gi'),
          new RegExp(`\\[\\[${escapedTargetName}\\|[^\\]]+\\]\\]`, 'gi'),
          new RegExp(`\\[\\[[^\\]]*/${escapedTargetName}\\]\\]`, 'gi'),
          new RegExp(`\\[\\[[^\\]]*/${escapedTargetName}\\|[^\\]]+\\]\\]`, 'gi'),
          new RegExp(`\\[\\[${escapedTargetPath}\\]\\]`, 'gi'),
        ];
        
        for (const filePath of files) {
          // Skip self
          if (filePath === normalizedTarget) continue;
          
          try {
            const content = await fs.readFile(resolveVaultPath(vaultRoot, filePath), 'utf-8');
            const lines = content.split('\n');
            
            const links: Array<{ line: number; context: string }> = [];
            
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              for (const pattern of linkPatterns) {
                if (pattern.test(line)) {
                  links.push({
                    line: i + 1,
                    context: line.trim().substring(0, 150)
                  });
                  break; // Only count each line once
                }
                pattern.lastIndex = 0; // Reset regex state
              }
            }
            
            if (links.length > 0) {
              results.push({
                path: filePath,
                links: links
              });
            }
          } catch {
            continue;
          }
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              target: normalizedTarget,
              backlink_count: results.length,
              total_links: results.reduce((sum, r) => sum + r.links.length, 0),
              results: results
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // BROKEN LINKS (Find wiki-links to non-existent docs)
  // ============================================================
  
  server.tool(
    "vault_broken_links",
    `Find broken wiki-links (links to notes that don't exist).

Args:
  - path (string, optional): Limit search to folder

Returns:
  List of broken links with source file and line number`,
    {
      path: z.string().default("").describe("Limit to folder")
    },
    async ({ path: searchPath }) => {
      try {
        const { normalizedPath: normalizedSearchPath, fullPath: searchDir } = resolveDirectoryPath(searchPath);
        
        if (!await pathExists(searchDir)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Directory not found: ${normalizedSearchPath || "/"}`
              }, null, 2)
            }]
          };
        }
        
        const files = await getMarkdownFiles(searchDir, vaultRoot);
        
        // Build a set of all existing file names (without .md)
        const existingFiles = new Set<string>();
        for (const f of files) {
          existingFiles.add(path.basename(f, '.md').toLowerCase());
          existingFiles.add(f.replace(/\.md$/i, '').toLowerCase());
        }
        
        interface BrokenLink {
          source: string;
          line: number;
          link: string;
          context: string;
        }
        
        const brokenLinks: BrokenLink[] = [];
        
        // Pattern to find wiki-links
        const wikiLinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        
        for (const filePath of files) {
          try {
            const content = await fs.readFile(resolveVaultPath(vaultRoot, filePath), 'utf-8');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              let match;
              
              while ((match = wikiLinkPattern.exec(line)) !== null) {
                const linkTarget = match[1].trim();
                const linkName = path.basename(linkTarget).toLowerCase();
                let linkPath = linkTarget.toLowerCase();
                try {
                  linkPath = normalizeRelativePath(linkTarget).toLowerCase();
                } catch {
                  // Keep raw path for comparison when link is malformed.
                }
                
                // Check if the link target exists
                if (!existingFiles.has(linkName) && !existingFiles.has(linkPath)) {
                  brokenLinks.push({
                    source: filePath,
                    line: i + 1,
                    link: linkTarget,
                    context: line.trim().substring(0, 100)
                  });
                }
              }
              wikiLinkPattern.lastIndex = 0;
            }
          } catch {
            continue;
          }
        }
        
        // Group by source file
        const bySource: Record<string, BrokenLink[]> = {};
        for (const bl of brokenLinks) {
          if (!bySource[bl.source]) bySource[bl.source] = [];
          bySource[bl.source].push(bl);
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              search_path: normalizedSearchPath || "/",
              broken_link_count: brokenLinks.length,
              affected_files: Object.keys(bySource).length,
              by_source: bySource
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  // ============================================================
  // CONTEXT BOOTSTRAP (Single-call startup context loader)
  // ============================================================
  
  server.tool(
    "vault_context_bootstrap",
    `Load core context notes in one call.

Args:
  - project_context_path (string, optional): Path to active project context note
  - days (number, optional): Look back N days for recent changes (default: 7)
  - recent_limit (number, optional): Max recent files to return (default: 10)
  - include_frontmatter (boolean): Parse frontmatter in loaded notes (default: true)

Returns:
  Home.md, _Context/Now.md, active project context, and recent file activity`,
    {
      project_context_path: z.string().default("_Context/Project.md").describe("Active project context note path"),
      days: z.number().min(1).max(30).default(7).describe("Recent lookback in days"),
      recent_limit: z.number().min(1).max(50).default(10).describe("Max recent files"),
      include_frontmatter: z.boolean().default(true).describe("Parse frontmatter separately"),
    },
    async ({ project_context_path, days, recent_limit, include_frontmatter }) => {
      try {
        const startupPaths = [
          "Home.md",
          "_Context/Now.md",
          project_context_path,
        ];

        interface StartupNote {
          path: string;
          success: boolean;
          frontmatter?: Record<string, any> | null;
          content?: string;
          error?: string;
        }

        const notes: StartupNote[] = [];

        for (const startupPath of startupPaths) {
          let normalizedPath: string;
          let fullPath: string;
          try {
            const resolved = resolveNotePath(startupPath);
            normalizedPath = resolved.normalizedPath;
            fullPath = resolved.fullPath;
          } catch (error) {
            notes.push({
              path: startupPath,
              success: false,
              error: error instanceof Error ? error.message : "Invalid path",
            });
            continue;
          }

          if (!await pathExists(fullPath)) {
            notes.push({
              path: normalizedPath,
              success: false,
              error: "Note not found",
            });
            continue;
          }

          const raw = await fs.readFile(fullPath, "utf-8");
          if (include_frontmatter) {
            const { data: frontmatter, content } = matter(raw);
            notes.push({
              path: normalizedPath,
              success: true,
              frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
              content: content.trim(),
            });
          } else {
            notes.push({
              path: normalizedPath,
              success: true,
              content: raw,
            });
          }
        }

        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const files = await getMarkdownFiles(vaultRoot, vaultRoot);
        const recent: Array<{ path: string; modified: string; days_ago: number }> = [];

        for (const filePath of files) {
          try {
            const stat = await fs.stat(resolveVaultPath(vaultRoot, filePath));
            if (stat.mtime.getTime() < cutoff) continue;
            recent.push({
              path: filePath,
              modified: stat.mtime.toISOString(),
              days_ago: Math.floor((Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24)),
            });
          } catch {
            continue;
          }
        }

        recent.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
        const recentLimited = recent.slice(0, recent_limit);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              startup_paths: startupPaths,
              loaded_notes: notes,
              loaded_successfully: notes.filter(n => n.success).length,
              recent: {
                days,
                total_found: recent.length,
                files: recentLimited,
              },
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            }, null, 2),
          }],
        };
      }
    }
  );

  // ============================================================
  // UPSERT SECTION (Replace or insert a markdown section)
  // ============================================================
  
  server.tool(
    "vault_upsert_section",
    `Replace or insert a markdown section in a note.

Args:
  - path (string, required): Path to note
  - heading (string, required): Heading text (without # prefix)
  - content (string, required): Section body content
  - level (number, optional): Heading level 1-6 (default: 2)

Returns:
  Whether section was updated or inserted`,
    {
      path: z.string().describe("Path to note"),
      heading: z.string().min(1).describe("Heading text"),
      content: z.string().describe("Section content"),
      level: z.number().min(1).max(6).default(2).describe("Heading level"),
    },
    async ({ path: notePath, heading, content, level }) => {
      try {
        const { normalizedPath, fullPath } = resolveNotePath(notePath);

        if (!await pathExists(fullPath)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Note not found: ${normalizedPath}`,
              }, null, 2),
            }],
          };
        }

        const rawContent = await fs.readFile(fullPath, "utf-8");
        const parsed = matter(rawContent);
        const existingFrontmatter = parsed.data;
        const normalizedHeading = heading.replace(/^#+\s*/, "").trim();
        const headingLine = `${"#".repeat(level)} ${normalizedHeading}`;
        const lines = parsed.content.replace(/\r\n/g, "\n").split("\n");
        const boundaryPattern = new RegExp(`^#{1,${level}}\\s+`);

        let sectionStart = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === headingLine) {
            sectionStart = i;
            break;
          }
        }

        const sectionBody = content.trimEnd();
        const sectionLines = [headingLine, "", sectionBody];
        let action: "updated" | "inserted";
        let newBody: string;

        if (sectionStart >= 0) {
          let sectionEnd = lines.length;
          for (let i = sectionStart + 1; i < lines.length; i++) {
            if (boundaryPattern.test(lines[i].trim())) {
              sectionEnd = i;
              break;
            }
          }
          const updatedLines = [
            ...lines.slice(0, sectionStart),
            ...sectionLines,
            ...lines.slice(sectionEnd),
          ];
          newBody = updatedLines.join("\n").trim() + "\n";
          action = "updated";
        } else {
          const prefix = parsed.content.trim().length > 0 ? `${parsed.content.trimEnd()}\n\n` : "";
          newBody = `${prefix}${sectionLines.join("\n")}\n`;
          action = "inserted";
        }

        const finalContent = Object.keys(existingFrontmatter).length > 0
          ? matter.stringify(newBody, touchUpdated(existingFrontmatter))
          : newBody;

        await fs.writeFile(fullPath, finalContent, "utf-8");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              action,
              path: normalizedPath,
              heading: headingLine,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            }, null, 2),
          }],
        };
      }
    }
  );

  // ============================================================
  // VAULT STATS (Vault health and statistics)
  // ============================================================
  
  server.tool(
    "vault_stats",
    `Get vault statistics and health metrics.

Args:
  - path (string, optional): Limit to folder

Returns:
  Vault statistics including file counts, recent activity, and health indicators`,
    {
      path: z.string().default("").describe("Limit to folder")
    },
    async ({ path: searchPath }) => {
      try {
        const { normalizedPath: normalizedSearchPath, fullPath: searchDir } = resolveDirectoryPath(searchPath);
        
        if (!await pathExists(searchDir)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Directory not found: ${normalizedSearchPath || "/"}`
              }, null, 2)
            }]
          };
        }
        
        const files = await getMarkdownFiles(searchDir, vaultRoot);
        
        // Gather stats
        let totalSize = 0;
        let withFrontmatter = 0;
        let withTags = 0;
        let recentlyModified = 0; // Last 7 days
        let stale = 0; // Over 90 days
        const tagCounts: Record<string, number> = {};
        const typeCounts: Record<string, number> = {};
        
        const now = Date.now();
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
        const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
        
        for (const filePath of files) {
          try {
            const fullPath = resolveVaultPath(vaultRoot, filePath);
            const stats = await fs.stat(fullPath);
            totalSize += stats.size;
            
            if (stats.mtime.getTime() > sevenDaysAgo) recentlyModified++;
            if (stats.mtime.getTime() < ninetyDaysAgo) stale++;
            
            const content = await fs.readFile(fullPath, 'utf-8');
            const { data: frontmatter } = matter(content);
            
            if (Object.keys(frontmatter).length > 0) {
              withFrontmatter++;
              
              if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
                withTags++;
                for (const tag of frontmatter.tags) {
                  tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                }
              }
              
              if (frontmatter.type) {
                typeCounts[frontmatter.type] = (typeCounts[frontmatter.type] || 0) + 1;
              }
            }
          } catch {
            continue;
          }
        }

        // Context-system integrity checks (root scope only)
        const duplicateLastUpdatedFiles: Array<{ path: string; count: number }> = [];
        const indexUpdatedMismatches: Array<{
          link: string;
          target_path: string;
          table_updated: string;
          actual_updated: string | null;
          issue: "missing_target" | "mismatch" | "missing_frontmatter_updated";
        }> = [];
        const orphanContextDocs: string[] = [];

        const homePath = "Home.md";
        const nowPath = "_Context/Now.md";
        const contextIndexPath = "_Context/Index.md";

        const canonicalDocs = {
          home_exists: await pathExists(resolveVaultPath(vaultRoot, homePath)),
          now_exists: await pathExists(resolveVaultPath(vaultRoot, nowPath)),
          context_index_exists: await pathExists(resolveVaultPath(vaultRoot, contextIndexPath)),
        };

        if (normalizedSearchPath === "") {
          const allFiles = await getMarkdownFiles(vaultRoot, vaultRoot);

          // Check 1: duplicate "Last updated" footers in a single file.
          for (const filePath of allFiles) {
            try {
              const raw = await fs.readFile(resolveVaultPath(vaultRoot, filePath), "utf-8");
              const matches = raw.match(/^\*Last updated:/gim);
              const count = matches ? matches.length : 0;
              if (count > 1) {
                duplicateLastUpdatedFiles.push({ path: filePath, count });
              }
            } catch {
              continue;
            }
          }

          // Check 2: _Context/Index.md "Updated" table date vs target doc frontmatter.updated.
          if (canonicalDocs.context_index_exists) {
            const rawIndex = await fs.readFile(resolveVaultPath(vaultRoot, contextIndexPath), "utf-8");
            const lines = rawIndex.split("\n");

            for (const line of lines) {
              const row = line.match(/^\|\s*\[\[([^\]]+)\]\]\s*\|.*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
              if (!row) continue;

              const linkToken = row[1].trim();
              const tableDate = row[2];
              const targetToken = linkToken.split("|")[0].trim();

              let targetPath = targetToken.includes("/") ? targetToken : `_Context/${targetToken}`;
              targetPath = targetPath.replace(/\\/g, "/");
              if (!targetPath.toLowerCase().endsWith(".md")) targetPath = `${targetPath}.md`;
              try {
                targetPath = normalizeRelativePath(targetPath);
              } catch {
                continue;
              }

              const targetFullPath = resolveVaultPath(vaultRoot, targetPath);
              if (!await pathExists(targetFullPath)) {
                indexUpdatedMismatches.push({
                  link: linkToken,
                  target_path: targetPath,
                  table_updated: tableDate,
                  actual_updated: null,
                  issue: "missing_target",
                });
                continue;
              }

              const targetRaw = await fs.readFile(targetFullPath, "utf-8");
              const { data: targetFrontmatter } = matter(targetRaw);
              const actualUpdated = normalizeUpdatedDate(targetFrontmatter.updated);

              if (!actualUpdated) {
                indexUpdatedMismatches.push({
                  link: linkToken,
                  target_path: targetPath,
                  table_updated: tableDate,
                  actual_updated: null,
                  issue: "missing_frontmatter_updated",
                });
              } else if (actualUpdated !== tableDate) {
                indexUpdatedMismatches.push({
                  link: linkToken,
                  target_path: targetPath,
                  table_updated: tableDate,
                  actual_updated: actualUpdated,
                  issue: "mismatch",
                });
              }
            }
          }

          // Check 3: orphan _Context docs not linked from Home.md or _Context/Index.md.
          const referencedTargets = new Set<string>();
          if (canonicalDocs.context_index_exists) {
            const rawIndex = await fs.readFile(resolveVaultPath(vaultRoot, contextIndexPath), "utf-8");
            for (const link of extractWikiLinkTargets(rawIndex)) referencedTargets.add(link);
          }
          if (canonicalDocs.home_exists) {
            const rawHome = await fs.readFile(resolveVaultPath(vaultRoot, homePath), "utf-8");
            for (const link of extractWikiLinkTargets(rawHome)) referencedTargets.add(link);
          }

          const contextDirFullPath = resolveVaultPath(vaultRoot, "_Context");
          if (await pathExists(contextDirFullPath)) {
            const contextFiles = await getMarkdownFiles(contextDirFullPath, vaultRoot);
            for (const filePath of contextFiles) {
              const normalizedPath = filePath.replace(/\\/g, "/");
              if (
                normalizedPath.toLowerCase() === "_context/index.md" ||
                normalizedPath.toLowerCase() === "_context/now.md"
              ) {
                continue;
              }
              const withoutExt = normalizedPath.replace(/\.md$/i, "").toLowerCase();
              const baseName = path.posix.basename(withoutExt).toLowerCase();
              if (!referencedTargets.has(withoutExt) && !referencedTargets.has(baseName)) {
                orphanContextDocs.push(normalizedPath);
              }
            }
          }
        }
        
        // Sort tags by count
        const topTags = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([tag, count]) => ({ tag, count }));

        const contextSystemChecks = {
          scope: normalizedSearchPath === "" ? "vault_root" : "limited_path",
          canonical_docs: canonicalDocs,
          duplicate_last_updated_footer_count: duplicateLastUpdatedFiles.length,
          duplicate_last_updated_footer_files: duplicateLastUpdatedFiles,
          index_updated_mismatch_count: indexUpdatedMismatches.length,
          index_updated_mismatches: indexUpdatedMismatches,
          orphan_context_doc_count: orphanContextDocs.length,
          orphan_context_docs: orphanContextDocs,
        };
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              search_path: normalizedSearchPath || "/",
              stats: {
                total_files: files.length,
                total_size_kb: Math.round(totalSize / 1024),
                with_frontmatter: withFrontmatter,
                with_tags: withTags,
                frontmatter_coverage: files.length === 0 ? "0%" : `${Math.round((withFrontmatter / files.length) * 100)}%`
              },
              activity: {
                recently_modified: recentlyModified,
                stale_over_90_days: stale
              },
              types: typeCounts,
              top_tags: topTags,
              context_system_checks: contextSystemChecks,
              flywheel_checks: contextSystemChecks,
              health: {
                frontmatter_coverage: files.length > 0 && withFrontmatter / files.length > 0.8 ? "good" : "needs_attention",
                stale_content: files.length > 0 && stale / files.length > 0.3 ? "needs_review" : "ok",
                recent_activity: recentlyModified > 0 ? "active" : "dormant"
              }
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );

  console.error("  Registered: vault_read, vault_write, vault_delete, vault_list");
  console.error("  Registered: vault_search, vault_move, vault_daily_note");
  console.error("  Registered: vault_tree, vault_frontmatter");
  console.error("  Registered: vault_append, vault_recent");
  console.error("  Registered: vault_batch_read, vault_find_by_tag");
  console.error("  Registered: vault_backlinks, vault_broken_links, vault_stats");
  console.error("  Registered: vault_context_bootstrap, vault_upsert_section");
}
