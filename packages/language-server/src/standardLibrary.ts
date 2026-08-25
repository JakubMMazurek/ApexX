import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
} from "vscode-languageserver/node.js";
import { buildDocumentModel, type ApexSymbol } from "./apexModel.js";

/**
 * The Apex standard library, read from the Salesforce Apex extension.
 *
 * That extension ships `StandardApexLibrary.zip`: 2365 Apex stub classes, one per
 * standard type, with real signatures and real doc comments. It is what the Apex
 * language server resolves `Messaging.SingleEmailMessage` against, so reading the same
 * archive is how ApexX offers the same library rather than an approximation of it.
 *
 * Nothing is copied into this repository -- the archive is read where the user already
 * has it, and every entry point degrades to `undefined` when it is not installed, which
 * leaves ApexX on its own curated table. The stubs are parsed with the same Apex parser
 * the compiler uses, so a signature here is a signature the compiler would accept.
 */

const ARCHIVE_PREFIX = "src/resources/StandardApexLibrary/";

interface ZipEntry {
  /** Path within the archive, below the prefix: `System/Math.cls`. */
  name: string;
  offset: number;
  compressedSize: number;
  compressionMethod: number;
}

interface Library {
  archive: Buffer;
  /** Simple type name, lowercased, to its entries -- a name can repeat per namespace. */
  types: Map<string, ZipEntry[]>;
  /** Namespace name, lowercased, to the types declared in it. */
  namespaces: Map<string, string[]>;
}

/** `undefined` means "looked and did not find"; the lookup is only attempted once. */
let library: Library | null | undefined;
/** Set when the client asks ApexX not to read the Apex extension's archive at all. */
let disabled = false;

/**
 * Turns the library off for this session, leaving every lookup answering `undefined` so
 * ApexX falls back to its own table. Useful when the archive is unwanted or unreadable.
 */
export function disableStandardLibrary(): void {
  disabled = true;
  library = null;
  memberCache.clear();
}
const memberCache = new Map<string, CompletionItem[] | undefined>();

function load(): Library | undefined {
  if (disabled) {
    return undefined;
  }

  if (library !== undefined) {
    return library ?? undefined;
  }

  library = null;
  const archivePath = findArchive();

  if (!archivePath) {
    return undefined;
  }

  try {
    const archive = fs.readFileSync(archivePath);
    const types = new Map<string, ZipEntry[]>();
    const namespaces = new Map<string, string[]>();

    for (const entry of readCentralDirectory(archive)) {
      if (!entry.name.endsWith(".cls")) {
        continue;
      }

      const [namespace, file] = entry.name.split("/");
      if (!namespace || !file) {
        continue;
      }

      const typeName = file.slice(0, -".cls".length);
      const key = typeName.toLowerCase();
      types.set(key, [...(types.get(key) ?? []), entry]);

      const namespaceKey = namespace.toLowerCase();
      namespaces.set(namespaceKey, [
        ...(namespaces.get(namespaceKey) ?? []),
        typeName,
      ]);
    }

    if (types.size === 0) {
      return undefined;
    }

    library = { archive, types, namespaces };
    return library;
  } catch {
    // A missing or unreadable archive is not an error: it is the normal state on a
    // machine without the Apex extension.
    return undefined;
  }
}

/** Where the Apex extension keeps the archive, unless told otherwise. */
function findArchive(): string | undefined {
  const override = process.env.APEXX_STANDARD_LIBRARY;

  if (override) {
    return fs.existsSync(override) ? override : undefined;
  }

  const roots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
    path.join(os.homedir(), ".vscode-server", "extensions"),
  ];

  for (const root of roots) {
    let entries: string[];

    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }

    // Newest version last, so the highest-numbered directory wins.
    const candidates = entries
      .filter(entry => /^salesforce\.apex-language-server-extension-\d/.test(entry))
      .sort();

    for (const candidate of candidates.reverse()) {
      const archive = path.join(
        root,
        candidate,
        "resources",
        "StandardApexLibrary.zip",
      );

      if (fs.existsSync(archive)) {
        return archive;
      }
    }
  }

  return undefined;
}

/**
 * The archive's central directory.
 *
 * Reading it directly keeps the language server dependency-free and identical on every
 * platform, which shelling out to `unzip` would not be.
 */
function readCentralDirectory(archive: Buffer): ZipEntry[] {
  const END_SIGNATURE = 0x06054b50;
  const ENTRY_SIGNATURE = 0x02014b50;
  // The end record is last, but a trailing comment may follow it, so it is searched
  // for backwards over the largest comment the format allows.
  const searchStart = Math.max(0, archive.length - 22 - 0xffff);
  let end = -1;

  for (let index = archive.length - 22; index >= searchStart; index -= 1) {
    if (archive.readUInt32LE(index) === END_SIGNATURE) {
      end = index;
      break;
    }
  }

  if (end < 0) {
    return [];
  }

  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length) {
      break;
    }

    if (archive.readUInt32LE(cursor) !== ENTRY_SIGNATURE) {
      break;
    }

    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    const name = archive
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    if (name.startsWith(ARCHIVE_PREFIX)) {
      entries.push({
        name: name.slice(ARCHIVE_PREFIX.length),
        offset,
        compressedSize,
        compressionMethod,
      });
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** One entry's contents. The local header repeats the name and extra field lengths. */
function readEntry(archive: Buffer, entry: ZipEntry): string | undefined {
  const LOCAL_SIGNATURE = 0x04034b50;

  if (archive.readUInt32LE(entry.offset) !== LOCAL_SIGNATURE) {
    return undefined;
  }

  const nameLength = archive.readUInt16LE(entry.offset + 26);
  const extraLength = archive.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const body = archive.subarray(start, start + entry.compressedSize);

  try {
    return entry.compressionMethod === 0
      ? body.toString("utf8")
      : zlib.inflateRawSync(body).toString("utf8");
  } catch {
    return undefined;
  }
}

export interface StandardType {
  name: string;
  namespace: string;
}

/** Every type the library declares, and every namespace, for identifier completion. */
export function standardLibraryTypes(): StandardType[] {
  const loaded = load();

  if (!loaded) {
    return [];
  }

  const results: StandardType[] = [];

  for (const entries of loaded.types.values()) {
    for (const entry of entries) {
      const [namespace, file] = entry.name.split("/");
      results.push({ name: file.slice(0, -".cls".length), namespace });
    }
  }

  return results;
}

/** The namespaces the library declares, e.g. `Messaging`, `Schema`, `ConnectApi`. */
export function standardLibraryNamespaces(): string[] {
  const loaded = load();

  if (!loaded) {
    return [];
  }

  // The directory name is lowercased in the index, so the declared spelling is taken
  // from an entry rather than from the key.
  const spellings = new Map<string, string>();

  for (const entries of loaded.types.values()) {
    for (const entry of entries) {
      const namespace = entry.name.split("/")[0];
      spellings.set(namespace.toLowerCase(), namespace);
    }
  }

  return [...spellings.values()];
}

/** True when the name is a namespace rather than a type. */
export function isStandardNamespace(name: string): boolean {
  return load()?.namespaces.has(name.toLowerCase()) ?? false;
}

/** The types a namespace contains, offered as its members. */
export function standardNamespaceMembers(
  namespace: string,
): CompletionItem[] | undefined {
  const types = load()?.namespaces.get(namespace.toLowerCase());

  if (!types) {
    return undefined;
  }

  return [...new Set(types)].sort().map(name => ({
    label: name,
    kind: CompletionItemKind.Class,
    detail: `Apex ${namespace}.${name}`,
  }));
}

/**
 * What a bare type name offers as a receiver.
 *
 * Apex blurs the line between a namespace and a class: `Messaging` is a namespace that
 * holds `SingleEmailMessage`, and also a class whose `sendEmail` the stubs declare as an
 * instance method even though everyone writes `Messaging.sendEmail(...)`. Rather than
 * pick one reading and hide the other, a namespace-class offers all three: its statics,
 * its instance methods, and the types the namespace contains.
 */
export function standardReceiverMembers(
  name: string,
): CompletionItem[] | undefined {
  const isNamespace = isStandardNamespace(name);
  const statics = standardLibraryMembers(name, true) ?? [];
  const instance = isNamespace ? (standardLibraryMembers(name, false) ?? []) : [];
  const types = isNamespace ? (standardNamespaceMembers(name) ?? []) : [];
  const merged = new Map<string, CompletionItem>();

  for (const item of [...statics, ...instance, ...types]) {
    if (!merged.has(item.label)) {
      merged.set(item.label, item);
    }
  }

  return merged.size > 0 ? [...merged.values()] : undefined;
}

/**
 * Members of a standard type.
 *
 * `wantStatic` picks which half: a static receiver such as `Math.` and an instance of
 * the same type offer different members, exactly as in Apex.
 */
export function standardLibraryMembers(
  typeName: string,
  wantStatic: boolean,
): CompletionItem[] | undefined {
  const simple = typeName.trim().split(".").at(-1) ?? "";
  const cacheKey = `${simple.toLowerCase()}:${wantStatic}`;

  if (memberCache.has(cacheKey)) {
    return memberCache.get(cacheKey);
  }

  const members = computeMembers(simple, wantStatic);
  memberCache.set(cacheKey, members);
  return members;
}

function computeMembers(
  simple: string,
  wantStatic: boolean,
): CompletionItem[] | undefined {
  const loaded = load();
  const entries = loaded?.types.get(simple.toLowerCase());

  if (!loaded || !entries || entries.length === 0) {
    return undefined;
  }

  const items = new Map<string, CompletionItem>();

  // A simple name can appear in more than one namespace. Rather than guess which was
  // meant, every match contributes, which is the same answer an unqualified reference
  // could legally have.
  for (const entry of entries) {
    const source = readEntry(loaded.archive, entry);

    if (!source) {
      continue;
    }

    const normalized = normalizeStub(source);
    const model = buildDocumentModel(normalized);
    const owner = entry.name.split("/").at(-1)?.slice(0, -".cls".length) ?? simple;

    for (const symbol of model.symbols) {
      if (!isMember(symbol) || !sameType(symbol.container, owner)) {
        continue;
      }

      const isStatic = /\bstatic\b/i.test(symbol.modifiers ?? "");
      if (isStatic !== wantStatic) {
        continue;
      }

      const item = toCompletionItem(symbol, owner, normalized);
      // Overloads collapse to their first signature, the way the curated table reads.
      if (!items.has(item.label)) {
        items.set(item.label, item);
      }
    }
  }

  return items.size > 0 ? [...items.values()] : undefined;
}

/** DML statement keywords, which Apex allows as method names only when qualified. */
const DML_METHOD_NAMES = "insert|update|upsert|delete|undelete|merge";
const DML_METHOD_DECLARATION = new RegExp(
  `^(\\s*(?:global|public|private|protected)\\b[^(]*?\\b)(${DML_METHOD_NAMES})(\\s*\\()`,
  "i",
);
const DML_PREFIX = "apexxDml_";

/**
 * Makes a stub parse.
 *
 * `Database.insert(...)` is a real method whose name is a DML keyword, so the stub
 * declares `global static Database.SaveResult insert(SObject record) {}` -- which the
 * Apex grammar reads as a DML statement, not a declaration. The whole method is then
 * lost and its parameters leak out as class-level fields, which is how `Boolean` ends
 * up looking like a member of `Database`. Renaming just the declared name lets the
 * declaration parse; the prefix comes back off the symbol afterwards.
 *
 * Only declaration lines are touched, so a `@param recordToDelete` line in a doc
 * comment keeps its wording.
 */
function normalizeStub(source: string): string {
  return source
    .split("\n")
    .map(line =>
      DML_METHOD_DECLARATION.test(line)
        ? line.replace(DML_METHOD_DECLARATION, `$1${DML_PREFIX}$2$3`)
        : line,
    )
    .join("\n");
}

function declaredName(symbol: ApexSymbol): string {
  return symbol.name.startsWith(DML_PREFIX)
    ? symbol.name.slice(DML_PREFIX.length)
    : symbol.name;
}

export interface StandardSignature {
  label: string;
  parameters: { label: string }[];
  documentation?: string;
}

/**
 * Every overload of a standard method.
 *
 * Completion collapses overloads to one entry, the way TypeScript's does -- ten
 * identical `insert` labels help nobody choose. Signature help is where the overloads
 * belong, so this is the one place they are all returned.
 */
export function standardLibrarySignatures(
  typeName: string,
  memberName: string,
): StandardSignature[] {
  const loaded = load();
  const simple = typeName.trim().split(".").at(-1) ?? "";
  const entries = loaded?.types.get(simple.toLowerCase());

  if (!loaded || !entries) {
    return [];
  }

  const signatures: StandardSignature[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const source = readEntry(loaded.archive, entry);

    if (!source) {
      continue;
    }

    const normalized = normalizeStub(source);
    const model = buildDocumentModel(normalized);
    const owner = entry.name.split("/").at(-1)?.slice(0, -".cls".length) ?? simple;

    for (const symbol of model.symbols) {
      const isCall = symbol.kind === "method" || symbol.kind === "constructor";

      if (!isCall || !sameType(symbol.container, owner)) {
        continue;
      }

      if (declaredName(symbol).toLowerCase() !== memberName.toLowerCase()) {
        continue;
      }

      const parameters = symbol.parameters ?? [];
      const returnType =
        symbol.kind === "constructor" ? "" : `${symbol.type ?? "void"} `;
      const label = `${returnType}${owner}.${declaredName(symbol)}(${parameters
        .map(parameter => `${parameter.type} ${parameter.name}`)
        .join(", ")})`;

      if (seen.has(label)) {
        continue;
      }

      seen.add(label);
      signatures.push({
        label,
        parameters: parameters.map(parameter => ({
          label: `${parameter.type} ${parameter.name}`,
        })),
        documentation: docComment(normalized, symbol.declStart),
      });
    }
  }

  // Fewest parameters first, so the simplest overload is the one offered by default.
  return signatures.sort(
    (left, right) => left.parameters.length - right.parameters.length,
  );
}

function isMember(symbol: ApexSymbol): boolean {
  return (
    symbol.kind === "method" ||
    symbol.kind === "field" ||
    symbol.kind === "property"
  );
}

/** An inner type's members belong to it, not to the file's outer type. */
function sameType(container: string | undefined, owner: string): boolean {
  return (container ?? "").toLowerCase() === owner.toLowerCase();
}

function toCompletionItem(
  symbol: ApexSymbol,
  owner: string,
  source: string,
): CompletionItem {
  const documentation = docComment(source, symbol.declStart);

  const name = declaredName(symbol);

  if (symbol.kind === "method") {
    const parameters = symbol.parameters ?? [];
    const signature = `${symbol.type ?? "void"} ${owner}.${name}(${parameters
      .map(parameter => `${parameter.type} ${parameter.name}`)
      .join(", ")})`;
    const insertText =
      parameters.length === 0
        ? `${name}()`
        : `${name}(${parameters
            .map((parameter, index) => `\${${index + 1}:${parameter.name}}`)
            .join(", ")})`;

    return {
      label: name,
      kind: CompletionItemKind.Method,
      detail: signature,
      insertText,
      insertTextFormat: InsertTextFormat.Snippet,
      ...(documentation ? { documentation } : {}),
    };
  }

  return {
    label: name,
    kind:
      symbol.kind === "property"
        ? CompletionItemKind.Property
        : CompletionItemKind.Field,
    detail: `${symbol.type ?? "Object"} ${owner}.${name}`,
    ...(documentation ? { documentation } : {}),
  };
}

/**
 * The doc comment immediately above a declaration, stripped of its comment markers.
 *
 * This is the description Salesforce publishes for the member, which is the difference
 * between a name and something a reader can act on.
 */
function docComment(source: string, declStart: number): string | undefined {
  const before = source.slice(0, declStart);
  const close = before.lastIndexOf("*/");

  if (close < 0) {
    return undefined;
  }

  // A declaration's recorded start is its type, not its modifiers, so what separates
  // it from the comment above is whitespace and modifier keywords -- and nothing else,
  // or the comment belongs to some earlier declaration.
  const between = before.slice(close + 2).trim();
  if (between.length > 0 && !/^(?:global|public|private|protected|static|final|virtual|abstract|override|transient|webservice)(?:\s+(?:global|public|private|protected|static|final|virtual|abstract|override|transient|webservice))*$/i.test(between)) {
    return undefined;
  }

  const open = before.lastIndexOf("/**", close);

  if (open < 0) {
    return undefined;
  }

  const lines = before
    .slice(open + 3, close)
    .split("\n")
    .map(line => line.replace(/^\s*\*?\s?/, "").trimEnd())
    .filter(line => !/^@(param|return)\b/.test(line.trim()));

  const text = lines.join("\n").trim();
  return text.length > 0 ? text : undefined;
}
