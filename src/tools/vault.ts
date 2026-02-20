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

const DEFAULT_PROJECT_CONTEXT_PATH = "Work/Projects/AI Tools/MCP - Obsidian AI Cortex/_Context.md";
const DEFAULT_HOME_PATH = "Home.md";
const DEFAULT_NOW_PATH = "_Context/Now.md";
const DEFAULT_SESSION_LOG_POINTER_DIR = "Work/Session End Logs";

interface StartupNote {
  path: string;
  success: boolean;
  frontmatter?: Record<string, any> | null;
  content?: string;
  error?: string;
}

interface TrackerIssue {
  id: string;
  status: string;
  title?: string;
  type?: string;
  priority?: string;
  owner?: string;
  note?: string;
  created?: string;
  updated?: string;
  [key: string]: any;
}

interface TrackerUpdateInput {
  id: string;
  action?: "upsert" | "delete";
  status?: string;
  note?: string;
  title?: string;
  type?: string;
  priority?: string;
  owner?: string;
}

interface TrackerParseResult {
  issues: TrackerIssue[];
  source: "json_state" | "table_import" | "empty";
  warnings: string[];
  duplicate_ids: string[];
}

function parseDateInput(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toIsoDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseBulletItems(sectionContent: string | null | undefined): string[] {
  if (!sectionContent) return [];
  return sectionContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
      return match ? match[1].trim() : "";
    })
    .filter(Boolean);
}

function toBulletSection(items: string[]): string {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  if (cleaned.length === 0) return "- _No updates_";
  return cleaned.map((item) => `- ${item}`).join("\n");
}

function findSectionBounds(markdownBody: string, heading: string): { start: number; end: number; level: number } | null {
  const normalizedBody = markdownBody.replace(/\r\n/g, "\n");
  const lines = normalizedBody.split("\n");
  const headingRegex = new RegExp(`^(#{1,6})\\s+${escapeRegExp(heading.trim())}\\s*$`, "i");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(headingRegex);
    if (!match) continue;
    const level = match[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const boundary = lines[j].trim().match(/^(#{1,6})\s+/);
      if (!boundary) continue;
      if (boundary[1].length <= level) {
        end = j;
        break;
      }
    }
    return { start: i, end, level };
  }
  return null;
}

function getSectionContent(markdownBody: string, heading: string): string | null {
  const bounds = findSectionBounds(markdownBody, heading);
  if (!bounds) return null;
  const lines = markdownBody.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(bounds.start + 1, bounds.end).join("\n").trim();
}

function upsertSectionContent(
  markdownBody: string,
  heading: string,
  content: string,
  level = 2
): { body: string; action: "updated" | "inserted" } {
  const safeHeading = heading.replace(/^#+\s*/, "").trim();
  const headingLine = `${"#".repeat(level)} ${safeHeading}`;
  const normalizedBody = markdownBody.replace(/\r\n/g, "\n").trimEnd();
  const sectionPayload = [headingLine, "", content.trimEnd()].join("\n");
  const lines = normalizedBody.length > 0 ? normalizedBody.split("\n") : [];
  const bounds = findSectionBounds(normalizedBody, safeHeading);

  if (!bounds) {
    const next = normalizedBody.length > 0
      ? `${normalizedBody}\n\n${sectionPayload}\n`
      : `${sectionPayload}\n`;
    return { body: next.replace(/\n{3,}/g, "\n\n"), action: "inserted" };
  }

  const nextLines = [
    ...lines.slice(0, bounds.start),
    ...sectionPayload.split("\n"),
    ...lines.slice(bounds.end),
  ];
  const nextBody = `${nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  return { body: nextBody, action: "updated" };
}

function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseMarkdownTables(markdownBody: string): Array<{ headers: string[]; rows: string[][] }> {
  const lines = markdownBody.replace(/\r\n/g, "\n").split("\n");
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const dividerRegex = /^\s*\|?[\s:-]+\|[\s|:-]*$/;

  let i = 0;
  while (i < lines.length - 1) {
    const headerLine = lines[i];
    const dividerLine = lines[i + 1];
    if (!headerLine.includes("|") || !dividerRegex.test(dividerLine.trim())) {
      i++;
      continue;
    }

    const headers = splitMarkdownTableRow(headerLine);
    if (headers.length === 0) {
      i++;
      continue;
    }

    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length) {
      const rowLine = lines[j];
      if (!rowLine.includes("|") || rowLine.trim().length === 0) break;
      const row = splitMarkdownTableRow(rowLine);
      if (row.length > 0) rows.push(row);
      j++;
    }

    tables.push({ headers, rows });
    i = j + 1;
  }

  return tables;
}

function normalizeIssueId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase();
}

function normalizeTrackerStatus(status: unknown): string {
  if (typeof status !== "string" || !status.trim()) return "Open";
  const normalized = status.trim().toLowerCase();
  if (["open", "new", "todo", "to do", "backlog"].includes(normalized)) return "Open";
  if (["in progress", "in-progress", "wip", "doing"].includes(normalized)) return "In Progress";
  if (["in validation", "validation", "qa", "testing", "in review"].includes(normalized)) return "In Validation";
  if (["blocked", "on hold", "hold"].includes(normalized)) return "Blocked";
  if (["done", "fixed", "closed", "resolved", "complete", "completed"].includes(normalized)) return "Done";
  return status.trim();
}

function normalizeTrackerIssues(rawIssues: TrackerIssue[]): { issues: TrackerIssue[]; duplicateIds: string[] } {
  const deduped: TrackerIssue[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const issue of rawIssues) {
    const id = normalizeIssueId(issue.id);
    if (!id) continue;
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);

    deduped.push({
      ...issue,
      id,
      status: normalizeTrackerStatus(issue.status),
      updated: typeof issue.updated === "string" ? issue.updated : undefined,
      created: typeof issue.created === "string" ? issue.created : undefined,
    });
  }

  return {
    issues: deduped,
    duplicateIds: Array.from(duplicates).sort(),
  };
}

function parseTrackerState(markdownBody: string): TrackerParseResult {
  const warnings: string[] = [];
  const sectionContent = getSectionContent(markdownBody, "Tracker State (JSON)");
  const emptyResult: TrackerParseResult = {
    issues: [],
    source: "empty",
    warnings,
    duplicate_ids: [],
  };

  if (sectionContent) {
    const codeBlockMatch = sectionContent.match(/```json\s*([\s\S]*?)```/i);
    const jsonPayload = (codeBlockMatch ? codeBlockMatch[1] : sectionContent).trim();
    if (jsonPayload) {
      try {
        const parsed = JSON.parse(jsonPayload);
        if (Array.isArray(parsed)) {
          const normalized = normalizeTrackerIssues(parsed as TrackerIssue[]);
          return {
            issues: normalized.issues,
            source: "json_state",
            warnings,
            duplicate_ids: normalized.duplicateIds,
          };
        }
        warnings.push("Tracker State JSON is not an array; falling back to table import.");
      } catch (error) {
        warnings.push(`Tracker State JSON parse error: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  const tables = parseMarkdownTables(markdownBody);
  const imported: TrackerIssue[] = [];

  for (const table of tables) {
    const headerMap = new Map<string, number>();
    table.headers.forEach((header, index) => headerMap.set(header.toLowerCase().trim(), index));

    const idIndex = headerMap.get("id");
    const statusIndex = headerMap.get("status");
    if (idIndex === undefined || statusIndex === undefined) continue;

    const titleIndex =
      headerMap.get("title") ??
      headerMap.get("summary") ??
      headerMap.get("issue") ??
      headerMap.get("description") ??
      headerMap.get("name");
    const typeIndex = headerMap.get("type");
    const priorityIndex = headerMap.get("priority");
    const ownerIndex = headerMap.get("owner");
    const noteIndex = headerMap.get("note") ?? headerMap.get("notes");
    const updatedIndex =
      headerMap.get("updated") ??
      headerMap.get("last updated") ??
      headerMap.get("last_updated") ??
      headerMap.get("date");

    for (const row of table.rows) {
      const id = normalizeIssueId(row[idIndex] ?? "");
      if (!id) continue;
      imported.push({
        id,
        status: normalizeTrackerStatus(row[statusIndex] ?? "Open"),
        title: titleIndex !== undefined ? row[titleIndex] : undefined,
        type: typeIndex !== undefined ? row[typeIndex] : undefined,
        priority: priorityIndex !== undefined ? row[priorityIndex] : undefined,
        owner: ownerIndex !== undefined ? row[ownerIndex] : undefined,
        note: noteIndex !== undefined ? row[noteIndex] : undefined,
        updated: updatedIndex !== undefined ? row[updatedIndex] : undefined,
      });
    }
  }

  if (imported.length === 0) return emptyResult;

  const normalized = normalizeTrackerIssues(imported);
  return {
    issues: normalized.issues,
    source: "table_import",
    warnings,
    duplicate_ids: normalized.duplicateIds,
  };
}

function sanitizeTableCell(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function renderTrackerTable(issues: TrackerIssue[]): string {
  const header = "| ID | Type | Status | Priority | Updated | Title | Note |";
  const separator = "|---|---|---|---|---|---|---|";
  if (issues.length === 0) {
    return `${header}\n${separator}\n| _none_ |  | Open |  |  |  |  |`;
  }

  const statusOrder: Record<string, number> = {
    Open: 1,
    "In Progress": 2,
    "In Validation": 3,
    Blocked: 4,
    Done: 5,
  };

  const sorted = [...issues].sort((a, b) => {
    const statusA = statusOrder[normalizeTrackerStatus(a.status)] ?? 99;
    const statusB = statusOrder[normalizeTrackerStatus(b.status)] ?? 99;
    if (statusA !== statusB) return statusA - statusB;
    return a.id.localeCompare(b.id);
  });

  const rows = sorted.map((issue) => {
    const updatedDate = parseDateInput(issue.updated);
    return `| ${sanitizeTableCell(issue.id)} | ${sanitizeTableCell(issue.type ?? "")} | ${sanitizeTableCell(normalizeTrackerStatus(issue.status))} | ${sanitizeTableCell(issue.priority ?? "")} | ${sanitizeTableCell(updatedDate ? toIsoDateString(updatedDate) : issue.updated ?? "")} | ${sanitizeTableCell(issue.title ?? "")} | ${sanitizeTableCell(issue.note ?? "")} |`;
  });

  return [header, separator, ...rows].join("\n");
}

function getTrackerStatusCounts(issues: TrackerIssue[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((acc, issue) => {
    const status = normalizeTrackerStatus(issue.status);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
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

  function deriveProjectDir(projectContextPath: string): string {
    const normalized = projectContextPath.replace(/\\/g, "/");
    const dir = path.posix.dirname(normalized);
    return dir === "." ? "" : dir;
  }

  async function readNoteRecord(notePath: string, includeFrontmatter = true): Promise<StartupNote> {
    try {
      const { normalizedPath, fullPath } = resolveNotePath(notePath);
      if (!await pathExists(fullPath)) {
        return {
          path: normalizedPath,
          success: false,
          error: "Note not found",
        };
      }

      const raw = await fs.readFile(fullPath, "utf-8");
      if (!includeFrontmatter) {
        return {
          path: normalizedPath,
          success: true,
          content: raw,
        };
      }

      const { data: frontmatter, content } = matter(raw);
      return {
        path: normalizedPath,
        success: true,
        frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
        content: content.trim(),
      };
    } catch (error) {
      return {
        path: notePath,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async function writeNoteWithFrontmatter(notePath: string, body: string, frontmatterData?: Record<string, any>): Promise<void> {
    const { fullPath } = resolveNotePath(notePath);
    await ensureDir(fullPath);
    const finalBody = body.trimEnd() + "\n";
    const finalContent = frontmatterData && Object.keys(frontmatterData).length > 0
      ? matter.stringify(finalBody, touchUpdated(frontmatterData))
      : finalBody;
    await fs.writeFile(fullPath, finalContent, "utf-8");
  }

  async function appendMarkdownBlock(notePath: string, block: string, fallbackTitle?: string): Promise<void> {
    const { normalizedPath, fullPath } = resolveNotePath(notePath);
    await ensureDir(fullPath);
    if (!await pathExists(fullPath)) {
      const title = fallbackTitle ?? `# ${path.posix.basename(normalizedPath, ".md")}`;
      await fs.writeFile(fullPath, `${title}\n\n${block.trim()}\n`, "utf-8");
      return;
    }

    const existingRaw = await fs.readFile(fullPath, "utf-8");
    const parsed = matter(existingRaw);
    const hasFrontmatter = Object.keys(parsed.data).length > 0;
    const nextBody = `${parsed.content.trimEnd()}\n\n---\n\n${block.trim()}\n`;
    const final = hasFrontmatter
      ? matter.stringify(nextBody, touchUpdated(parsed.data))
      : nextBody;
    await fs.writeFile(fullPath, final, "utf-8");
  }

  async function ensureRootSessionPointer(sessionDate: string, projectLogPath: string, projectName: string): Promise<{ path: string; updated: boolean }> {
    const pointerPath = `${DEFAULT_SESSION_LOG_POINTER_DIR}/${sessionDate}.md`;
    const { normalizedPath, fullPath } = resolveNotePath(pointerPath);
    await ensureDir(fullPath);

    const pointerLink = `[[${projectLogPath}|${projectName} Session Log ${sessionDate}]]`;
    if (!await pathExists(fullPath)) {
      const initial = [
        `# Session End Log — ${sessionDate}`,
        "",
        "> Pointer note. Canonical session details in project-local logs.",
        "",
        `- ${pointerLink}`,
        "",
      ].join("\n");
      await writeNoteWithFrontmatter(pointerPath, initial, {
        title: `Session End Log ${sessionDate}`,
        type: "pointer",
        created: new Date().toISOString(),
      });
      return { path: normalizedPath, updated: true };
    }

    const raw = await fs.readFile(fullPath, "utf-8");
    const parsed = matter(raw);
    const lines = parsed.content.split("\n");
    const alreadyLinked = lines.some((line) => line.includes(`[[${projectLogPath}|`) || line.includes(`[[${projectLogPath}]]`));
    if (alreadyLinked) {
      return { path: normalizedPath, updated: false };
    }

    const nextBody = `${parsed.content.trimEnd()}\n- ${pointerLink}\n`;
    const final = Object.keys(parsed.data).length > 0
      ? matter.stringify(nextBody, touchUpdated(parsed.data))
      : nextBody;
    await fs.writeFile(fullPath, final, "utf-8");
    return { path: normalizedPath, updated: true };
  }

  async function resolveActiveProjectContextPath(overrideProjectContextPath?: string): Promise<{
    project_context_path: string;
    source: "override" | "now_frontmatter" | "fallback";
  }> {
    if (overrideProjectContextPath && overrideProjectContextPath.trim()) {
      return {
        project_context_path: normalizeNotePath(overrideProjectContextPath),
        source: "override",
      };
    }

    const nowRecord = await readNoteRecord(DEFAULT_NOW_PATH, true);
    if (nowRecord.success && nowRecord.frontmatter && typeof nowRecord.frontmatter.active_project_context === "string") {
      return {
        project_context_path: normalizeNotePath(nowRecord.frontmatter.active_project_context),
        source: "now_frontmatter",
      };
    }

    return {
      project_context_path: normalizeNotePath(DEFAULT_PROJECT_CONTEXT_PATH),
      source: "fallback",
    };
  }

  async function runContextBootstrapInternal(params: {
    project_context_path: string;
    days: number;
    recent_limit: number;
    include_frontmatter: boolean;
    include_recent: boolean;
    recent_path?: string;
  }): Promise<{
    startup_paths: string[];
    loaded_notes: StartupNote[];
    loaded_successfully: number;
    recent: {
      enabled: boolean;
      days: number;
      scope_path: string;
      total_found: number;
      files: Array<{ path: string; modified: string; days_ago: number }>;
    };
  }> {
    const startupPaths = [
      DEFAULT_HOME_PATH,
      DEFAULT_NOW_PATH,
      params.project_context_path,
    ];
    const loadedNotes: StartupNote[] = [];
    for (const startupPath of startupPaths) {
      loadedNotes.push(await readNoteRecord(startupPath, params.include_frontmatter));
    }

    if (!params.include_recent) {
      return {
        startup_paths: startupPaths,
        loaded_notes: loadedNotes,
        loaded_successfully: loadedNotes.filter((note) => note.success).length,
        recent: {
          enabled: false,
          days: params.days,
          scope_path: "",
          total_found: 0,
          files: [],
        },
      };
    }

    let recentScopePath = "";
    let recentRootDir = vaultRoot;
    if (params.recent_path && params.recent_path.trim()) {
      const scope = resolveDirectoryPath(params.recent_path);
      if (!await pathExists(scope.fullPath)) {
        throw new Error(`Recent scope not found: ${scope.normalizedPath || "/"}`);
      }
      recentScopePath = scope.normalizedPath;
      recentRootDir = scope.fullPath;
    }

    const files = await getMarkdownFiles(recentRootDir, vaultRoot);
    const cutoff = Date.now() - (params.days * 24 * 60 * 60 * 1000);
    const recentFiles: Array<{ path: string; modified: string; days_ago: number }> = [];
    for (const filePath of files) {
      try {
        const stats = await fs.stat(resolveVaultPath(vaultRoot, filePath));
        if (stats.mtime.getTime() < cutoff) continue;
        recentFiles.push({
          path: filePath,
          modified: stats.mtime.toISOString(),
          days_ago: Math.floor((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24)),
        });
      } catch {
        continue;
      }
    }

    recentFiles.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    return {
      startup_paths: startupPaths,
      loaded_notes: loadedNotes,
      loaded_successfully: loadedNotes.filter((note) => note.success).length,
      recent: {
        enabled: true,
        days: params.days,
        scope_path: recentScopePath,
        total_found: recentFiles.length,
        files: recentFiles.slice(0, params.recent_limit),
      },
    };
  }

  function summarizeProjectContext(projectContextContent: string): {
    priorities: string[];
    blockers: string[];
    next_3_actions: string[];
  } {
    const priorities = (
      parseBulletItems(getSectionContent(projectContextContent, "Current Priorities"))[0]
        ? parseBulletItems(getSectionContent(projectContextContent, "Current Priorities"))
        : parseBulletItems(getSectionContent(projectContextContent, "Priorities"))
    );
    const blockers = [
      ...parseBulletItems(getSectionContent(projectContextContent, "Known Risks/Blockers")),
      ...parseBulletItems(getSectionContent(projectContextContent, "Blockers")),
    ];
    const nextActionsSource = [
      ...parseBulletItems(getSectionContent(projectContextContent, "Next 3 Actions")),
      ...parseBulletItems(getSectionContent(projectContextContent, "Next Actions")),
      ...parseBulletItems(getSectionContent(projectContextContent, "Next Steps")),
    ];

    return {
      priorities: priorities.slice(0, 10),
      blockers: blockers.slice(0, 10),
      next_3_actions: nextActionsSource.slice(0, 3),
    };
  }

  async function runTrackerSyncInternal(params: {
    project_context_path: string;
    tracker_path?: string;
    updates: TrackerUpdateInput[];
    create_missing: boolean;
    render_table: boolean;
    max_log_entries: number;
    log_to_session: boolean;
    session_date: string;
  }): Promise<Record<string, any>> {
    const projectContext = await readNoteRecord(params.project_context_path, true);
    if (!projectContext.success || !projectContext.content) {
      return {
        success: false,
        error: projectContext.error ?? `Unable to read project context: ${params.project_context_path}`,
      };
    }

    const resolvedProjectContextPath = normalizeNotePath(params.project_context_path);
    const projectDir = deriveProjectDir(resolvedProjectContextPath);
    const projectName = path.posix.basename(projectDir || resolvedProjectContextPath, ".md");
    const trackerPathFromFrontmatter = typeof projectContext.frontmatter?.tracker_path === "string"
      ? projectContext.frontmatter?.tracker_path
      : "";
    const trackerPath = params.tracker_path?.trim()
      ? normalizeNotePath(params.tracker_path)
      : (trackerPathFromFrontmatter ? normalizeNotePath(trackerPathFromFrontmatter) : "");

    if (!trackerPath) {
      return {
        success: true,
        skipped: true,
        reason: "No tracker configured for this project.",
        project_context_path: resolvedProjectContextPath,
      };
    }

    const { normalizedPath: normalizedTrackerPath, fullPath: trackerFullPath } = resolveNotePath(trackerPath);
    const trackerExists = await pathExists(trackerFullPath);
    const trackerRaw = trackerExists
      ? await fs.readFile(trackerFullPath, "utf-8")
      : "";
    const trackerParsed = trackerExists ? matter(trackerRaw) : { data: {}, content: "" };
    const trackerState = parseTrackerState(trackerParsed.content || "");

    let issues = [...trackerState.issues];
    const updatedIds: string[] = [];
    const createdIds: string[] = [];
    const deletedIds: string[] = [];
    const unresolvedIds: string[] = [];

    const nowIso = new Date().toISOString();
    const todayIso = getTodayIsoDate();

    for (const update of params.updates) {
      const normalizedId = normalizeIssueId(update.id);
      if (!normalizedId) {
        unresolvedIds.push(update.id);
        continue;
      }

      const action = update.action ?? "upsert";
      const index = issues.findIndex((issue) => issue.id === normalizedId);

      if (action === "delete") {
        if (index >= 0) {
          issues.splice(index, 1);
          deletedIds.push(normalizedId);
        } else {
          unresolvedIds.push(normalizedId);
        }
        continue;
      }

      if (index < 0) {
        if (!params.create_missing) {
          unresolvedIds.push(normalizedId);
          continue;
        }
        const createdIssue: TrackerIssue = {
          id: normalizedId,
          status: normalizeTrackerStatus(update.status ?? "Open"),
          title: update.title?.trim() || "",
          type: update.type?.trim() || "",
          priority: update.priority?.trim() || "",
          owner: update.owner?.trim() || "",
          note: update.note?.trim() || "",
          created: todayIso,
          updated: nowIso,
        };
        issues.push(createdIssue);
        createdIds.push(normalizedId);
        continue;
      }

      const existing = issues[index];
      issues[index] = {
        ...existing,
        status: update.status ? normalizeTrackerStatus(update.status) : normalizeTrackerStatus(existing.status),
        title: update.title !== undefined ? update.title.trim() : existing.title,
        type: update.type !== undefined ? update.type.trim() : existing.type,
        priority: update.priority !== undefined ? update.priority.trim() : existing.priority,
        owner: update.owner !== undefined ? update.owner.trim() : existing.owner,
        note: update.note !== undefined ? update.note.trim() : existing.note,
        updated: nowIso,
      };
      updatedIds.push(normalizedId);
    }

    const normalized = normalizeTrackerIssues(issues);
    issues = normalized.issues;
    const duplicateIds = Array.from(new Set([...trackerState.duplicate_ids, ...normalized.duplicateIds])).sort();

    let trackerBody = trackerParsed.content || "";
    const trackerStatePayload = [
      "```json",
      JSON.stringify(issues, null, 2),
      "```",
    ].join("\n");
    trackerBody = upsertSectionContent(trackerBody, "Tracker State (JSON)", trackerStatePayload, 2).body;
    if (params.render_table) {
      trackerBody = upsertSectionContent(trackerBody, "Tracker Table", renderTrackerTable(issues), 2).body;
    }

    const summaryLineParts = [
      new Date().toISOString(),
      `updated=${updatedIds.length > 0 ? updatedIds.join(",") : "none"}`,
      `created=${createdIds.length > 0 ? createdIds.join(",") : "none"}`,
      `deleted=${deletedIds.length > 0 ? deletedIds.join(",") : "none"}`,
      `unresolved=${unresolvedIds.length > 0 ? unresolvedIds.join(",") : "none"}`,
    ];
    if (duplicateIds.length > 0) summaryLineParts.push(`duplicate_ids=${duplicateIds.join(",")}`);
    if (trackerState.warnings.length > 0) summaryLineParts.push(`warnings=${trackerState.warnings.join("; ")}`);
    const summaryLine = `- ${summaryLineParts.join(" | ")}`;

    const existingLogSection = getSectionContent(trackerBody, "Tracker Sync Log");
    const existingEntries = existingLogSection
      ? existingLogSection.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "))
      : [];
    const nextEntries = [summaryLine, ...existingEntries].slice(0, Math.max(1, params.max_log_entries));
    trackerBody = upsertSectionContent(trackerBody, "Tracker Sync Log", nextEntries.join("\n"), 2).body;

    const nextTrackerFrontmatter = touchUpdated(trackerParsed.data ?? {});
    const finalTrackerContent = Object.keys(nextTrackerFrontmatter).length > 0
      ? matter.stringify(trackerBody.trimEnd() + "\n", nextTrackerFrontmatter)
      : trackerBody.trimEnd() + "\n";
    await ensureDir(trackerFullPath);
    await fs.writeFile(trackerFullPath, finalTrackerContent, "utf-8");

    let sessionLogPath = "";
    if (params.log_to_session && projectDir) {
      sessionLogPath = `${projectDir}/Session Logs/${params.session_date}.md`;
      const trackerSummaryBlock = [
        `## Tracker Sync (${new Date().toISOString()})`,
        `- Tracker: \`${normalizedTrackerPath}\``,
        `- Updated IDs: ${updatedIds.length > 0 ? updatedIds.join(", ") : "none"}`,
        `- Created IDs: ${createdIds.length > 0 ? createdIds.join(", ") : "none"}`,
        `- Deleted IDs: ${deletedIds.length > 0 ? deletedIds.join(", ") : "none"}`,
        `- Unresolved IDs: ${unresolvedIds.length > 0 ? unresolvedIds.join(", ") : "none"}`,
      ].join("\n");
      await appendMarkdownBlock(
        sessionLogPath,
        trackerSummaryBlock,
        `# Session Log — ${params.session_date}`
      );
    }

    return {
      success: true,
      project_context_path: resolvedProjectContextPath,
      tracker_path: normalizedTrackerPath,
      tracker_existed: trackerExists,
      parse_source: trackerState.source,
      warnings: trackerState.warnings,
      duplicate_ids: duplicateIds,
      issue_count: issues.length,
      status_counts: getTrackerStatusCounts(issues),
      updated_ids: updatedIds,
      created_ids: createdIds,
      deleted_ids: deletedIds,
      unresolved_ids: unresolvedIds,
      session_log_path: sessionLogPath || null,
    };
  }

  async function runStaleStateChecks(params: {
    tracker_stale_days: number;
    validation_stale_days: number;
    project_context_stale_days: number;
  }): Promise<Record<string, any>> {
    const now = Date.now();
    const projectContextFiles: string[] = [];
    const projectsDir = resolveVaultPath(vaultRoot, "Work/Projects");
    if (await pathExists(projectsDir)) {
      const projectFiles = await getMarkdownFiles(projectsDir, vaultRoot);
      for (const filePath of projectFiles) {
        if (/^Work\/Projects\/.+\/_Context\.md$/i.test(filePath.replace(/\\/g, "/"))) {
          projectContextFiles.push(filePath.replace(/\\/g, "/"));
        }
      }
    }

    const staleProjectContexts: Array<{ path: string; days_since_update: number }> = [];
    const staleTrackers: Array<{ project_context_path: string; tracker_path: string; days_since_update: number }> = [];
    const missingTrackers: Array<{ project_context_path: string; tracker_path: string }> = [];
    const duplicateTrackerIds: Array<{ tracker_path: string; ids: string[] }> = [];
    const staleInValidation: Array<{ tracker_path: string; id: string; status: string; days_in_status: number }> = [];

    for (const contextPath of projectContextFiles) {
      const contextFullPath = resolveVaultPath(vaultRoot, contextPath);
      const contextStats = await fs.stat(contextFullPath);
      const contextAgeDays = Math.floor((now - contextStats.mtime.getTime()) / (1000 * 60 * 60 * 24));
      if (contextAgeDays > params.project_context_stale_days) {
        staleProjectContexts.push({
          path: contextPath,
          days_since_update: contextAgeDays,
        });
      }

      const raw = await fs.readFile(contextFullPath, "utf-8");
      const parsed = matter(raw);
      const trackerPathRaw = typeof parsed.data.tracker_path === "string" ? parsed.data.tracker_path : "";
      if (!trackerPathRaw) continue;

      const trackerPath = normalizeNotePath(trackerPathRaw);
      const trackerFullPath = resolveVaultPath(vaultRoot, trackerPath);
      if (!await pathExists(trackerFullPath)) {
        missingTrackers.push({
          project_context_path: contextPath,
          tracker_path: trackerPath,
        });
        continue;
      }

      const trackerStats = await fs.stat(trackerFullPath);
      const trackerAgeDays = Math.floor((now - trackerStats.mtime.getTime()) / (1000 * 60 * 60 * 24));
      if (trackerAgeDays > params.tracker_stale_days) {
        staleTrackers.push({
          project_context_path: contextPath,
          tracker_path: trackerPath,
          days_since_update: trackerAgeDays,
        });
      }

      const trackerRaw = await fs.readFile(trackerFullPath, "utf-8");
      const trackerParsed = matter(trackerRaw);
      const trackerState = parseTrackerState(trackerParsed.content || "");
      if (trackerState.duplicate_ids.length > 0) {
        duplicateTrackerIds.push({
          tracker_path: trackerPath,
          ids: trackerState.duplicate_ids,
        });
      }

      for (const issue of trackerState.issues) {
        const status = normalizeTrackerStatus(issue.status);
        if (status !== "In Validation") continue;
        const dateCandidate = issue.updated ?? issue.last_updated ?? issue.date ?? issue.modified;
        const parsedDate = parseDateInput(dateCandidate);
        if (!parsedDate) continue;
        const daysInStatus = Math.floor((now - parsedDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysInStatus > params.validation_stale_days) {
          staleInValidation.push({
            tracker_path: trackerPath,
            id: issue.id,
            status,
            days_in_status: daysInStatus,
          });
        }
      }
    }

    return {
      success: true,
      scanned_project_context_count: projectContextFiles.length,
      checks: {
        tracker_stale_days: params.tracker_stale_days,
        validation_stale_days: params.validation_stale_days,
        project_context_stale_days: params.project_context_stale_days,
      },
      results: {
        stale_project_contexts: staleProjectContexts,
        stale_trackers: staleTrackers,
        missing_trackers: missingTrackers,
        duplicate_tracker_ids: duplicateTrackerIds,
        stale_in_validation: staleInValidation,
      },
      counts: {
        stale_project_contexts: staleProjectContexts.length,
        stale_trackers: staleTrackers.length,
        missing_trackers: missingTrackers.length,
        duplicate_tracker_ids: duplicateTrackerIds.length,
        stale_in_validation: staleInValidation.length,
      },
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
    `Load core Flywheel context in one call.

Args:
  - project_context_path (string, optional): Path to active project context note
  - include_recent (boolean): Include recent files block (default: true)
  - recent_path (string, optional): Limit recent scan to a folder path
  - days (number, optional): Look back N days for recent changes (default: 7)
  - recent_limit (number, optional): Max recent files to return (default: 10)
  - include_frontmatter (boolean): Parse frontmatter in loaded notes (default: true)

Returns:
  Home.md, _Context/Now.md, active project context, and recent file activity`,
    {
      project_context_path: z.string().default(DEFAULT_PROJECT_CONTEXT_PATH).describe("Active project context note path"),
      include_recent: z.boolean().default(true).describe("Include recent files in response"),
      recent_path: z.string().optional().describe("Optional recent scope folder path"),
      days: z.number().min(1).max(30).default(7).describe("Recent lookback in days"),
      recent_limit: z.number().min(1).max(50).default(10).describe("Max recent files"),
      include_frontmatter: z.boolean().default(true).describe("Parse frontmatter separately"),
    },
    async ({ project_context_path, include_recent, recent_path, days, recent_limit, include_frontmatter }) => {
      try {
        const normalizedProjectContextPath = normalizeNotePath(project_context_path);
        const result = await runContextBootstrapInternal({
          project_context_path: normalizedProjectContextPath,
          include_recent,
          recent_path: recent_path?.trim(),
          days,
          recent_limit,
          include_frontmatter,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              ...result,
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
  // START SESSION (Deterministic startup macro)
  // ============================================================

  server.tool(
    "vault_start_session",
    `Deterministic session start for multi-project workflows.

Args:
  - override_project_context_path (string, optional): Explicit active project context path
  - include_recent (boolean): Include recent files block (default: false)
  - recent_path (string, optional): Scope path for recent files (defaults to active project folder when include_recent=true)
  - days (number): Recent lookback window in days (default: 7)
  - recent_limit (number): Maximum recent files (default: 10)
  - include_frontmatter (boolean): Parse frontmatter in loaded notes (default: true)

Returns:
  Active project routing info, bootstrap payload, and target project summary`,
    {
      override_project_context_path: z.string().optional().describe("Optional explicit active project context path"),
      include_recent: z.boolean().default(false).describe("Include recent files block"),
      recent_path: z.string().optional().describe("Optional recent scope path"),
      days: z.number().min(1).max(30).default(7).describe("Recent lookback in days"),
      recent_limit: z.number().min(1).max(50).default(10).describe("Max recent files"),
      include_frontmatter: z.boolean().default(true).describe("Parse frontmatter"),
    },
    async ({ override_project_context_path, include_recent, recent_path, days, recent_limit, include_frontmatter }) => {
      try {
        const activeProject = await resolveActiveProjectContextPath(override_project_context_path);
        const projectDir = deriveProjectDir(activeProject.project_context_path);
        const effectiveRecentPath = include_recent
          ? (recent_path?.trim() || projectDir || "")
          : "";

        const bootstrap = await runContextBootstrapInternal({
          project_context_path: activeProject.project_context_path,
          include_recent,
          recent_path: effectiveRecentPath || undefined,
          days,
          recent_limit,
          include_frontmatter,
        });

        const projectNote = bootstrap.loaded_notes.find((note) => note.path === activeProject.project_context_path);
        const projectSummary = projectNote?.success && projectNote.content
          ? summarizeProjectContext(projectNote.content)
          : { priorities: [], blockers: [], next_3_actions: [] };

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              active_project_context_path: activeProject.project_context_path,
              active_project_context_source: activeProject.source,
              active_project_dir: projectDir,
              summary: projectSummary,
              bootstrap,
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
  // RESUME SESSION (Deterministic compact recovery)
  // ============================================================

  server.tool(
    "vault_resume",
    `Deterministic compact/recovery resume.

Args:
  - override_project_context_path (string, optional): Explicit active project context path
  - session_date (string, optional): Date in YYYY-MM-DD for session log lookup (default: today)
  - include_recent (boolean): Include recent files block (default: false)
  - recent_path (string, optional): Optional recent scope path
  - days (number): Recent lookback in days (default: 7)
  - recent_limit (number): Max recent files (default: 10)
  - include_frontmatter (boolean): Parse frontmatter (default: true)

Returns:
  Bootstrap payload + target project context + latest session log + tracker snapshot`,
    {
      override_project_context_path: z.string().optional().describe("Optional explicit project context path"),
      session_date: z.string().optional().describe("Session date in YYYY-MM-DD (default: today)"),
      include_recent: z.boolean().default(false).describe("Include recent files"),
      recent_path: z.string().optional().describe("Optional recent scope path"),
      days: z.number().min(1).max(30).default(7).describe("Recent lookback in days"),
      recent_limit: z.number().min(1).max(50).default(10).describe("Max recent files"),
      include_frontmatter: z.boolean().default(true).describe("Parse frontmatter"),
    },
    async ({ override_project_context_path, session_date, include_recent, recent_path, days, recent_limit, include_frontmatter }) => {
      try {
        const effectiveSessionDate = session_date?.trim() || getTodayIsoDate();
        const activeProject = await resolveActiveProjectContextPath(override_project_context_path);
        const projectDir = deriveProjectDir(activeProject.project_context_path);
        const effectiveRecentPath = include_recent
          ? (recent_path?.trim() || projectDir || "")
          : "";

        const bootstrap = await runContextBootstrapInternal({
          project_context_path: activeProject.project_context_path,
          include_recent,
          recent_path: effectiveRecentPath || undefined,
          days,
          recent_limit,
          include_frontmatter,
        });

        const projectContext = await readNoteRecord(activeProject.project_context_path, true);
        if (!projectContext.success || !projectContext.content) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: projectContext.error ?? `Unable to read project context: ${activeProject.project_context_path}`,
              }, null, 2),
            }],
          };
        }

        const summary = summarizeProjectContext(projectContext.content);
        const sessionLogPath = projectDir
          ? `${projectDir}/Session Logs/${effectiveSessionDate}`
          : "";
        const sessionLog = sessionLogPath
          ? await readNoteRecord(sessionLogPath, true)
          : {
              path: "",
              success: false,
              error: "No project directory available for session log lookup",
            } satisfies StartupNote;

        let trackerSnapshot: Record<string, any> | null = null;
        const trackerPathRaw = typeof projectContext.frontmatter?.tracker_path === "string"
          ? projectContext.frontmatter.tracker_path
          : "";
        if (trackerPathRaw) {
          const trackerPath = normalizeNotePath(trackerPathRaw);
          const trackerRecord = await readNoteRecord(trackerPath, true);
          if (trackerRecord.success && trackerRecord.content) {
            const parsed = parseTrackerState(trackerRecord.content);
            trackerSnapshot = {
              path: trackerPath,
              source: parsed.source,
              issue_count: parsed.issues.length,
              status_counts: getTrackerStatusCounts(parsed.issues),
              duplicate_ids: parsed.duplicate_ids,
              warnings: parsed.warnings,
            };
          } else {
            trackerSnapshot = {
              path: trackerPath,
              error: trackerRecord.error ?? "Tracker note unavailable",
            };
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              active_project_context_path: activeProject.project_context_path,
              active_project_context_source: activeProject.source,
              active_project_dir: projectDir,
              summary,
              bootstrap,
              session_log: sessionLog.path
                ? {
                    path: sessionLog.path,
                    exists: sessionLog.success,
                    error: sessionLog.success ? null : (sessionLog.error ?? "Session log not found"),
                  }
                : null,
              tracker_snapshot: trackerSnapshot,
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
  // TRACKER SYNC (Deterministic tracker updates)
  // ============================================================

  server.tool(
    "vault_tracker_sync",
    `Deterministic defect/enhancement tracker sync.

Args:
  - override_project_context_path (string, optional): Explicit active project context path
  - tracker_path (string, optional): Explicit tracker note path (otherwise uses project frontmatter tracker_path)
  - updates (array, optional): Structured issue updates
  - create_missing (boolean): Create issue records if IDs don't exist (default: true)
  - render_table (boolean): Render tracker table section from structured state (default: true)
  - max_log_entries (number): Tracker sync log retention size (default: 20)
  - log_to_session (boolean): Append tracker sync summary to project session log (default: true)
  - session_date (string): Session date in YYYY-MM-DD (default: today)

Returns:
  Tracker sync summary with updated/created/deleted/unresolved IDs`,
    {
      override_project_context_path: z.string().optional().describe("Optional explicit project context path"),
      tracker_path: z.string().optional().describe("Optional explicit tracker path"),
      updates: z.array(z.object({
        id: z.string().min(1),
        action: z.enum(["upsert", "delete"]).optional(),
        status: z.string().optional(),
        note: z.string().optional(),
        title: z.string().optional(),
        type: z.string().optional(),
        priority: z.string().optional(),
        owner: z.string().optional(),
      })).default([]).describe("Structured tracker updates"),
      create_missing: z.boolean().default(true).describe("Create missing IDs"),
      render_table: z.boolean().default(true).describe("Render markdown tracker table"),
      max_log_entries: z.number().min(1).max(200).default(20).describe("Tracker sync log retention"),
      log_to_session: z.boolean().default(true).describe("Append summary to project session log"),
      session_date: z.string().optional().describe("Session date in YYYY-MM-DD (default: today)"),
    },
    async ({ override_project_context_path, tracker_path, updates, create_missing, render_table, max_log_entries, log_to_session, session_date }) => {
      try {
        const effectiveSessionDate = session_date?.trim() || getTodayIsoDate();
        const activeProject = await resolveActiveProjectContextPath(override_project_context_path);
        const result = await runTrackerSyncInternal({
          project_context_path: activeProject.project_context_path,
          tracker_path,
          updates,
          create_missing,
          render_table,
          max_log_entries,
          log_to_session,
          session_date: effectiveSessionDate,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...result,
              active_project_context_source: activeProject.source,
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
  // CHECKPOINT (Deterministic session checkpoint + logging)
  // ============================================================

  server.tool(
    "vault_checkpoint",
    `Deterministic checkpoint workflow for project context + logging.

Args:
  - override_project_context_path (string, optional): Explicit active project context path
  - status (array, optional): Current status bullets for project context
  - priorities (array, optional): Current priorities bullets
  - blockers (array, optional): Known risks/blockers bullets
  - next_actions (array, optional): Next action bullets (top 3 retained in summary)
  - summary_note (string, optional): One-line checkpoint summary note
  - session_date (string): Date in YYYY-MM-DD for session log/pointer (default: today)
  - include_tracker_sync (boolean): Run tracker sync during checkpoint (default: true)
  - tracker_updates (array, optional): Structured tracker updates passed to tracker sync

Returns:
  Updated project context paths, session log paths, pointer note status, and optional tracker sync result`,
    {
      override_project_context_path: z.string().optional().describe("Optional explicit project context path"),
      status: z.array(z.string()).default([]).describe("Current status bullets"),
      priorities: z.array(z.string()).default([]).describe("Current priorities bullets"),
      blockers: z.array(z.string()).default([]).describe("Known blockers/risk bullets"),
      next_actions: z.array(z.string()).default([]).describe("Next actions"),
      summary_note: z.string().optional().describe("One-line checkpoint summary"),
      session_date: z.string().optional().describe("Session date in YYYY-MM-DD (default: today)"),
      include_tracker_sync: z.boolean().default(true).describe("Run tracker sync"),
      tracker_updates: z.array(z.object({
        id: z.string().min(1),
        action: z.enum(["upsert", "delete"]).optional(),
        status: z.string().optional(),
        note: z.string().optional(),
        title: z.string().optional(),
        type: z.string().optional(),
        priority: z.string().optional(),
        owner: z.string().optional(),
      })).default([]).describe("Structured tracker updates for checkpoint"),
    },
    async ({ override_project_context_path, status, priorities, blockers, next_actions, summary_note, session_date, include_tracker_sync, tracker_updates }) => {
      try {
        const effectiveSessionDate = session_date?.trim() || getTodayIsoDate();
        const activeProject = await resolveActiveProjectContextPath(override_project_context_path);
        const projectContextPath = activeProject.project_context_path;
        const projectContextRecord = await readNoteRecord(projectContextPath, true);
        if (!projectContextRecord.success || !projectContextRecord.content) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: projectContextRecord.error ?? `Unable to read project context: ${projectContextPath}`,
              }, null, 2),
            }],
          };
        }

        let projectBody = projectContextRecord.content;
        const sectionUpdates: Array<{ section: string; action: "updated" | "inserted" }> = [];

        const statusLines = [...status];
        if (summary_note?.trim()) statusLines.unshift(summary_note.trim());
        if (statusLines.length > 0) {
          const upserted = upsertSectionContent(projectBody, "Current Status", toBulletSection(statusLines), 2);
          projectBody = upserted.body;
          sectionUpdates.push({ section: "Current Status", action: upserted.action });
        }

        if (priorities.length > 0) {
          const upserted = upsertSectionContent(projectBody, "Current Priorities", toBulletSection(priorities), 2);
          projectBody = upserted.body;
          sectionUpdates.push({ section: "Current Priorities", action: upserted.action });
        }

        if (blockers.length > 0) {
          const upserted = upsertSectionContent(projectBody, "Known Risks/Blockers", toBulletSection(blockers), 2);
          projectBody = upserted.body;
          sectionUpdates.push({ section: "Known Risks/Blockers", action: upserted.action });
        }

        if (next_actions.length > 0) {
          const upserted = upsertSectionContent(projectBody, "Next 3 Actions", toBulletSection(next_actions.slice(0, 3)), 2);
          projectBody = upserted.body;
          sectionUpdates.push({ section: "Next 3 Actions", action: upserted.action });
        }

        await writeNoteWithFrontmatter(projectContextPath, projectBody, projectContextRecord.frontmatter ?? {});

        const projectDir = deriveProjectDir(projectContextPath);
        const projectName = path.posix.basename(projectDir || projectContextPath, ".md");
        const sessionLogPath = projectDir
          ? `${projectDir}/Session Logs/${effectiveSessionDate}.md`
          : `Session Logs/${effectiveSessionDate}.md`;
        const latestSummary = summarizeProjectContext(projectBody);

        const checkpointLogBlock = [
          `## Checkpoint (${new Date().toISOString()})`,
          `- Active project context path: \`${projectContextPath}\``,
          `- Section updates: ${sectionUpdates.length > 0 ? sectionUpdates.map((s) => `${s.section} (${s.action})`).join(", ") : "none"}`,
          `- Priorities: ${latestSummary.priorities.length > 0 ? latestSummary.priorities.join(" | ") : "none"}`,
          `- Blockers: ${latestSummary.blockers.length > 0 ? latestSummary.blockers.join(" | ") : "none"}`,
          `- Next 3 actions: ${latestSummary.next_3_actions.length > 0 ? latestSummary.next_3_actions.join(" | ") : "none"}`,
        ].join("\n");
        await appendMarkdownBlock(
          sessionLogPath,
          checkpointLogBlock,
          `# Session Log — ${effectiveSessionDate}`
        );

        const pointerResult = await ensureRootSessionPointer(effectiveSessionDate, normalizeNotePath(sessionLogPath), projectName);

        let trackerSyncResult: Record<string, any> | null = null;
        if (include_tracker_sync) {
          trackerSyncResult = await runTrackerSyncInternal({
            project_context_path: projectContextPath,
            updates: tracker_updates,
            create_missing: true,
            render_table: true,
            max_log_entries: 20,
            log_to_session: false,
            session_date: effectiveSessionDate,
          });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              active_project_context_path: projectContextPath,
              active_project_context_source: activeProject.source,
              active_project_dir: projectDir,
              project_context_sections_updated: sectionUpdates,
              session_log_path: normalizeNotePath(sessionLogPath),
              pointer_note: pointerResult,
              summary: latestSummary,
              tracker_sync: trackerSyncResult,
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
  // STALE STATE CHECKS
  // ============================================================

  server.tool(
    "vault_stale_state_checks",
    `Run stale-state health checks across project contexts and trackers.

Checks:
  - tracker_path present but tracker not updated in X days
  - issues in In Validation older than Y days
  - duplicate tracker IDs
  - project context older than X days`,
    {
      tracker_stale_days: z.number().min(1).max(365).default(7).describe("Tracker stale threshold in days"),
      validation_stale_days: z.number().min(1).max(365).default(14).describe("In Validation stale threshold in days"),
      project_context_stale_days: z.number().min(1).max(365).default(14).describe("Project context stale threshold in days"),
    },
    async ({ tracker_stale_days, validation_stale_days, project_context_stale_days }) => {
      try {
        const results = await runStaleStateChecks({
          tracker_stale_days,
          validation_stale_days,
          project_context_stale_days,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2),
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

        // Flywheel integrity checks (root scope only)
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
              flywheel_checks: {
                scope: normalizedSearchPath === "" ? "vault_root" : "limited_path",
                canonical_docs: canonicalDocs,
                duplicate_last_updated_footer_count: duplicateLastUpdatedFiles.length,
                duplicate_last_updated_footer_files: duplicateLastUpdatedFiles,
                index_updated_mismatch_count: indexUpdatedMismatches.length,
                index_updated_mismatches: indexUpdatedMismatches,
                orphan_context_doc_count: orphanContextDocs.length,
                orphan_context_docs: orphanContextDocs,
              },
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
  console.error("  Registered: vault_start_session, vault_checkpoint, vault_tracker_sync, vault_resume");
  console.error("  Registered: vault_stale_state_checks");
}
