import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildDocumentModel,
  type ApexSymbol,
  type DocumentModel,
} from "./apexModel.js";

export interface IndexedSymbol {
  uri: string;
  filePath: string;
  symbol: ApexSymbol;
  model: DocumentModel;
}

interface IndexedFile {
  filePath: string;
  uri: string;
  mtimeMs: number;
  version?: number;
  model: DocumentModel;
}

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "generated",
  ".git",
  ".sfdx",
  ".sf",
  ".apexx",
]);

/**
 * Every `.clsx` file in the workspace, parsed and cached, so definitions can be
 * resolved across files. Open documents take precedence over what is on disk, so
 * unsaved edits still resolve.
 */
export class WorkspaceIndex {
  private readonly files = new Map<string, IndexedFile>();

  constructor(private readonly root: string) {}

  /** Re-reads any file that changed on disk and drops any that disappeared. */
  refresh(openDocuments: ReadonlyMap<string, { text: string; version: number }>): void {
    const found = new Set<string>();

    for (const filePath of collectClsxFiles(this.root)) {
      found.add(filePath);
      const uri = pathToFileURL(filePath).href;
      const open = openDocuments.get(uri);
      const cached = this.files.get(filePath);

      if (open) {
        if (cached?.version !== open.version) {
          this.files.set(filePath, {
            filePath,
            uri,
            mtimeMs: cached?.mtimeMs ?? 0,
            version: open.version,
            model: buildDocumentModel(open.text),
          });
        }

        continue;
      }

      let mtimeMs: number;

      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      if (cached && cached.version === undefined && cached.mtimeMs === mtimeMs) {
        continue;
      }

      try {
        this.files.set(filePath, {
          filePath,
          uri,
          mtimeMs,
          model: buildDocumentModel(fs.readFileSync(filePath, "utf8")),
        });
      } catch {
        // An unreadable file simply stays out of the index.
      }
    }

    for (const filePath of [...this.files.keys()]) {
      if (!found.has(filePath)) {
        this.files.delete(filePath);
      }
    }
  }

  /** Types declared anywhere in the workspace, matched case-insensitively as Apex is. */
  findTypes(name: string): IndexedSymbol[] {
    return this.matching(
      symbol =>
        (symbol.kind === "class" ||
          symbol.kind === "interface" ||
          symbol.kind === "enum") &&
        equalsIgnoreCase(symbol.name, name),
    );
  }

  /** Members of `typeName`: methods, fields and properties declared directly on it. */
  findMembers(typeName: string, memberName: string): IndexedSymbol[] {
    return this.matching(
      symbol =>
        equalsIgnoreCase(symbol.container ?? "", typeName) &&
        equalsIgnoreCase(symbol.name, memberName) &&
        (symbol.kind === "method" ||
          symbol.kind === "constructor" ||
          symbol.kind === "field" ||
          symbol.kind === "property"),
    );
  }

  /** Every type declared in the workspace, for identifier completion. */
  allTypes(): IndexedSymbol[] {
    return this.matching(
      symbol =>
        symbol.kind === "class" ||
        symbol.kind === "interface" ||
        symbol.kind === "enum",
    );
  }

  /** Every member declared directly on `typeName`, for member completion. */
  typeMembers(typeName: string): IndexedSymbol[] {
    return this.matching(
      symbol =>
        equalsIgnoreCase(symbol.container ?? "", typeName) &&
        (symbol.kind === "method" ||
          symbol.kind === "field" ||
          symbol.kind === "property" ||
          symbol.kind === "enum" ||
          symbol.kind === "class" ||
          symbol.kind === "interface"),
    );
  }

  /** Any declaration with this name, used as a last resort for a bare identifier. */
  findAnywhere(name: string): IndexedSymbol[] {
    return this.matching(
      symbol =>
        equalsIgnoreCase(symbol.name, name) &&
        symbol.kind !== "local" &&
        symbol.kind !== "parameter",
    );
  }

  /** Declarations worth offering in a workspace symbol search. */
  search(query: string): IndexedSymbol[] {
    const needle = query.toLowerCase();

    return this.matching(
      symbol =>
        symbol.kind !== "local" &&
        symbol.kind !== "parameter" &&
        (needle.length === 0 || symbol.name.toLowerCase().includes(needle)),
    ).slice(0, 200);
  }

  /** Indexed files, with the mtime used to decide whether work can be skipped. */
  entries(): IndexedFile[] {
    return [...this.files.values()];
  }

  private matching(predicate: (symbol: ApexSymbol) => boolean): IndexedSymbol[] {
    const results: IndexedSymbol[] = [];

    for (const file of this.files.values()) {
      for (const symbol of file.model.symbols) {
        if (predicate(symbol)) {
          results.push({
            uri: file.uri,
            filePath: file.filePath,
            symbol,
            model: file.model,
          });
        }
      }
    }

    return results;
  }
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function collectClsxFiles(root: string): string[] {
  const results: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const directory = queue.pop();

    if (!directory) {
      continue;
    }

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(full);
        }

        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".clsx")) {
        results.push(full);
      }
    }
  }

  return results;
}

/**
 * Reads the qualifier in front of the identifier at `offset`, so
 * `PortfolioRuleProvider.resolve` resolves against the right type. Also reports
 * whether the identifier is a decorator annotation such as `@UserFriendlyError`.
 */
export function readReferenceContext(
  source: string,
  identifierStart: number,
): { qualifier?: string; isAnnotation: boolean } {
  const before = source.slice(0, identifierStart);
  const trimmed = before.replace(/\s+$/, "");

  if (trimmed.endsWith("@")) {
    return { isAnnotation: true };
  }

  if (!trimmed.endsWith(".")) {
    return { isAnnotation: false };
  }

  const qualifier = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(before)?.[1];
  return { qualifier, isAnnotation: false };
}
