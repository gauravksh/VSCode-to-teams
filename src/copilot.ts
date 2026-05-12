import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

export interface ChatSummaryLine {
  text: string;
  timestamp: number;
}

/**
 * Best-effort extraction of single-line summaries from Copilot chat sessions
 * stored on disk under VS Code's workspaceStorage. Format is undocumented and
 * may change between VS Code versions; failures degrade silently.
 */
export async function getCopilotChatSummariesSince(
  context: vscode.ExtensionContext,
  sinceMs: number,
): Promise<ChatSummaryLine[]> {
  const candidates = getStorageRoots(context);
  const results: ChatSummaryLine[] = [];

  for (const root of candidates) {
    try {
      await collectFromDir(root, sinceMs, results);
    } catch {
      // ignore
    }
  }

  // De-duplicate while preserving most recent first
  const seen = new Set<string>();
  results.sort((a, b) => b.timestamp - a.timestamp);
  const unique: ChatSummaryLine[] = [];
  for (const r of results) {
    const key = r.text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  return unique;
}

function getStorageRoots(context: vscode.ExtensionContext): string[] {
  const roots: string[] = [];
  // The extension's globalStorageUri lives under .../User/globalStorage/<publisher>.<ext>/
  // Walk up to .../User/ then into workspaceStorage.
  try {
    const global = context.globalStorageUri.fsPath;
    const userDir = path.resolve(global, "..", "..");
    roots.push(path.join(userDir, "workspaceStorage"));
  } catch {
    // ignore
  }

  // Common defaults as fallback
  const home = os.homedir();
  if (process.platform === "darwin") {
    roots.push(
      path.join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "workspaceStorage",
      ),
    );
  } else if (process.platform === "win32") {
    if (process.env.APPDATA) {
      roots.push(
        path.join(process.env.APPDATA, "Code", "User", "workspaceStorage"),
      );
    }
  } else {
    roots.push(path.join(home, ".config", "Code", "User", "workspaceStorage"));
  }

  return Array.from(new Set(roots));
}

async function collectFromDir(
  dir: string,
  sinceMs: number,
  out: ChatSummaryLine[],
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Limit recursion depth implicitly by skipping known-noisy dirs
      if (e.name === "node_modules" || e.name.startsWith(".")) {
        continue;
      }
      await collectFromDir(full, sinceMs, out);
    } else if (e.isFile() && e.name.endsWith(".json")) {
      const lower = full.toLowerCase();
      if (
        !lower.includes("chat") &&
        !lower.includes("copilot") &&
        !lower.includes("interactive")
      ) {
        continue;
      }
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < sinceMs) {
          continue;
        }
        const raw = await fs.readFile(full, "utf8");
        if (raw.length > 5 * 1024 * 1024) {
          continue; // skip huge files
        }
        const data = JSON.parse(raw);
        extractSummaries(data, sinceMs, out);
      } catch {
        // ignore parse / read errors
      }
    }
  }
}

function extractSummaries(
  node: any,
  sinceMs: number,
  out: ChatSummaryLine[],
): void {
  if (!node) {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      extractSummaries(child, sinceMs, out);
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }

  // Heuristic: chat request entries usually have a 'message' or 'request.message'/'text' and a timestamp.
  const ts = pickTimestamp(node);
  const text = pickUserPrompt(node);
  if (text && (ts === undefined || ts >= sinceMs)) {
    const oneLine = toSingleLine(text);
    if (oneLine && oneLine.length >= 4 && oneLine.length <= 240) {
      out.push({ text: oneLine, timestamp: ts ?? Date.now() });
    }
  }

  for (const key of Object.keys(node)) {
    const v = (node as any)[key];
    if (v && typeof v === "object") {
      extractSummaries(v, sinceMs, out);
    }
  }
}

function pickTimestamp(node: any): number | undefined {
  for (const k of ["timestamp", "requestTime", "time", "createdAt", "date"]) {
    const v = node[k];
    if (typeof v === "number" && v > 1_000_000_000_000) {
      return v;
    }
    if (typeof v === "string") {
      const n = Date.parse(v);
      if (!isNaN(n)) {
        return n;
      }
    }
  }
  return undefined;
}

function pickUserPrompt(node: any): string | undefined {
  // Common shapes seen in chat session JSON.
  const candidates = [
    node?.request?.message?.text,
    node?.request?.message,
    node?.message?.text,
    node?.prompt?.text,
    node?.prompt,
    node?.userMessage,
    node?.text,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c;
    }
  }
  return undefined;
}

function toSingleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
