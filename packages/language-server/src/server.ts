#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodeAction,
  CodeActionKind,
  CompletionItem,
  Diagnostic,
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  DocumentHighlightKind,
  DocumentSymbol,
  InsertTextFormat,
  Location,
  Position,
  ProposedFeatures,
  Range,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  WorkspaceEdit,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  findApexXDecorators,
  nativeApexAnnotations,
  transpileApexX,
  type ApexXDecorator,
} from "@apexx/transpiler";
import type {
  ApexXDiagnostic,
  ApexXStructuralTypes,
  ApexXUnitMode,
  SourcePosition,
} from "@apexx/ast";
import {
  collectListVariables,
  createApexTypeProvider,
  extractListElementType,
  inferExpressionType,
  normalizeType,
} from "@apexx/semantics";
import {
  getSObjectFields,
  knownSObjectNames,
  type SObjectFieldInfo,
} from "./sobjectSchema.js";
import { JorjeClient } from "./jorjeClient.js";
import {
  ApexBridge,
  isGeneratedArtifact,
  translateGeneratedNames,
  type BridgedDocument,
} from "./apexBridge.js";
import {
  readReferenceContext,
  WorkspaceIndex,
  type IndexedSymbol,
} from "./workspaceIndex.js";
import {
  buildDocumentModel,
  describeSymbol,
  findOccurrences,
  identifierAt,
  maskCommentsAndStrings,
  resolveSymbol,
  type ApexSymbol,
  type ApexSymbolKind,
  type DocumentModel,
} from "./apexModel.js";
import {
  apexGlobalTypes,
  apexKeywordCompletions,
  builtInInstanceMembers,
  exceptionInstanceMembers,
  sObjectBuiltInMembers,
} from "./apexGlobals.js";
import { findSoqlContext, soqlCompletions } from "./soql.js";
import {
  disableStandardLibrary,
  isStandardNamespace,
  standardLibrarySignatures,
  standardLibraryMembers,
  standardLibraryNamespaces,
  standardLibraryTypes,
  standardReceiverMembers,
} from "./standardLibrary.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let workspaceRoot: string | undefined;
/** Java home for the Apex language server, supplied by the client if it knows one. */
let apexJavaHome: string | undefined;
/**
 * Set APEXX_DISABLE_APEX_SERVER=1 to run on the built-in symbol model alone, with
 * no JVM. Everything still works; overloads and org types stop being resolved.
 */
/**
 * Off by default.
 *
 * The Apex language server keeps a persistent index at `.sfdx/tools/<version>/apex.db`
 * for the workspace it is started in. The Salesforce Apex extension already runs one
 * per open workspace, so starting a second against the same project means two writers
 * on one database, which corrupts it -- taking the Apex extension down with it. Until
 * ApexX runs its server against an isolated shadow project, this is opt-in.
 */
let apexServerEnabled = /^(1|true|yes)$/i.test(
  process.env.APEXX_APEX_SERVER ?? "",
);
/**
 * Apex semantic errors from the Apex language server, off by default.
 *
 * They catch real mistakes the ApexX compiler does not check for, such as calling a
 * method that does not exist. They also report code the platform accepts: the
 * checked-in sources draw six such errors, and a validate-only deploy of the same
 * classes succeeds, so they cannot be trusted as a build gate. Opt in per workspace.
 */
let apexDiagnosticsEnabled = /^(1|true|yes)$/i.test(
  process.env.APEXX_APEX_DIAGNOSTICS ?? "",
);

/** Matches how scripts are built, so the editor reports what a build would. */
let scriptStructuralTypes: ApexXStructuralTypes = "inline";

connection.onInitialize(params => {
  const initializationOptions = params.initializationOptions as
    | {
        javaHome?: string;
        useApexLanguageServer?: boolean;
        apexDiagnostics?: boolean;
        standardApexLibrary?: boolean;
        scriptStructuralTypes?: ApexXStructuralTypes;
      }
    | undefined;
  apexJavaHome = initializationOptions?.javaHome ?? process.env.APEXX_JAVA_HOME;

  if (initializationOptions?.useApexLanguageServer !== undefined) {
    apexServerEnabled = initializationOptions.useApexLanguageServer;
  }

  if (initializationOptions?.apexDiagnostics !== undefined) {
    apexDiagnosticsEnabled = initializationOptions.apexDiagnostics;
  }

  if (initializationOptions?.standardApexLibrary === false) {
    disableStandardLibrary();
  }

  if (initializationOptions?.scriptStructuralTypes !== undefined) {
    scriptStructuralTypes = initializationOptions.scriptStructuralTypes;
  }

  workspaceRoot = uriToFilePath(
    params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined,
  );

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        // `.` opens a member list and `@` an annotation, which is the pair the Apex
        // extension registers. Without `@` the annotation offer exists but is
        // unreachable: `@` is not a word character, so nothing else triggers it.
        triggerCharacters: [".", "@"],
        resolveProvider: false,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      implementationProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      workspaceSymbolProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
    },
  };
});

connection.onCompletion(async params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return [];
  }

  const source = document.getText();
  const offset = document.offsetAt(params.position);
  let apexxItems: CompletionItem[] = [];
  // The standard library is thousands of types, so an identifier position is answered
  // for the prefix typed so far rather than in full. Saying so is what makes the editor
  // ask again as the prefix grows, instead of filtering a list it believes is complete.
  let incomplete = false;

  try {
    const completions = getCompletions(document, params.position);
    apexxItems = completions.items;
    incomplete = completions.incomplete;
  } catch (error) {
    connection.console.error(formatError(error));
  }

  // After a dot, ApexX only has something to say when it recognised the receiver.
  // Otherwise it falls back to offering type names, which would bury the members
  // the Apex server resolves correctly -- so those are dropped here. The check is
  // on the dot itself, because a receiver ApexX cannot parse is exactly the case
  // where its fallback list is least useful.
  const receiver = findReceiverBeforeDot(source.slice(0, offset));

  if (
    receiver &&
    receiver !== "this" &&
    !findSoqlContext(source, offset) &&
    !inferReceiverType(source, offset, receiver) &&
    !staticCompletionsFor(receiver)
  ) {
    apexxItems = [];
  }

  // Every item says which text it replaces. Without a range the editor has nothing to
  // match the typed word against, so it stops filtering and offers the whole list --
  // which is how `Sys` ends up showing items that have no `s` in them at all.
  apexxItems = withReplaceRange(apexxItems, document, params.position);

  const apex = await askApex<CompletionItem[] | { items?: CompletionItem[] }>(
    "textDocument/completion",
    document,
    params.position,
    { context: params.context },
  );
  const apexItems = Array.isArray(apex?.result)
    ? apex.result
    : (apex?.result?.items ?? []);
  const seen = new Set(apexxItems.map(item => item.label));
  const merged = [...apexxItems];

  for (const item of apexItems) {
    if (!item?.label || seen.has(item.label) || isGeneratedArtifact(item.label)) {
      continue;
    }

    seen.add(item.label);
    merged.push({
      ...item,
      detail: item.detail
        ? translateGeneratedNames(item.detail, bridge?.documents() ?? [])
        : item.detail,
    });
  }

  return { isIncomplete: incomplete, items: merged };
});

/**
 * Gives each item the range of the identifier being typed, so accepting one replaces
 * that identifier rather than appending to it, and so the editor can filter.
 *
 * The range stops at the caret rather than covering the whole word, which is what
 * makes completing in the middle of an existing name insert instead of overwrite.
 */
function withReplaceRange(
  items: CompletionItem[],
  document: TextDocument,
  position: Position,
): CompletionItem[] {
  if (items.length === 0) {
    return items;
  }

  const source = document.getText();
  const offset = document.offsetAt(position);
  const typed = /[A-Za-z_][A-Za-z0-9_]*$/.exec(source.slice(0, offset))?.[0] ?? "";
  const range = Range.create(document.positionAt(offset - typed.length), position);

  return items.map(item =>
    item.textEdit
      ? item
      : {
          ...item,
          textEdit: {
            range,
            newText: item.insertText ?? item.label,
          },
          // The text now lives in the edit; leaving both risks the editor applying
          // the plain insert on a client that prefers it.
          insertText: undefined,
        },
  );
}

connection.onHover(async params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return null;
  }

  const source = document.getText();
  const offset = document.offsetAt(params.position);
  const identifier = identifierAt(source, offset);
  const sections: string[] = [];

  // The Apex language server resolves overloads and org types, so its answer wins
  // whenever it has one and the symbol is not ApexX-only.
  const apex = await askApex<{ contents?: { value?: string } | string }>(
    "textDocument/hover",
    document,
    params.position,
  );
  const apexHover = hoverText(apex?.result?.contents);

  if (apexHover && !isGeneratedArtifact(apexHover)) {
    sections.push(translateGeneratedNames(apexHover, bridge?.documents() ?? []).trim());
  }

  if (identifier) {
    const symbol = resolveSymbol(modelFor(document), identifier.name, offset);

    if (symbol && sections.length === 0) {
      // Apex hover shows the declaration and nothing else; prose about which
      // method a variable belongs to is noise the editor already makes obvious.
      sections.push(
        `\`\`\`apex\n${declarationText(refineType(symbol, source, offset))}\n\`\`\``,
      );
    }

    const keyword = hoverDocumentation(identifier.name);

    if (keyword) {
      sections.push(keyword);
    }

    const field = sObjectFieldHover(source, offset, identifier.name);

    if (field) {
      sections.push(field);
    }

    // A standard-library member: the platform's own signature and description, from the
    // same archive completion reads. Only when nothing nearer explained the symbol,
    // because a local named `size` is not List.size().
    if (sections.length === 0) {
      const standard = standardLibraryHover(source, offset, identifier.name);

      if (standard) {
        sections.push(standard);
      }
    }
  }

  return sections.length > 0
    ? { contents: { kind: "markdown", value: sections.join("\n\n---\n\n") } }
    : null;
});

/**
 * Folding by structure rather than by indentation.
 *
 * VS Code falls back to indentation when no provider answers, which folds a wrapped
 * argument list as if it were a block and cannot fold a comment at all. Braces are
 * counted here instead, over source with comments and strings masked out so a `}` in a
 * string does not close a region -- and comments and `// #region` markers fold too.
 */
connection.onFoldingRanges(params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return [];
  }

  return foldingRanges(document);
});

interface LspFoldingRange {
  startLine: number;
  endLine: number;
  kind?: "comment" | "imports" | "region";
}

function foldingRanges(document: TextDocument): LspFoldingRange[] {
  const source = document.getText();
  const masked = maskCommentsAndStrings(source);
  const ranges: LspFoldingRange[] = [];
  const openBraces: number[] = [];
  const openRegions: number[] = [];

  const lineOf = (offset: number): number => document.positionAt(offset).line;

  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];

    if (character === "{") {
      openBraces.push(index);
      continue;
    }

    if (character !== "}") {
      continue;
    }

    const open = openBraces.pop();

    if (open === undefined) {
      continue;
    }

    const startLine = lineOf(open);
    // The closing line folds away with the block, so the range ends one line short of
    // it -- which is what leaves the `}` visible when the block is collapsed.
    const endLine = lineOf(index) - 1;

    if (endLine > startLine) {
      ranges.push({ startLine, endLine });
    }
  }

  for (const comment of commentRanges(source)) {
    const startLine = lineOf(comment.start);
    const endLine = lineOf(comment.end);

    if (endLine > startLine) {
      ranges.push({ startLine, endLine, kind: "comment" });
    }
  }

  // `// #region` markers, which the language configuration already advertises.
  const lines = source.split("\n");

  lines.forEach((line, lineNumber) => {
    if (/^\s*\/\/\s*#?region\b/.test(line)) {
      openRegions.push(lineNumber);
      return;
    }

    if (!/^\s*\/\/\s*#?endregion\b/.test(line)) {
      return;
    }

    const start = openRegions.pop();

    if (start !== undefined && lineNumber > start) {
      ranges.push({ startLine: start, endLine: lineNumber, kind: "region" });
    }
  });

  return ranges;
}

/**
 * Comment spans, scanned straight out of the source.
 *
 * Diffing against the masked form cannot work: the mask replaces a comment with spaces,
 * and a comment's own indentation is already spaces, so the two are identical exactly
 * where the comment continues. Scanning is both simpler and exact.
 *
 * Consecutive line comments merge into one span, which is how an editor folds a block
 * of `//` lines -- as the block it reads as, not one range per line.
 */
interface CommentRange {
  start: number;
  end: number;
  /** Line comments merge with their neighbours; a block comment stands alone. */
  lineComment: boolean;
}

function commentRanges(source: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  let index = 0;

  const extendOrPush = (start: number, end: number, lineComment: boolean): void => {
    const previous = ranges.at(-1);

    // Only line comments merge, and only when nothing but whitespace separates them.
    if (
      lineComment &&
      previous?.lineComment &&
      /^[ \t\r\n]*$/.test(source.slice(previous.end + 1, start))
    ) {
      previous.end = end;
      return;
    }

    ranges.push({ start, end, lineComment });
  };

  while (index < source.length) {
    const two = source.slice(index, index + 2);

    if (two === "//") {
      const newline = source.indexOf("\n", index);
      const end = newline < 0 ? source.length - 1 : newline - 1;
      extendOrPush(index, end, true);
      index = end + 1;
      continue;
    }

    if (two === "/*") {
      const close = source.indexOf("*/", index + 2);
      const end = close < 0 ? source.length - 1 : close + 1;
      extendOrPush(index, end, false);
      index = end + 1;
      continue;
    }

    // A quote opens a string, whose contents must not be read as a comment.
    if (source[index] === "'") {
      let cursor = index + 1;

      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }

        if (source[cursor] === "'" || source[cursor] === "\n") {
          break;
        }

        cursor += 1;
      }

      index = cursor + 1;
      continue;
    }

    index += 1;
  }

  return ranges;
}

/**
 * Implementations of a type or of one of its methods.
 *
 * `Go to Definition` on an interface method lands on the interface, which is the one
 * place the answer is already known. This is the other direction: the classes in the
 * workspace that declare they implement it, and their own copy of the method.
 */
connection.onImplementation(params => {
  const cursor = symbolUnderCursor(params.textDocument.uri, params.position);
  const index = workspaceIndex();

  if (!cursor || !index) {
    return [];
  }

  const { symbol, name } = cursor;

  // On a type name, the implementors of that type. On a member, the same member on
  // each of them -- which is what the reader is actually looking for.
  const typeName =
    symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum"
      ? symbol.name
      : symbol.container;

  if (!typeName) {
    return [];
  }

  const implementors = index
    .allTypes()
    .filter(entry => declaresSupertype(entry, typeName));

  if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum") {
    return dedupeLocations(implementors.map(toDeclarationLocation));
  }

  const members = implementors.flatMap(entry =>
    index
      .typeMembers(entry.symbol.name)
      .filter(member => member.symbol.name.toLowerCase() === name.toLowerCase()),
  );

  return dedupeLocations(members.map(toDeclarationLocation));
});

/** Whether a type's declaration names `supertype` after `implements` or `extends`. */
function declaresSupertype(entry: IndexedSymbol, supertype: string): boolean {
  const header = entry.model.source.slice(
    entry.symbol.declStart,
    entry.symbol.declStart + 400,
  );
  const clause = /\b(?:implements|extends)\b([^{]*)/i.exec(header)?.[1];

  if (!clause) {
    return false;
  }

  return splitCommaList(clause).some(
    candidate =>
      (candidate.trim().split(".").at(-1) ?? "").replace(/<.*$/, "").toLowerCase() ===
      supertype.toLowerCase(),
  );
}

function toDeclarationLocation(entry: IndexedSymbol): Location {
  return Location.create(
    entry.uri,
    offsetRange(entry.model.source, entry.symbol.nameStart, entry.symbol.nameEnd),
  );
}

connection.onDocumentSymbol(params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return [];
  }

  return outline(document, modelFor(document));
});

connection.onDefinition(async params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return null;
  }

  const source = document.getText();
  const offset = document.offsetAt(params.position);
  const identifier = identifierAt(source, offset);

  if (!identifier) {
    return null;
  }

  const context = readReferenceContext(source, identifier.start);
  const index = workspaceIndex();
  const local = resolveSymbol(modelFor(document), identifier.name, offset);

  // Locals and parameters are resolved here rather than by the Apex server. Ours
  // are exact even inside lowered statements, where a generated position can only
  // map back to the statement it came from.
  if (local && (local.kind === "local" || local.kind === "parameter")) {
    return Location.create(
      params.textDocument.uri,
      rangeOf(document, local.nameStart, local.nameEnd),
    );
  }

  // A decorator annotation is ApexX-only: it does not survive lowering as an
  // annotation, so the workspace index answers it rather than the Apex server.
  if (!context.isAnnotation) {
    const apex = await askApex<LspLocation[] | LspLocation>(
      "textDocument/definition",
      document,
      params.position,
    );
    const mapped = asArray(apex?.result)
      .map(toAuthoredLocation)
      .filter((location): location is Location => location !== undefined);

    if (mapped.length > 0) {
      return mapped;
    }
  }

  // `@UserFriendlyError` points at the decorator class that implements it.
  if (context.isAnnotation) {
    return locationsFor(index?.findTypes(identifier.name) ?? []);
  }

  // `PortfolioRuleProvider.resolve` resolves the member on the named type, in
  // whichever file declares it, and falls back to the type itself.
  if (context.qualifier) {
    const members = index?.findMembers(context.qualifier, identifier.name) ?? [];

    if (members.length > 0) {
      return locationsFor(members);
    }

    const types = index?.findTypes(identifier.name) ?? [];

    if (types.length > 0) {
      return locationsFor(types);
    }
  }

  // A declaration in this file wins over anything else.
  if (local) {
    return Location.create(
      params.textDocument.uri,
      rangeOf(document, local.nameStart, local.nameEnd),
    );
  }

  const types = index?.findTypes(identifier.name) ?? [];

  if (types.length > 0) {
    return locationsFor(types);
  }

  return locationsFor(index?.findAnywhere(identifier.name) ?? []);
});

connection.onWorkspaceSymbol(params => {
  const index = workspaceIndex();

  if (!index) {
    return [];
  }

  return index.search(params.query).map(entry => ({
    name: entry.symbol.name,
    kind: OUTLINE_KINDS[entry.symbol.kind],
    containerName: entry.symbol.container,
    location: {
      uri: entry.uri,
      range: offsetRange(
        entry.model.source,
        entry.symbol.nameStart,
        entry.symbol.nameEnd,
      ),
    },
  }));
});

connection.onReferences(async params => {
  const document = apexxDocument(params.textDocument.uri);
  const scoped = symbolUnderCursor(params.textDocument.uri, params.position);

  // A local or parameter is scope-bound, so the local model answers it exactly.
  if (scoped && (scoped.symbol.kind === "local" || scoped.symbol.kind === "parameter")) {
    return occurrenceRanges(scoped.document, scoped.name, scoped.symbol).map(range =>
      Location.create(params.textDocument.uri, range),
    );
  }

  if (document) {
    const apex = await askApex<LspLocation[]>(
      "textDocument/references",
      document,
      params.position,
      { context: { includeDeclaration: true } },
    );
    const mapped = asArray(apex?.result)
      .map(toAuthoredLocation)
      .filter((location): location is Location => location !== undefined);

    if (mapped.length > 0) {
      return dedupeLocations(mapped);
    }
  }

  const found = symbolUnderCursor(params.textDocument.uri, params.position);

  if (!found) {
    return [];
  }

  return occurrenceRanges(found.document, found.name, found.symbol).map(range =>
    Location.create(params.textDocument.uri, range),
  );
});

connection.onDocumentHighlight(params => {
  const found = symbolUnderCursor(params.textDocument.uri, params.position);

  if (!found) {
    return [];
  }

  return occurrenceRanges(found.document, found.name, found.symbol).map(range => ({
    range,
    kind: DocumentHighlightKind.Text,
  }));
});

connection.onPrepareRename(params => {
  const found = symbolUnderCursor(params.textDocument.uri, params.position);

  if (!found) {
    return null;
  }

  return {
    range: rangeOf(found.document, found.identifier.start, found.identifier.end),
    placeholder: found.name,
  };
});

connection.onRenameRequest(async params => {
  const found = symbolUnderCursor(params.textDocument.uri, params.position);

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.newName)) {
    return null;
  }

  const document = apexxDocument(params.textDocument.uri);
  const isScoped =
    found && (found.symbol.kind === "local" || found.symbol.kind === "parameter");

  // A local or parameter is renamed here, where its scope is known exactly. Types
  // and members are renamed through the Apex server so every file is covered.
  if (document && !isScoped) {
    const apex = await askApex<{ changes?: Record<string, { range: Range; newText: string }[]> }>(
      "textDocument/rename",
      document,
      params.position,
      { newName: params.newName },
    );
    const mapped = mapWorkspaceEdit(apex?.result, params.newName);

    if (mapped) {
      return mapped;
    }
  }

  if (!found) {
    return null;
  }

  const edits = occurrenceRanges(found.document, found.name, found.symbol).map(range => ({
    range,
    newText: params.newName,
  }));

  const changes: WorkspaceEdit["changes"] = {
    [params.textDocument.uri]: edits,
  };

  return { changes };
});

connection.onCodeAction(async params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return [];
  }

  const apex = await askApex<CodeAction[]>(
    "textDocument/codeAction",
    document,
    params.range.start,
    { range: params.range, context: params.context },
  );

  // Only actions whose edits land in authored code are offered; a fix that would
  // rewrite generated output is not something the user can accept.
  return (apex?.result ?? []).flatMap(action => {
    const edit = mapWorkspaceEdit(action.edit, undefined);

    if (action.edit && !edit) {
      return [];
    }

    return [{ ...action, edit: edit ?? action.edit }];
  });
});

connection.onSignatureHelp(params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return null;
  }

  const source = document.getText();
  const offset = document.offsetAt(params.position);
  const call = enclosingCall(source, offset);

  if (!call) {
    return null;
  }

  const signatures = callSignatures(document, source, offset, call);

  if (signatures.length === 0) {
    return null;
  }

  return {
    signatures,
    activeSignature: 0,
    activeParameter: call.activeParameter,
  };
});

interface CallSignature {
  label: string;
  parameters: { label: string }[];
  documentation?: string;
}

/**
 * Signatures for the call the caret is inside.
 *
 * Three sources, nearest first: the file being edited, the workspace index, and the Apex
 * standard library. Only the current file used to be searched, which meant a qualified
 * call, a call into another `.clsx`, and every standard method had no signature at all.
 */
function callSignatures(
  document: TextDocument,
  source: string,
  offset: number,
  call: { name: string; receiver?: string; constructed?: boolean },
): CallSignature[] {
  const wanted = (symbol: ApexSymbol): boolean =>
    (symbol.kind === "method" || symbol.kind === "constructor") &&
    symbol.name.toLowerCase() === call.name.toLowerCase();

  // `new Foo(` names a type, so its constructors are what is being called.
  if (call.constructed) {
    const own = modelFor(document).symbols.filter(
      symbol => symbol.kind === "constructor" && equalsIgnoreCase(symbol.container ?? "", call.name),
    );
    const indexed = (workspaceIndex()?.typeMembers(call.name) ?? [])
      .filter(entry => entry.symbol.kind === "constructor")
      .map(entry => entry.symbol);
    const declared = [...own, ...indexed].map(toCallSignature);

    return declared.length > 0
      ? dedupeSignatures(declared)
      : dedupeSignatures(standardLibrarySignatures(call.name, call.name));
  }

  // An unqualified call is to something in this file, or to a member of its type.
  if (!call.receiver) {
    return dedupeSignatures(
      modelFor(document).symbols.filter(wanted).map(toCallSignature),
    );
  }

  // A qualified call: resolve the receiver to a type, then look that type up.
  const receiverType = inferReceiverType(source, offset, call.receiver);
  const typeName = receiverType ? bareTypeName(receiverType) : call.receiver;
  const fromWorkspace = (workspaceIndex()?.typeMembers(typeName) ?? [])
    .filter(entry => wanted(entry.symbol))
    .map(entry => entry.symbol)
    .map(toCallSignature);

  if (fromWorkspace.length > 0) {
    return dedupeSignatures(fromWorkspace);
  }

  return dedupeSignatures(standardLibrarySignatures(typeName, call.name));
}

function toCallSignature(symbol: ApexSymbol): CallSignature {
  return {
    label: describeSymbol(symbol),
    parameters: (symbol.parameters ?? []).map(parameter => ({
      label: `${parameter.type} ${parameter.name}`,
    })),
  };
}

function dedupeSignatures(signatures: CallSignature[]): CallSignature[] {
  const seen = new Set<string>();

  return signatures.filter(signature => {
    if (seen.has(signature.label)) {
      return false;
    }

    seen.add(signature.label);
    return true;
  });
}

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(event => validateDocument(event.document));
documents.onDidClose(event => {
  compilerDiagnostics.delete(event.document.uri);
  apexDiagnostics.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onShutdown(() => {
  jorje?.dispose();
});

connection.onExit(() => {
  jorje?.dispose();
});

documents.listen(connection);
connection.listen();

/**
 * `.clsx` compiles to a class and `.apexx` to an anonymous block. Both are
 * checked here; the Apex bridge below is class-only, because it works through a
 * shadow `.cls` named after the class and a script declares none.
 */
function apexXUnitMode(uri: string): ApexXUnitMode | undefined {
  const lowered = uri.toLowerCase();

  if (lowered.endsWith(".clsx")) {
    return "class";
  }

  return lowered.endsWith(".apexx") ? "anonymous" : undefined;
}

async function validateDocument(document: TextDocument): Promise<void> {
  const mode = apexXUnitMode(document.uri);

  if (!mode) {
    return;
  }

  try {
    const result = transpileApexX(document.getText(), {
      sourceFileName: document.uri.split("/").at(-1),
      workspaceRoot,
      mode,
      structuralTypes: scriptStructuralTypes,
    });

    compilerDiagnostics.set(document.uri, result.diagnostics.map(toLspDiagnostic));
    republishDiagnostics(document.uri);

    // Keep the Apex server's view of the generated code current so its semantic
    // diagnostics arrive for what the user is editing now.
    const backend = apexBackend();

    if (mode === "class" && backend?.jorje.isReady) {
      const bridged = backend.bridge.bridge(
        document.uri,
        document.getText(),
        `v${document.version}`,
      );

      if (bridged) {
        backend.jorje.syncDocument(bridged.generatedUri, bridged.output);
      }
    }
  } catch (error) {
    connection.console.error(formatError(error));
    compilerDiagnostics.set(document.uri, [
      {
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message: `ApexX language server error: ${formatError(error)}`,
        source: "apexx",
      },
    ]);
    republishDiagnostics(document.uri);
  }
}

function toLspDiagnostic(diagnostic: ApexXDiagnostic) {
  const start = toLspPosition(diagnostic.range?.start);
  const end = toLspPosition(diagnostic.range?.end);
  // A range that ends where it starts draws no squiggle at all, so it is widened
  // by one character. Anything wider is kept as authored, including the multi-line
  // spans that a chained pipeline produces.
  const covers =
    end.line > start.line ||
    (end.line === start.line && end.character > start.character);

  return {
    severity:
      diagnostic.severity === "error"
        ? DiagnosticSeverity.Error
        : diagnostic.severity === "warning"
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Information,
    range: {
      start,
      end: covers ? end : { line: start.line, character: start.character + 1 },
    },
    message: diagnostic.message,
    source: diagnostic.source ?? "apexx",
    // A coded diagnostic becomes a link to its entry in the reference, the way the
    // Apex server's own codes already arrive here.
    ...(diagnostic.code
      ? {
          code: diagnostic.code,
          codeDescription: { href: DIAGNOSTIC_REFERENCE_URL },
        }
      : {}),
  };
}

const DIAGNOSTIC_REFERENCE_URL =
  "https://github.com/JakubMMazurek/ApexX#diagnostic-reference";

/** ApexX lines are 1-based and columns 0-based; LSP counts both from zero. */
function toLspPosition(position: SourcePosition | undefined): {
  line: number;
  character: number;
} {
  return {
    line: Math.max((position?.line ?? 1) - 1, 0),
    character: Math.max(position?.column ?? 0, 0),
  };
}

interface CompletionResult {
  items: CompletionItem[];
  /** True when the list was cut to the typed prefix and must be asked for again. */
  incomplete: boolean;
}

function complete(items: CompletionItem[], incomplete = false): CompletionResult {
  return { items, incomplete };
}

function getCompletions(
  document: TextDocument,
  position: Position,
): CompletionResult {
  const source = document.getText();
  const offset = document.offsetAt(position);

  // An annotation is its own context: neither the name nor the arguments are members
  // of anything, so the receiver logic below has nothing to say about them.
  const annotation = findAnnotationContext(source, offset);
  if (annotation) {
    return complete(
      annotation.parameterOf
        ? decoratorParameterCompletions(source, annotation.parameterOf)
        : annotationCompletions(source),
    );
  }

  // A query literal is its own language, and its brackets are unambiguous, so it is
  // recognised before any of the expression rules get a chance to misread it.
  const soql = findSoqlContext(source, offset);
  if (soql) {
    // `FROM` is usually typed after the field list, so until it is there the object
    // is taken from what the query is being assigned to: `List<Account> rows = [`.
    const queried = soql.sObject ?? assignedSObject(source, soql.queryStart);
    return complete(soqlCompletions({ ...soql, sObject: queried }, {
      sObjectNames: () => knownSObjectNames(workspaceRoot),
      fieldsOf: sObject => {
        const fields = getSObjectFields(sObject, workspaceRoot) ?? [];
        return fields.map(fieldInfo => ({
          label: fieldInfo.name,
          detail: `${sObject}.${fieldInfo.name}: ${apexTypeForField(fieldInfo)}`,
        }));
      },
      boundValues: () => valuesInScope(document, offset),
    }));
  }

  // `implements` and `extends` name a type, never a value.
  const inheritance = /\b(implements|extends)\s+(?:[A-Za-z][A-Za-z0-9_.]*\s*,\s*)*[A-Za-z0-9_]*$/i.exec(
    source.slice(0, offset),
  );
  if (inheritance) {
    return complete(
      typeNameCompletions(document, inheritance[1].toLowerCase() === "implements"),
    );
  }

  // `new Account(` takes named fields, which is how an sObject is built inline.
  const constructed = findConstructedSObject(source, offset);
  if (constructed) {
    return complete(constructed);
  }

  const receiver = findReceiverBeforeDot(source.slice(0, offset));

  if (!receiver) {
    return identifierCompletions(document, offset);
  }

  // `this` is the enclosing type, which no type-name lookup can find.
  if (receiver === "this") {
    return complete(memberCompletions(enclosingTypeMembers(document, offset)));
  }

  const receiverType = inferReceiverType(source, offset, receiver);
  if (receiverType) {
    return complete(completionsForType(receiverType));
  }

  // A receiver that is not a value in scope may be a type being used statically,
  // which is a different member set from an instance of the same type.
  return complete(staticCompletionsFor(receiver) ?? []);
}

/**
 * What can be written where an identifier is expected: whatever is in scope first,
 * then the enclosing type's own members, then the types this workspace and the Apex
 * runtime declare, then keywords.
 *
 * The Apex extension answers the same question from its symbol table and org index.
 * This is the same list assembled from the document model, the workspace index and
 * the built-in tables, so a `.clsx` or `.apexx` file offers what a `.cls` file does.
 */
function identifierCompletions(
  document: TextDocument,
  offset: number,
): CompletionResult {
  const model = modelFor(document);
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  // Keyed by name alone, not by name and kind. Every rank below offers something
  // writable at this one position, so the same word twice is never two choices --
  // `System` reached both as a namespace and as a type is one entry, and the earlier,
  // more specific rank is the one that describes it.
  const push = (item: CompletionItem, rank: number): void => {
    if (seen.has(item.label)) {
      return;
    }

    seen.add(item.label);
    items.push({ ...item, sortText: `${rank}_${item.label}` });
  };

  const enclosing = enclosingType(model, offset);

  // Locals and parameters visible here. A symbol with no scope is a member, which
  // the next pass handles, so only scoped symbols are considered.
  for (const symbol of model.symbols) {
    if (symbol.kind !== "local" && symbol.kind !== "parameter") {
      continue;
    }

    if (
      symbol.scopeStart !== undefined &&
      symbol.scopeEnd !== undefined &&
      (offset < symbol.scopeStart || offset > symbol.scopeEnd)
    ) {
      continue;
    }

    push(symbolCompletion(symbol), 0);
  }

  // Members of the type the caret is in, which are writable unqualified.
  for (const symbol of model.symbols) {
    if (!isMemberKind(symbol.kind)) {
      continue;
    }

    if (enclosing && !equalsIgnoreCase(symbol.container ?? "", enclosing.name)) {
      continue;
    }

    push(symbolCompletion(symbol), 1);
  }

  // Types declared in this file, then everywhere else in the workspace.
  for (const symbol of model.symbols) {
    if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum") {
      push(symbolCompletion(symbol), 2);
    }
  }

  for (const entry of workspaceIndex()?.allTypes() ?? []) {
    if (entry.uri === document.uri) {
      continue;
    }

    push(
      {
        label: entry.symbol.name,
        kind: entry.symbol.kind === "interface"
          ? CompletionItemKind.Interface
          : entry.symbol.kind === "enum"
            ? CompletionItemKind.Enum
            : CompletionItemKind.Class,
        detail: `ApexX ${entry.symbol.kind} ${entry.symbol.name}`,
        documentation: path.basename(entry.filePath),
      },
      3,
    );
  }

  // The Apex runtime's own types and namespaces.
  for (const globalType of apexGlobalTypes) {
    push(
      {
        label: globalType.name,
        kind: globalType.namespace
          ? CompletionItemKind.Module
          : CompletionItemKind.Class,
        detail: globalType.detail,
      },
      4,
    );
  }

  // Every namespace the platform declares. There are only tens of them, so they are
  // always offered; their contents are not.
  for (const namespace of standardLibraryNamespaces()) {
    push(
      {
        label: namespace,
        kind: CompletionItemKind.Module,
        detail: `Apex ${namespace} namespace`,
      },
      5,
    );
  }

  // SObjects the workspace schema describes, which are types too.
  for (const name of knownSObjectNames(workspaceRoot)) {
    push(
      {
        label: name,
        kind: CompletionItemKind.Struct,
        detail: `Salesforce SObject ${name}`,
      },
      5,
    );
  }

  // The rest of the standard library -- thousands of types -- only once there is a
  // prefix to narrow it with, and capped, so a keystroke never carries the whole
  // library across the wire. The result is reported incomplete so the editor asks
  // again as the prefix grows.
  const typed = /[A-Za-z_][A-Za-z0-9_]*$/.exec(document.getText().slice(0, offset))?.[0];
  let narrowed = false;

  if (typed && typed.length >= 2) {
    const wanted = typed.toLowerCase();
    let offered = 0;

    for (const type of standardLibraryTypes()) {
      if (offered >= STANDARD_TYPE_LIMIT) {
        narrowed = true;
        break;
      }

      if (!type.name.toLowerCase().startsWith(wanted)) {
        continue;
      }

      offered += 1;
      push(
        {
          label: type.name,
          kind: CompletionItemKind.Class,
          detail: `Apex ${type.namespace}.${type.name}`,
        },
        6,
      );
    }
  }

  for (const keyword of apexKeywordCompletions()) {
    push(keyword, 7);
  }

  // ApexX's own pipeline helpers, last: they read as members rather than
  // identifiers, but this is where they are discovered.
  for (const helper of pipelineHelperCompletions()) {
    push(helper, 8);
  }

  // Incomplete whenever the library was consulted at all: a longer prefix reaches
  // types this answer left out, whether or not the cap was hit this time.
  return complete(items, narrowed || Boolean(typed && typed.length >= 2));
}

/** Enough to fill the widget several times over, small enough to stay cheap. */
const STANDARD_TYPE_LIMIT = 250;

/** The sObject a query's result is being assigned to, when the declaration says so. */
function assignedSObject(source: string, queryStart: number): string | undefined {
  const before = source.slice(Math.max(0, queryStart - 200), queryStart);
  const match =
    /(?:List|Set)\s*<\s*([A-Za-z][A-Za-z0-9_]*(?:__c)?)\s*>\s*[A-Za-z][A-Za-z0-9_]*\s*=\s*$/.exec(
      before,
    ) ??
    /\b([A-Za-z][A-Za-z0-9_]*(?:__c)?)\s+[A-Za-z][A-Za-z0-9_]*\s*=\s*$/.exec(before);

  const typeName = match?.[1];
  return typeName && getSObjectFields(typeName, workspaceRoot)?.length
    ? typeName
    : undefined;
}

/** `Messaging.SingleEmailMessage` and a bare `SingleEmailMessage` name the same type. */
function bareTypeName(typeName: string): string {
  return (normalizeType(typeName).split(".").at(-1) ?? typeName).replace(
    /\s*<.*$/,
    "",
  );
}

/** Locals, parameters and fields visible at the caret, as completion items. */
function valuesInScope(document: TextDocument, offset: number): CompletionItem[] {
  const model = modelFor(document);
  const enclosing = enclosingType(model, offset);

  return model.symbols
    .filter(symbol => {
      if (symbol.kind === "local" || symbol.kind === "parameter") {
        return (
          symbol.scopeStart === undefined ||
          symbol.scopeEnd === undefined ||
          (offset >= symbol.scopeStart && offset <= symbol.scopeEnd)
        );
      }

      return (
        (symbol.kind === "field" || symbol.kind === "property") &&
        (!enclosing || equalsIgnoreCase(symbol.container ?? "", enclosing.name))
      );
    })
    .map(symbolCompletion);
}

/** Type names only: what `implements` and `extends` accept. */
function typeNameCompletions(
  document: TextDocument,
  interfacesOnly: boolean,
): CompletionItem[] {
  const model = modelFor(document);
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  const push = (item: CompletionItem, rank: number): void => {
    if (seen.has(item.label)) {
      return;
    }

    seen.add(item.label);
    items.push({ ...item, sortText: `${rank}_${item.label}` });
  };

  const wanted = (kind: ApexSymbolKind): boolean =>
    interfacesOnly
      ? kind === "interface"
      : kind === "class" || kind === "interface";

  for (const symbol of model.symbols) {
    if (wanted(symbol.kind)) {
      push(symbolCompletion(symbol), 0);
    }
  }

  for (const entry of workspaceIndex()?.allTypes() ?? []) {
    if (entry.uri !== document.uri && wanted(entry.symbol.kind)) {
      push(
        {
          label: entry.symbol.name,
          kind:
            entry.symbol.kind === "interface"
              ? CompletionItemKind.Interface
              : CompletionItemKind.Class,
          detail: `ApexX ${entry.symbol.kind} ${entry.symbol.name}`,
          documentation: path.basename(entry.filePath),
        },
        1,
      );
    }
  }

  // The platform interfaces a class is most often declared against.
  for (const name of [
    "Queueable",
    "Schedulable",
    "Comparable",
    "Comparator",
    "Iterable",
    "Iterator",
    "Database.Batchable<SObject>",
    "Database.AllowsCallouts",
    "Database.Stateful",
    "Messaging.InboundEmailHandler",
    "System.Callable",
    "HttpCalloutMock",
  ]) {
    push(
      {
        label: name,
        kind: CompletionItemKind.Interface,
        detail: `Apex interface ${name}`,
      },
      2,
    );
  }

  return items;
}

/**
 * Field names for `new Account(` -- an sObject constructor takes named fields, so the
 * schema answers here the same way it answers a member access.
 */
function findConstructedSObject(
  source: string,
  offset: number,
): CompletionItem[] | undefined {
  const prefix = source.slice(0, offset);
  const open = prefix.lastIndexOf("(");

  if (open < 0 || /[;{}]/.test(prefix.slice(open))) {
    return undefined;
  }

  const typeName = /\bnew\s+([A-Za-z][A-Za-z0-9_]*(?:__c)?)\s*$/.exec(
    prefix.slice(0, open),
  )?.[1];

  if (!typeName) {
    return undefined;
  }

  // Only when a field is being named, not while an argument value is being written.
  if (!/(?:\(|,)\s*[A-Za-z0-9_]*$/.test(prefix.slice(open))) {
    return undefined;
  }

  const fields = getSObjectFields(typeName, workspaceRoot);

  if (!fields || fields.length === 0) {
    return undefined;
  }

  return memberCompletions(
    fields.map(fieldInfo => ({
      label: fieldInfo.name,
      kind: CompletionItemKind.Field,
      detail: `${typeName}.${fieldInfo.name}: ${apexTypeForField(fieldInfo)}`,
      insertText: `${fieldInfo.name} = $\{1:value}`,
      insertTextFormat: InsertTextFormat.Snippet,
    })),
  );
}

function isMemberKind(kind: ApexSymbolKind): boolean {
  return (
    kind === "field" ||
    kind === "property" ||
    kind === "method" ||
    kind === "constructor"
  );
}

/** The innermost class, interface or enum the offset sits in. */
function enclosingType(
  model: DocumentModel,
  offset: number,
): ApexSymbol | undefined {
  let best: ApexSymbol | undefined;

  for (const symbol of model.symbols) {
    if (symbol.kind !== "class" && symbol.kind !== "interface" && symbol.kind !== "enum") {
      continue;
    }

    if (offset < symbol.declStart || offset > symbol.declEnd) {
      continue;
    }

    if (!best || symbol.declStart > best.declStart) {
      best = symbol;
    }
  }

  return best;
}

function enclosingTypeMembers(
  document: TextDocument,
  offset: number,
): CompletionItem[] {
  const model = modelFor(document);
  const enclosing = enclosingType(model, offset);

  return model.symbols
    .filter(
      symbol =>
        isMemberKind(symbol.kind) &&
        symbol.kind !== "constructor" &&
        (!enclosing || equalsIgnoreCase(symbol.container ?? "", enclosing.name)),
    )
    .map(symbolCompletion);
}

/** Members of a type declared in this workspace, from the index. */
function workspaceTypeMembers(
  typeName: string,
  onlyStatic: boolean,
): CompletionItem[] | undefined {
  const index = workspaceIndex();

  if (!index || index.findTypes(typeName).length === 0) {
    return undefined;
  }

  const members = index
    .typeMembers(typeName)
    .filter(entry => {
      if (!isMemberKind(entry.symbol.kind)) {
        return entry.symbol.kind === "enum" || entry.symbol.kind === "class";
      }

      const isStatic = /\bstatic\b/i.test(entry.symbol.modifiers ?? "");
      return onlyStatic ? isStatic : !isStatic;
    })
    .map(entry => symbolCompletion(entry.symbol));

  return members;
}

function symbolCompletion(symbol: ApexSymbol): CompletionItem {
  const detail = describeSymbol(symbol).split("\n")[0].trim();

  if (symbol.kind === "method" || symbol.kind === "constructor") {
    const parameters = symbol.parameters ?? [];
    const insertText =
      parameters.length === 0
        ? `${symbol.name}()`
        : `${symbol.name}(${parameters
            .map((parameter, index) => `\${${index + 1}:${parameter.name}}`)
            .join(", ")})`;

    return {
      label: symbol.name,
      kind: CompletionItemKind.Method,
      detail,
      insertText,
      insertTextFormat: InsertTextFormat.Snippet,
    };
  }

  return {
    label: symbol.name,
    kind: COMPLETION_KINDS[symbol.kind],
    detail,
  };
}

const COMPLETION_KINDS: Record<ApexSymbolKind, CompletionItemKind> = {
  class: CompletionItemKind.Class,
  interface: CompletionItemKind.Interface,
  enum: CompletionItemKind.Enum,
  method: CompletionItemKind.Method,
  constructor: CompletionItemKind.Constructor,
  field: CompletionItemKind.Field,
  property: CompletionItemKind.Property,
  parameter: CompletionItemKind.Variable,
  local: CompletionItemKind.Variable,
};

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function wordAtPosition(
  document: TextDocument,
  position: Position,
): string | undefined {
  const source = document.getText();
  const offset = document.offsetAt(position);
  const before = source.slice(0, offset).match(/[A-Za-z][A-Za-z0-9_]*$/)?.[0] ?? "";
  const after = source.slice(offset).match(/^[A-Za-z0-9_]*/)?.[0] ?? "";
  const word = `${before}${after}`;
  return word.length > 0 ? word : undefined;
}

/**
 * Parsing is memoised per document version: hover, highlight and signature help
 * all fire on the same keystroke, and each would otherwise reparse the file.
 */
interface ApexDiagnosticsNotification {
  uri: string;
  diagnostics: {
    range: LspRange;
    message: string;
    severity?: number;
    code?: string | number;
    source?: string;
  }[];
}

/** Apex semantic diagnostics, keyed by authored URI. */
const apexDiagnostics = new Map<string, Diagnostic[]>();
/** ApexX compiler diagnostics, kept so both sources publish together. */
const compilerDiagnostics = new Map<string, Diagnostic[]>();

/**
 * Receives diagnostics the Apex language server publishes about generated code and
 * republishes them against the authored file.
 *
 * A diagnostic whose range does not map back is dropped: it describes generated
 * scaffolding, so reporting it would blame the user for code ApexX wrote.
 */
function receiveApexDiagnostics(notification: ApexDiagnosticsNotification): void {
  const activeBridge = bridge;

  if (!apexDiagnosticsEnabled || !activeBridge || !notification?.uri) {
    return;
  }

  const bridged = activeBridge.authoredFor(notification.uri);

  if (!bridged) {
    return;
  }

  const translated: Diagnostic[] = [];

  for (const entry of notification.diagnostics ?? []) {
    const located = toAuthoredLocation({ uri: notification.uri, range: entry.range });

    if (!located || located.uri !== bridged.authoredUri || isGeneratedArtifact(entry.message)) {
      continue;
    }

    translated.push({
      range: located.range,
      message: translateGeneratedNames(entry.message, activeBridge.documents()),
      severity: (entry.severity as DiagnosticSeverity) ?? DiagnosticSeverity.Error,
      source: "apex",
      code: entry.code,
    });
  }

  const previous = apexDiagnostics.get(bridged.authoredUri) ?? [];
  apexDiagnostics.set(bridged.authoredUri, translated);

  if (previous.length > 0 || translated.length > 0) {
    republishDiagnostics(bridged.authoredUri);
  }
}

function republishDiagnostics(uri: string): void {
  connection.sendDiagnostics({
    uri,
    diagnostics: [
      ...(compilerDiagnostics.get(uri) ?? []),
      ...(apexDiagnostics.get(uri) ?? []),
    ],
  });
}

/**
 * Rewrites a workspace edit reported against generated Apex so it applies to the
 * authored `.clsx` files. Returns undefined when any edit lands in generated-only
 * code, because applying part of a rename would corrupt the source.
 */
function mapWorkspaceEdit(
  edit: { changes?: Record<string, { range: LspRange; newText: string }[]> } | undefined,
  newName: string | undefined,
): WorkspaceEdit | undefined {
  if (!edit?.changes) {
    return undefined;
  }

  const changes: Record<string, { range: Range; newText: string }[]> = {};

  for (const [uri, edits] of Object.entries(edit.changes)) {
    for (const entry of edits) {
      const located = toAuthoredLocation({ uri, range: entry.range });

      if (!located) {
        return undefined;
      }

      changes[located.uri] ??= [];
      changes[located.uri].push({
        range: located.range,
        newText: newName ?? entry.newText,
      });
    }
  }

  return Object.keys(changes).length > 0 ? { changes } : undefined;
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function asArray<T>(value: T[] | T | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

/** Hover contents arrive as markup, a string, or an array of either. */
function hoverText(contents: unknown): string | undefined {
  if (!contents) {
    return undefined;
  }

  if (typeof contents === "string") {
    return contents;
  }

  if (Array.isArray(contents)) {
    return contents.map(entry => hoverText(entry) ?? "").filter(Boolean).join("\n\n");
  }

  const value = (contents as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

function dedupeLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();

  return locations.filter(location => {
    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

const FIRST_OPEN_SETTLE_MS = 400;

let jorje: JorjeClient | undefined;
let bridge: ApexBridge | undefined;

/**
 * The Apex language server and the ApexX bridge, started on first use. Startup is
 * lazy and failure is silent by design: every handler falls back to the local
 * symbol model, so the editor stays responsive while the project is indexed and
 * keeps working when Java or the Apex extension is absent.
 */
function apexBackend(): { jorje: JorjeClient; bridge: ApexBridge } | undefined {
  if (!workspaceRoot || !apexServerEnabled) {
    return undefined;
  }

  bridge ??= new ApexBridge({ workspaceRoot });
  jorje ??= new JorjeClient({
    workspaceRoot,
    javaHome: apexJavaHome,
    jarPath: process.env.APEXX_APEX_JAR,
    allowSharedIndex: /^(1|true|yes)$/i.test(
      process.env.APEXX_ALLOW_SHARED_APEX_INDEX ?? "",
    ),
    log: message => connection.console.log(`[apexx] ${message}`),
    onNotification: (method, params) => {
      if (method === "textDocument/publishDiagnostics") {
        receiveApexDiagnostics(params as ApexDiagnosticsNotification);
      }
    },
  });

  // Warm the server up without blocking this request.
  void jorje.ready();

  return { jorje, bridge };
}

/** Bridges every `.clsx` in the workspace so cross-file answers can be translated. */
function refreshBridge(activeBridge: ApexBridge): void {
  const seen = new Set<string>();

  for (const document of documents.all()) {
    if (document.uri.toLowerCase().endsWith(".clsx")) {
      seen.add(document.uri);
      activeBridge.bridge(document.uri, document.getText(), `v${document.version}`);
    }
  }

  for (const entry of workspaceIndex()?.entries() ?? []) {
    if (seen.has(entry.uri)) {
      continue;
    }

    // Keyed on mtime so an unchanged file is neither re-read nor re-transpiled.
    const stamp = `disk:${entry.mtimeMs}`;

    if (bridgedDiskStamps.get(entry.uri) === stamp) {
      continue;
    }

    const source = activeBridge.readAuthored(entry.filePath);

    if (source !== undefined) {
      activeBridge.bridge(entry.uri, source, stamp);
      bridgedDiskStamps.set(entry.uri, stamp);
    }
  }
}

const bridgedDiskStamps = new Map<string, string>();

/**
 * Asks the Apex language server a positional question about the generated code
 * equivalent of an authored position.
 */
async function askApex<T>(
  method: string,
  document: TextDocument,
  position: Position,
  extra: Record<string, unknown> = {},
): Promise<{ result: T; bridged: BridgedDocument } | undefined> {
  const backend = apexBackend();

  // The bridge projects a document onto a `.cls` named after its class, which a
  // script has none of. Asking about one would mean handing the Apex server a
  // file of loose statements under a made-up class name.
  if (!backend?.jorje.isReady || apexXUnitMode(document.uri) !== "class") {
    return undefined;
  }

  refreshBridge(backend.bridge);
  const bridged = backend.bridge.bridge(
    document.uri,
    document.getText(),
    `v${document.version}`,
  );

  if (!bridged) {
    return undefined;
  }

  const generatedOffset = backend.bridge.toGenerated(
    bridged,
    document.offsetAt(position),
  );

  if (generatedOffset === undefined) {
    return undefined;
  }

  // The server needs a moment to parse a document it has just been given; asking
  // in the same tick makes it answer with an internal error.
  const firstOpen = !backend.jorje.isOpen(bridged.generatedUri);
  backend.jorje.syncDocument(bridged.generatedUri, bridged.output);

  if (firstOpen) {
    await new Promise(resolve => setTimeout(resolve, FIRST_OPEN_SETTLE_MS));
  }

  const result = await backend.jorje.send<T>(method, {
    textDocument: { uri: bridged.generatedUri },
    position: offsetPosition(bridged.output, generatedOffset),
    ...extra,
  });

  // An empty answer may mean the document never landed; re-open it so the next
  // request gets a fresh chance rather than failing for the rest of the session.
  if (result === undefined || result === null) {
    backend.jorje.reopen(bridged.generatedUri);
  }

  if (process.env.APEXX_DEBUG_APEX) {
    const size = Array.isArray(result)
      ? result.length
      : result === undefined || result === null
        ? "none"
        : "object";
    connection.console.log(
      `[apexx-debug] ${method} generatedUri=${bridged.generatedUri.split("/").pop()} offset=${generatedOffset} -> ${size}`,
    );
  }

  return result === undefined || result === null ? undefined : { result, bridged };
}

/**
 * Rewrites a location reported in generated Apex as a location in the authored
 * `.clsx`. Locations inside generated-only scaffolding are dropped rather than
 * pointed at code the user never wrote.
 */
function toAuthoredLocation(location: {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}): Location | undefined {
  const activeBridge = bridge;

  if (!activeBridge) {
    return undefined;
  }

  const bridged = activeBridge.authoredFor(location.uri);

  if (!bridged) {
    // A location in a file ApexX did not generate, such as hand-written Apex.
    return Location.create(location.uri, location.range);
  }

  const startOffset = positionOffset(bridged.output, location.range.start);
  const endOffset = positionOffset(bridged.output, location.range.end);
  const authoredStart = activeBridge.toAuthored(bridged, startOffset);
  const authoredEnd = activeBridge.toAuthored(bridged, endOffset);

  if (authoredStart === undefined) {
    return undefined;
  }

  return Location.create(
    bridged.authoredUri,
    Range.create(
      offsetPosition(bridged.source, authoredStart),
      offsetPosition(bridged.source, authoredEnd ?? authoredStart),
    ),
  );
}

function positionOffset(
  source: string,
  position: { line: number; character: number },
): number {
  const lines = source.split("\n");
  let offset = 0;

  for (let line = 0; line < position.line && line < lines.length; line += 1) {
    offset += (lines[line]?.length ?? 0) + 1;
  }

  return offset + position.character;
}

let index: WorkspaceIndex | undefined;

/** The workspace index, refreshed against open documents and disk on each use. */
function workspaceIndex(): WorkspaceIndex | undefined {
  if (!workspaceRoot) {
    return undefined;
  }

  index ??= new WorkspaceIndex(workspaceRoot);

  const open = new Map<string, { text: string; version: number }>();

  for (const document of documents.all()) {
    if (document.uri.toLowerCase().endsWith(".clsx")) {
      open.set(document.uri, {
        text: document.getText(),
        version: document.version,
      });
    }
  }

  index.refresh(open);
  return index;
}

function locationsFor(entries: IndexedSymbol[]): Location[] {
  return entries.map(entry =>
    Location.create(
      entry.uri,
      offsetRange(entry.model.source, entry.symbol.nameStart, entry.symbol.nameEnd),
    ),
  );
}

/** Converts offsets to a range without needing an open TextDocument. */
function offsetRange(source: string, start: number, end: number): Range {
  return Range.create(offsetPosition(source, start), offsetPosition(source, end));
}

function offsetPosition(source: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, clamped);
  const line = before.split("\n").length - 1;
  const character = clamped - (before.lastIndexOf("\n") + 1);
  return Position.create(line, character);
}

const modelCache = new Map<string, { version: number; model: DocumentModel }>();

function modelFor(document: TextDocument): DocumentModel {
  const cached = modelCache.get(document.uri);

  if (cached?.version === document.version) {
    return cached.model;
  }

  const model = buildDocumentModel(document.getText(), {
    anonymous: apexXUnitMode(document.uri) === "anonymous",
  });
  modelCache.set(document.uri, { version: document.version, model });
  return model;
}

function apexxDocument(uri: string): TextDocument | undefined {
  const document = documents.get(uri);
  return document && apexXUnitMode(document.uri) !== undefined
    ? document
    : undefined;
}

function rangeOf(document: TextDocument, start: number, end: number): Range {
  return Range.create(document.positionAt(start), document.positionAt(end));
}

interface CursorSymbol {
  document: TextDocument;
  model: DocumentModel;
  symbol: ApexSymbol;
  identifier: { name: string; start: number; end: number };
  name: string;
}

function symbolUnderCursor(uri: string, position: Position): CursorSymbol | undefined {
  const document = apexxDocument(uri);

  if (!document) {
    return undefined;
  }

  const source = document.getText();
  const offset = document.offsetAt(position);
  const identifier = identifierAt(source, offset);

  if (!identifier) {
    return undefined;
  }

  const model = modelFor(document);
  const symbol = resolveSymbol(model, identifier.name, offset);

  return symbol
    ? { document, model, symbol, identifier, name: identifier.name }
    : undefined;
}

/**
 * Occurrences of a local or parameter are confined to its scope, so renaming a
 * lambda parameter cannot rewrite a same-named parameter of another method.
 */
function occurrenceRanges(
  document: TextDocument,
  name: string,
  symbol?: ApexSymbol,
): Range[] {
  const source = document.getText();
  const scoped =
    symbol &&
    (symbol.kind === "local" || symbol.kind === "parameter") &&
    symbol.scopeStart !== undefined &&
    symbol.scopeEnd !== undefined
      ? { start: symbol.scopeStart, end: symbol.scopeEnd }
      : undefined;

  return findOccurrences(source, name)
    .filter(offset => !scoped || (offset >= scoped.start && offset <= scoped.end))
    .map(offset => rangeOf(document, offset, offset + name.length));
}

const OUTLINE_KINDS: Record<ApexSymbolKind, SymbolKind> = {
  class: SymbolKind.Class,
  interface: SymbolKind.Interface,
  enum: SymbolKind.Enum,
  method: SymbolKind.Method,
  constructor: SymbolKind.Constructor,
  field: SymbolKind.Field,
  property: SymbolKind.Property,
  parameter: SymbolKind.Variable,
  local: SymbolKind.Variable,
};

/** Types become outline containers; their members nest underneath. Locals and
 * parameters are deliberately left out, so the outline stays readable. */
function outline(document: TextDocument, model: DocumentModel): DocumentSymbol[] {
  const types = model.symbols.filter(
    symbol =>
      symbol.kind === "class" ||
      symbol.kind === "interface" ||
      symbol.kind === "enum",
  );
  const members = model.symbols.filter(
    symbol =>
      symbol.kind === "method" ||
      symbol.kind === "constructor" ||
      symbol.kind === "field" ||
      symbol.kind === "property",
  );

  const toSymbol = (symbol: ApexSymbol, children?: DocumentSymbol[]): DocumentSymbol => ({
    name: symbol.name,
    detail: describeSymbol(symbol),
    kind: OUTLINE_KINDS[symbol.kind],
    range: rangeOf(document, symbol.declStart, symbol.declEnd),
    selectionRange: rangeOf(document, symbol.nameStart, symbol.nameEnd),
    children,
  });

  const roots = types.filter(type => !type.container);
  const owned = new Set<ApexSymbol>();

  const build = (type: ApexSymbol): DocumentSymbol => {
    const nested = types.filter(
      candidate => candidate.container === type.name && candidate !== type,
    );
    const children = [
      ...members
        .filter(member => member.container === type.name)
        .map(member => {
          owned.add(member);
          return toSymbol(member);
        }),
      ...nested.map(build),
    ].sort((left, right) => left.range.start.line - right.range.start.line);

    return toSymbol(type, children);
  };

  const tree = roots.map(build);
  const orphans = members.filter(member => !owned.has(member)).map(member => toSymbol(member));

  return [...tree, ...orphans];
}

/**
 * A lambda parameter's type is not written down anywhere, so it is inferred from
 * the receiver list -- the same inference that drives field completion inside a
 * lambda. Anything already carrying a concrete type is left alone.
 */
function refineType(
  symbol: ApexSymbol,
  source: string,
  offset: number,
): ApexSymbol {
  if (symbol.kind !== "parameter" || (symbol.type && symbol.type !== "Object")) {
    return symbol;
  }

  // The inference scans backwards for `name =>`, which is not yet in the prefix
  // when the cursor sits on the parameter itself, so look from the lambda's end.
  const from = Math.max(offset, symbol.scopeEnd ?? offset);
  const inferred = inferReceiverType(source, from, symbol.name);

  return inferred ? { ...symbol, type: normalizeType(inferred) } : symbol;
}

/**
 * Members are shown qualified by their type, matching how Apex tooling reports
 * them. Locals and parameters stay bare, because a qualifier would be wrong.
 */
function declarationText(symbol: ApexSymbol): string {
  const declaration = describeSymbol(symbol);

  if (
    !symbol.container ||
    symbol.kind === "local" ||
    symbol.kind === "parameter" ||
    symbol.kind === "class" ||
    symbol.kind === "interface" ||
    symbol.kind === "enum"
  ) {
    return declaration;
  }

  return declaration.replace(
    new RegExp(`\\b${symbol.name}\\b`),
    `${symbol.container}.${symbol.name}`,
  );
}

/** Documents an sObject field when the identifier resolves to one, e.g. `a.AnnualRevenue`. */
/**
 * Hover for a member of a standard type, resolved through its receiver.
 *
 * The receiver is what makes this answerable: `abs` alone means nothing, `Math.abs`
 * has one description. A member with no recognised receiver is left unexplained rather
 * than matched by name across the whole library.
 */
function standardLibraryHover(
  source: string,
  offset: number,
  name: string,
): string | undefined {
  const start = source.slice(0, offset).search(/[A-Za-z_][A-Za-z0-9_]*$/);
  const receiver = start > 0 ? findReceiverBeforeDot(source.slice(0, start)) : undefined;

  if (!receiver) {
    return undefined;
  }

  const receiverType = inferReceiverType(source, start, receiver);
  const lookup = receiverType ? bareTypeName(receiverType) : receiver;
  const wantStatic = !receiverType;
  const members =
    (wantStatic
      ? standardReceiverMembers(lookup)
      : standardLibraryMembers(lookup, false)) ?? [];
  const member = members.find(item => item.label === name);

  if (!member?.detail) {
    return undefined;
  }

  const documentation =
    typeof member.documentation === "string" ? member.documentation : undefined;

  return [`\`\`\`apex\n${member.detail}\n\`\`\``, documentation]
    .filter(Boolean)
    .join("\n\n");
}

function sObjectFieldHover(
  source: string,
  offset: number,
  name: string,
): string | undefined {
  const before = source.slice(0, offset).match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*[A-Za-z0-9_]*$/);

  if (!before?.[1]) {
    return undefined;
  }

  const receiverType = inferReceiverType(source, offset, before[1]);

  if (!receiverType) {
    return undefined;
  }

  const field = getSObjectFields(normalizeType(receiverType), workspaceRoot)?.find(
    candidate => candidate.name.toLowerCase() === name.toLowerCase(),
  );

  return field
    ? `\`\`\`apex\n${field.type} ${normalizeType(receiverType)}.${field.name}\n\`\`\`${field.label ? `\n\n${field.label}` : ""}`
    : undefined;
}

/**
 * Walks back from the cursor to the call it sits inside, skipping balanced
 * parentheses, and counts top-level commas to find the active parameter.
 */
function enclosingCall(
  source: string,
  offset: number,
): { name: string; receiver?: string; constructed?: boolean; activeParameter: number } | undefined {
  let depth = 0;
  let commas = 0;

  for (let index = offset - 1; index >= 0; index -= 1) {
    const character = source[index];

    if (character === ")") {
      depth += 1;
      continue;
    }

    if (character === "(") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }

      const before = source.slice(0, index);
      const name = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before)?.[1];

      if (!name) {
        return undefined;
      }

      // The receiver decides which type's methods to look at, and `new` decides that
      // the name is a type rather than a method.
      const head = before.slice(0, before.length - name.length);
      return {
        name,
        receiver: /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(head)?.[1],
        constructed: /\bnew\s*$/.test(head),
        activeParameter: commas,
      };
    }

    if (character === "," && depth === 0) {
      commas += 1;
      continue;
    }

    if (character === ";" || character === "}" || character === "{") {
      return undefined;
    }
  }

  return undefined;
}

function hoverDocumentation(word: string): string | undefined {
  const documentation: Record<string, string> = {
    Func: [
      "### `Func<...>`",
      "A strongly typed function value. All type arguments except the last are parameters; the final type is the return value.",
      "Expression and multi-statement block lambdas are supported. Structural signatures receive deterministic interfaces nested in the shared `ApexXFuncs` registry, so matching `Func` types cross independently compiled class boundaries without producing a file per signature.",
      "ApexX lowers it to a typed Apex interface and implementation class—no reflection or `Object` dispatch.",
    ].join("\n\n"),
    filter: helperHover("filter", "`List<T>`", "`List<T>`", "keeps items for which the predicate is true"),
    map: helperHover("map", "`List<T>`", "`List<R>`", "projects each item to a new inferred type"),
    flatMap: helperHover("flatMap", "`List<T>`", "`List<R>`", "projects each item to a list and flattens the results"),
    find: helperHover("find", "`List<T>`", "`T`", "returns the first matching item or `null`"),
    any: helperHover("any", "`List<T>`", "`Boolean`", "stops when one item matches"),
    all: helperHover("all", "`List<T>`", "`Boolean`", "stops when one item fails the predicate"),
    count: helperHover("count", "`List<T>`", "`Integer`", "counts items matching the predicate"),
    UserFriendlyError: [
      "### Custom ApexX decorator",
      "A user-authored class implementing `ApexX.Decorator`. The compiler routes the annotated static method through `handle(ctx, next)` and passes annotation arguments through `ctx.config`.",
    ].join("\n\n"),
  };

  return documentation[word];
}

function helperHover(
  name: string,
  receiver: string,
  result: string,
  behavior: string,
): string {
  return [
    `### \`${name}\``,
    `${receiver} → ${result}: ${behavior}.`,
    "This is a compile-time ApexX helper that lowers to a typed Apex loop.",
  ].join("\n\n");
}

/**
 * The receiver of the member access the caret is in, if it is in one.
 *
 * The member name may already be partly typed -- `System.deb` is still a member access
 * on `System`, and is exactly when the offer matters most.
 */
function findReceiverBeforeDot(prefix: string): string | undefined {
  return prefix.match(/([A-Za-z][A-Za-z0-9_]*)\s*\.\s*[A-Za-z0-9_]*$/)?.[1];
}

function inferReceiverType(
  source: string,
  offset: number,
  receiver: string,
): string | undefined {
  const lambdaType = inferLambdaParameterType(source, offset, receiver);
  if (lambdaType) {
    return lambdaType;
  }

  const funcLambdaType = inferFuncLambdaParameterType(source, offset, receiver);
  if (funcLambdaType) {
    return funcLambdaType;
  }

  return inferDeclaredVariableType(source.slice(0, offset), receiver);
}

function inferLambdaParameterType(
  source: string,
  offset: number,
  receiver: string,
): string | undefined {
  const prefix = source.slice(0, offset);
  const lambdaPattern =
    /\.(filter|map|flatMap|any|all|count|find)\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*=>/g;
  let match: RegExpExecArray | null;
  let inferredType: string | undefined;

  while ((match = lambdaPattern.exec(prefix)) !== null) {
    const parameterName = match[2];

    if (parameterName === receiver) {
      inferredType = inferListMethodLambdaInputType(source, prefix, match.index);
    }
  }

  return inferredType;
}

function inferListMethodLambdaInputType(
  source: string,
  prefix: string,
  methodStartOffset: number,
): string | undefined {
  const beforeMethod = prefix.slice(0, methodStartOffset);
  const statementStart = Math.max(
    beforeMethod.lastIndexOf(";"),
    beforeMethod.lastIndexOf("{"),
    beforeMethod.lastIndexOf("}"),
  );
  const chainStart = statementStart + 1;
  const statementPrefix = prefix.slice(chainStart);
  const baseMatch =
    /([A-Za-z][A-Za-z0-9_]*)\s*\.(?:filter|map|flatMap|any|all|count|find)\s*\(/.exec(statementPrefix);

  if (!baseMatch) {
    return undefined;
  }

  const listVariables = collectListVariables(source);
  const baseType = listVariables.get(baseMatch[1])?.elementType;
  if (!baseType) {
    return undefined;
  }

  const methodOffsetInStatement = methodStartOffset - chainStart;
  const lambdaPattern =
    /\.(filter|map|flatMap|any|all|count|find)\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*=>/g;
  let match: RegExpExecArray | null;
  let currentType = baseType;
  const typeProvider = createApexTypeProvider({ workspaceRoot });

  while ((match = lambdaPattern.exec(statementPrefix)) !== null) {
    const methodName = match[1];
    const parameterName = match[2];

    if (match.index === methodOffsetInStatement) {
      return currentType;
    }

    if (match.index > methodOffsetInStatement) {
      break;
    }

    if (methodName === "map" || methodName === "flatMap") {
      const bodyStart = match.index + match[0].length;
      const bodyEnd = findLambdaBodyEnd(statementPrefix, bodyStart);

      if (bodyEnd === undefined || bodyEnd > methodOffsetInStatement) {
        return undefined;
      }

      const variables = collectDeclaredVariables(source);
      variables.set(parameterName.toLowerCase(), currentType);
      const bodyType = inferExpressionType(
        statementPrefix.slice(bodyStart, bodyEnd),
        { variables, typeProvider },
      );

      if (!bodyType) {
        return undefined;
      }

      if (methodName === "flatMap") {
        const elementType = extractListElementType(bodyType);
        if (!elementType) {
          return undefined;
        }
        currentType = elementType;
      } else {
        currentType = bodyType;
      }
    }
  }

  return undefined;
}

function findLambdaBodyEnd(
  source: string,
  startOffset: number,
): number | undefined {
  let cursor = startOffset;
  let depth = 0;
  let inString = false;

  while (cursor < source.length) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (inString) {
      if (current === "\\" && next) {
        cursor += 2;
        continue;
      }

      if (current === "'") {
        inString = false;
      }

      cursor += 1;
      continue;
    }

    if (current === "'") {
      inString = true;
      cursor += 1;
      continue;
    }

    if (current === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }

    if (current === ")") {
      if (depth === 0) {
        return cursor;
      }

      depth -= 1;
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  return undefined;
}

function inferFuncLambdaParameterType(
  source: string,
  offset: number,
  receiver: string,
): string | undefined {
  const prefix = source.slice(0, offset);
  const declarationPattern =
    /Func\s*<\s*([^>\r\n]+?)\s*>\s+[A-Za-z][A-Za-z0-9_]*\s*=\s*\(([^)\r\n]*)\)\s*=>/g;
  let declarationMatch: RegExpExecArray | null;
  let nearestDeclaration: RegExpExecArray | undefined;

  while ((declarationMatch = declarationPattern.exec(prefix)) !== null) {
    nearestDeclaration = declarationMatch;
  }

  if (nearestDeclaration) {
    const typeArguments = splitCommaList(nearestDeclaration[1]);
    const parameterNames = splitCommaList(nearestDeclaration[2]);
    const parameterIndex = parameterNames.findIndex(name => name === receiver);

    if (parameterIndex >= 0 && parameterIndex < typeArguments.length - 1) {
      return toApexType(typeArguments[parameterIndex]);
    }
  }

  const statementStart = Math.max(
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("{"),
    prefix.lastIndexOf("}"),
  );
  const statementPrefix = prefix.slice(statementStart + 1);
  const match =
    /Func\s*<\s*([^>\r\n]+?)\s*>\s+[A-Za-z][A-Za-z0-9_]*\s*=\s*\(([^)\r\n]*)\)\s*=>/.exec(
      statementPrefix,
    );

  if (match) {
    const typeArguments = splitCommaList(match[1]);
    const parameterNames = splitCommaList(match[2]);
    const parameterIndex = parameterNames.findIndex(name => name === receiver);

    if (parameterIndex < 0 || parameterIndex >= typeArguments.length - 1) {
      return undefined;
    }

    return toApexType(typeArguments[parameterIndex]);
  }

  const reassignmentMatch =
    /([A-Za-z][A-Za-z0-9_]*)\s*=\s*\(([^)\r\n]*)\)\s*=>/.exec(
      statementPrefix,
    );

  if (!reassignmentMatch) {
    return undefined;
  }

  const funcVariableName = reassignmentMatch[1];
  const funcType = collectDeclaredVariables(prefix).get(funcVariableName.toLowerCase());
  const funcTypeArguments = funcType ? parseFuncTypeArguments(funcType) : [];
  const parameterNames = splitCommaList(reassignmentMatch[2]);
  const parameterIndex = parameterNames.findIndex(name => name === receiver);

  if (parameterIndex < 0 || parameterIndex >= funcTypeArguments.length - 1) {
    return undefined;
  }

  return toApexType(funcTypeArguments[parameterIndex]);
}

function inferDeclaredVariableType(
  prefix: string,
  receiver: string,
): string | undefined {
  const declarations = collectDeclaredVariables(prefix);
  return declarations.get(receiver.toLowerCase());
}

function collectDeclaredVariables(prefix: string): Map<string, string> {
  const variables = new Map<string, string>();
  const declarationPattern =
    /\b(Func\s*<\s*[^>\r\n]+?\s*>|(?:List|Set)\s*<\s*[A-Za-z][A-Za-z0-9_.]*\s*>|Map\s*<\s*[A-Za-z][A-Za-z0-9_.]*\s*,\s*[A-Za-z][A-Za-z0-9_.]*\s*>|DateTime|Datetime|Date|String|Integer|Long|Decimal|Double|Boolean|Id|Object|[A-Za-z][A-Za-z0-9_.]*)\s+([A-Za-z][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = declarationPattern.exec(prefix)) !== null) {
    const typeName = normalizeType(match[1]);
    const variableName = match[2];
    const nextCharacter = prefix
      .slice((match.index ?? 0) + match[0].length)
      .trimStart()[0];

    if (
      nextCharacter !== "(" &&
      isLikelyDeclaration(prefix, match.index, typeName)
    ) {
      variables.set(variableName.toLowerCase(), typeName);
    }
  }

  return variables;
}

function isLikelyDeclaration(
  prefix: string,
  matchIndex: number,
  typeName: string,
): boolean {
  const before = prefix.slice(Math.max(0, matchIndex - 24), matchIndex);
  return (
    !/\b(class|interface|enum|new)\s+$/i.test(before) &&
    !isApexKeyword(typeName)
  );
}

function isApexKeyword(value: string): boolean {
  return new Set([
    "abstract",
    "break",
    "catch",
    "class",
    "continue",
    "do",
    "else",
    "enum",
    "extends",
    "final",
    "finally",
    "for",
    "global",
    "if",
    "implements",
    "inherited",
    "interface",
    "new",
    "override",
    "private",
    "protected",
    "public",
    "return",
    "sharing",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "virtual",
    "when",
    "while",
    "with",
    "without",
  ]).has(value.toLowerCase());
}

function completionsForType(typeName: string): CompletionItem[] {
  const normalized = normalizeType(typeName).toLowerCase();

  if (normalized === "datetime" || normalized === "dateTime".toLowerCase()) {
    return memberCompletions(
      mergeByLabel(standardLibraryMembers("Datetime", false) ?? [], datetimeMembers()),
    );
  }

  if (normalized === "date") {
    return memberCompletions(
      mergeByLabel(standardLibraryMembers("Date", false) ?? [], dateMembers()),
    );
  }

  if (normalized === "string") {
    return memberCompletions(
      mergeByLabel(standardLibraryMembers("String", false) ?? [], stringMembers()),
    );
  }

  if (/^list<.+>$/i.test(normalized)) {
    // ApexX's pipeline methods come first: they are the reason a List reads differently
    // here than in Apex, and the platform's own List members follow them.
    return memberCompletions(
      mergeByLabel(listMembers(), standardLibraryMembers("List", false) ?? []),
    );
  }

  if (/^func<.+>$/i.test(normalized)) {
    return memberCompletions(funcMembers(typeName));
  }

  const builtIn = builtInInstanceMembers(normalized);
  const standard = standardLibraryMembers(bareTypeName(typeName), false);

  if (standard || builtIn) {
    return memberCompletions(mergeByLabel(standard ?? [], builtIn ?? []));
  }

  // A type this workspace declares: its own instance members, not an SObject's.
  const declared = workspaceTypeMembers(typeName, false);
  if (declared && declared.length > 0) {
    return memberCompletions(declared);
  }

  // Anything ending in Exception is one, including a user-declared one, and all of
  // them carry the same members.
  if (/exception$/i.test(normalized)) {
    return memberCompletions(exceptionInstanceMembers());
  }

  const sObjectFields = getSObjectFields(typeName, workspaceRoot);
  if (sObjectFields && sObjectFields.length > 0) {
    return memberCompletions([
      ...sObjectMembers(typeName, sObjectFields),
      ...sObjectBuiltInMembers(),
    ]);
  }

  return [];
}

/**
 * Where the caret sits relative to an annotation.
 *
 * `parameterOf` names the annotation when the caret is inside its argument list, which
 * is a different question from which annotation to write in the first place.
 */
function findAnnotationContext(
  source: string,
  offset: number,
): { parameterOf?: string } | undefined {
  const line = source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);

  if (/@[A-Za-z0-9_]*$/.test(line)) {
    return {};
  }

  const inArguments = /@([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)$/.exec(line);
  return inArguments ? { parameterOf: inArguments[1] } : undefined;
}

/** Decorators available here, then the native Apex annotations. */
function annotationCompletions(source: string): CompletionItem[] {
  const decorators = findApexXDecorators(source, workspaceRoot);
  const items: CompletionItem[] = decorators.map(decorator => ({
    label: decorator.name,
    kind: CompletionItemKind.Class,
    detail: decorator.configKeys.length > 0
      ? `ApexX decorator (${decorator.configKeys.join(", ")})`
      : "ApexX decorator",
    documentation: decoratorDocumentation(decorator),
    insertText: decorator.configKeys.length > 0
      ? `${decorator.name}(\${1:${decorator.configKeys[0]}} = \${2})`
      : decorator.name,
    insertTextFormat: decorator.configKeys.length > 0
      ? InsertTextFormat.Snippet
      : InsertTextFormat.PlainText,
    sortText: `0_${decorator.name}`,
  }));

  for (const annotation of nativeApexAnnotations()) {
    items.push({
      label: annotation,
      kind: CompletionItemKind.Keyword,
      detail: "Apex annotation",
      sortText: `1_${annotation}`,
    });
  }

  return items;
}

/**
 * The parameters a decorator understands.
 *
 * A decorator receives an untyped `Map<String, Object>`, so there is no signature to
 * read; the keys it pulls out of `ctx.config` are what it actually accepts.
 */
function decoratorParameterCompletions(
  source: string,
  name: string,
): CompletionItem[] {
  const decorator = findApexXDecorators(source, workspaceRoot).find(
    candidate => candidate.name.toLowerCase() === name.toLowerCase(),
  );

  if (!decorator) {
    return nativeAnnotationParameters(name);
  }

  return decorator.configKeys.map(key => ({
    label: key,
    kind: CompletionItemKind.Property,
    detail: `@${decorator.name} parameter`,
    insertText: `${key} = `,
    sortText: `0_${key}`,
  }));
}

/**
 * Parameters of the native Apex annotations that take them.
 *
 * These are fixed by the platform rather than discoverable from source, so the few
 * that are worth typing for are listed. An annotation absent here takes no arguments,
 * or none this offers.
 */
function nativeAnnotationParameters(name: string): CompletionItem[] {
  const parameters: Record<string, string[]> = {
    auraenabled: ["cacheable", "scope"],
    future: ["callout"],
    invocablemethod: ["label", "description", "category", "configurationEditor"],
    invocablevariable: ["label", "description", "required"],
    istest: ["seeAllData", "isParallel"],
    jsonaccess: ["serializable", "deserializable"],
    restresource: ["urlMapping"],
  };

  return (parameters[name.toLowerCase()] ?? []).map(parameter => ({
    label: parameter,
    kind: CompletionItemKind.Property,
    detail: `@${name} parameter`,
    insertText: `${parameter}=`,
    sortText: `0_${parameter}`,
  }));
}

function decoratorDocumentation(decorator: ApexXDecorator): string {
  const parameters = decorator.configKeys.length > 0
    ? decorator.configKeys.map(key => `- \`${key}\``).join("\n")
    : "_No parameters are read from `ctx.config`._";

  return [
    `Implements \`ApexX.Decorator\`.`,
    "",
    "Parameters, taken from the keys the decorator reads:",
    parameters,
  ].join("\n");
}

/**
 * Static members of the system types a `.clsx` or `.apexx` file reaches for most.
 *
 * The built-in symbol model has no Apex standard library, and the Apex language
 * server that does is optional and never available to a script, so a receiver like
 * `Datetime.` used to complete to nothing at all. This is a curated subset, not the
 * standard library: enough that the common calls are typed for you, and honest about
 * being a subset in the detail line.
 */
function staticCompletionsFor(receiver: string): CompletionItem[] | undefined {
  // The Apex extension's own standard library, when the user has it, is both complete
  // and authoritative -- it is the same data the Apex language server answers from. The
  // curated table below is the fallback for a machine without it, and still fills in
  // anything the library does not name.
  const library = standardReceiverMembers(receiver);
  const curated = staticMembers[receiver.toLowerCase()]?.();

  if (library || curated) {
    return memberCompletions(mergeByLabel(library ?? [], curated ?? []));
  }

  // A type this workspace declares, used statically.
  const declared = workspaceTypeMembers(receiver, true);
  if (declared && declared.length > 0) {
    return memberCompletions(declared);
  }

  return undefined;
}

/** First list wins on a clash, so the better-sourced members keep their detail. */
function mergeByLabel(
  preferred: CompletionItem[],
  additional: CompletionItem[],
): CompletionItem[] {
  const merged = new Map<string, CompletionItem>();

  for (const item of [...preferred, ...additional]) {
    if (!merged.has(item.label)) {
      merged.set(item.label, item);
    }
  }

  return [...merged.values()];
}

const staticMembers: Record<string, () => CompletionItem[]> = {
  system: () => [
    method("debug", "void System.debug(Object message)", "debug(${1:message})"),
    method("assert", "void System.assert(Boolean condition, Object message)", "assert(${1:condition}, ${2:message})"),
    method("assertEquals", "void System.assertEquals(Object expected, Object actual)", "assertEquals(${1:expected}, ${2:actual})"),
    method("assertNotEquals", "void System.assertNotEquals(Object expected, Object actual)", "assertNotEquals(${1:expected}, ${2:actual})"),
    method("now", "Datetime System.now()"),
    method("today", "Date System.today()"),
    method("currentTimeMillis", "Long System.currentTimeMillis()"),
    method("enqueueJob", "Id System.enqueueJob(Object job)", "enqueueJob(${1:job})"),
    method("runAs", "void System.runAs(User user)", "runAs(${1:user})"),
  ],
  math: () => [
    method("abs", "Decimal Math.abs(Decimal value)", "abs(${1:value})"),
    method("ceil", "Integer Math.ceil(Decimal value)", "ceil(${1:value})"),
    method("floor", "Integer Math.floor(Decimal value)", "floor(${1:value})"),
    method("max", "Decimal Math.max(Decimal first, Decimal second)", "max(${1:first}, ${2:second})"),
    method("min", "Decimal Math.min(Decimal first, Decimal second)", "min(${1:first}, ${2:second})"),
    method("mod", "Integer Math.mod(Integer value, Integer divisor)", "mod(${1:value}, ${2:divisor})"),
    method("pow", "Double Math.pow(Double base, Double exponent)", "pow(${1:base}, ${2:exponent})"),
    method("random", "Double Math.random()"),
    method("round", "Integer Math.round(Decimal value)", "round(${1:value})"),
    method("sqrt", "Double Math.sqrt(Double value)", "sqrt(${1:value})"),
  ],
  string: () => [
    method("escapeSingleQuotes", "String String.escapeSingleQuotes(String value)", "escapeSingleQuotes(${1:value})"),
    method("format", "String String.format(String template, List<Object> arguments)", "format(${1:template}, ${2:arguments})"),
    method("isBlank", "Boolean String.isBlank(String value)", "isBlank(${1:value})"),
    method("isEmpty", "Boolean String.isEmpty(String value)", "isEmpty(${1:value})"),
    method("isNotBlank", "Boolean String.isNotBlank(String value)", "isNotBlank(${1:value})"),
    method("isNotEmpty", "Boolean String.isNotEmpty(String value)", "isNotEmpty(${1:value})"),
    method("join", "String String.join(Iterable<Object> values, String separator)", "join(${1:values}, ${2:separator})"),
    method("valueOf", "String String.valueOf(Object value)", "valueOf(${1:value})"),
  ],
  date: () => [
    method("newInstance", "Date Date.newInstance(Integer year, Integer month, Integer day)", "newInstance(${1:year}, ${2:month}, ${3:day})"),
    method("today", "Date Date.today()"),
    method("valueOf", "Date Date.valueOf(Object value)", "valueOf(${1:value})"),
    method("daysInMonth", "Integer Date.daysInMonth(Integer year, Integer month)", "daysInMonth(${1:year}, ${2:month})"),
    method("isLeapYear", "Boolean Date.isLeapYear(Integer year)", "isLeapYear(${1:year})"),
  ],
  datetime: () => [
    method("now", "Datetime Datetime.now()"),
    method("newInstance", "Datetime Datetime.newInstance(Long milliseconds)", "newInstance(${1:milliseconds})"),
    method("newInstanceGmt", "Datetime Datetime.newInstanceGmt(Date date, Time time)", "newInstanceGmt(${1:date}, ${2:time})"),
    method("valueOf", "Datetime Datetime.valueOf(Object value)", "valueOf(${1:value})"),
    method("valueOfGmt", "Datetime Datetime.valueOfGmt(String value)", "valueOfGmt(${1:value})"),
  ],
  decimal: () => [
    method("valueOf", "Decimal Decimal.valueOf(Object value)", "valueOf(${1:value})"),
  ],
  integer: () => [
    method("valueOf", "Integer Integer.valueOf(Object value)", "valueOf(${1:value})"),
  ],
  id: () => [
    method("valueOf", "Id Id.valueOf(String value)", "valueOf(${1:value})"),
  ],
  json: () => [
    method("serialize", "String JSON.serialize(Object value)", "serialize(${1:value})"),
    method("serializePretty", "String JSON.serializePretty(Object value)", "serializePretty(${1:value})"),
    method("deserialize", "Object JSON.deserialize(String jsonString, System.Type apexType)", "deserialize(${1:jsonString}, ${2:apexType})"),
    method("deserializeUntyped", "Object JSON.deserializeUntyped(String jsonString)", "deserializeUntyped(${1:jsonString})"),
  ],
  database: () => [
    method("insert", "List<Database.SaveResult> Database.insert(List<SObject> records, Boolean allOrNone)", "insert(${1:records}, ${2:false})"),
    method("update", "List<Database.SaveResult> Database.update(List<SObject> records, Boolean allOrNone)", "update(${1:records}, ${2:false})"),
    method("upsert", "List<Database.UpsertResult> Database.upsert(List<SObject> records, Schema.SObjectField externalId)", "upsert(${1:records}, ${2:externalId})"),
    method("delete", "List<Database.DeleteResult> Database.delete(List<SObject> records, Boolean allOrNone)", "delete(${1:records}, ${2:false})"),
    method("query", "List<SObject> Database.query(String soql)", "query(${1:soql})"),
    method("getQueryLocator", "Database.QueryLocator Database.getQueryLocator(String soql)", "getQueryLocator(${1:soql})"),
  ],
  userinfo: () => [
    method("getUserId", "Id UserInfo.getUserId()"),
    method("getName", "String UserInfo.getName()"),
    method("getUserEmail", "String UserInfo.getUserEmail()"),
    method("getOrganizationId", "Id UserInfo.getOrganizationId()"),
    method("getProfileId", "Id UserInfo.getProfileId()"),
    method("getLocale", "String UserInfo.getLocale()"),
    method("getTimeZone", "TimeZone UserInfo.getTimeZone()"),
  ],
  test: () => [
    method("startTest", "void Test.startTest()"),
    method("stopTest", "void Test.stopTest()"),
    method("isRunningTest", "Boolean Test.isRunningTest()"),
    method("setMock", "void Test.setMock(System.Type interfaceType, Object instance)", "setMock(${1:interfaceType}, ${2:instance})"),
    method("loadData", "List<SObject> Test.loadData(Schema.SObjectType sObjectType, String resourceName)", "loadData(${1:sObjectType}, ${2:resourceName})"),
  ],
  schema: () => [
    method("getGlobalDescribe", "Map<String, Schema.SObjectType> Schema.getGlobalDescribe()"),
    method("describeSObjects", "List<Schema.DescribeSObjectResult> Schema.describeSObjects(List<String> types)", "describeSObjects(${1:types})"),
    method("describeDataCategoryGroups", "List<Schema.DescribeDataCategoryGroupResult> Schema.describeDataCategoryGroups(List<String> objectTypes)", "describeDataCategoryGroups(${1:objectTypes})"),
  ],
  trigger: () => [
    property("new", "List<SObject> Trigger.new"),
    property("old", "List<SObject> Trigger.old"),
    property("newMap", "Map<Id, SObject> Trigger.newMap"),
    property("oldMap", "Map<Id, SObject> Trigger.oldMap"),
    property("isInsert", "Boolean Trigger.isInsert"),
    property("isUpdate", "Boolean Trigger.isUpdate"),
    property("isDelete", "Boolean Trigger.isDelete"),
    property("isUndelete", "Boolean Trigger.isUndelete"),
    property("isBefore", "Boolean Trigger.isBefore"),
    property("isAfter", "Boolean Trigger.isAfter"),
    property("isExecuting", "Boolean Trigger.isExecuting"),
    property("size", "Integer Trigger.size"),
  ],
  encodingutil: () => [
    method("base64Encode", "String EncodingUtil.base64Encode(Blob value)", "base64Encode(${1:value})"),
    method("base64Decode", "Blob EncodingUtil.base64Decode(String value)", "base64Decode(${1:value})"),
    method("urlEncode", "String EncodingUtil.urlEncode(String value, String encoding)", "urlEncode(${1:value}, ${2:'UTF-8'})"),
    method("urlDecode", "String EncodingUtil.urlDecode(String value, String encoding)", "urlDecode(${1:value}, ${2:'UTF-8'})"),
    method("convertToHex", "String EncodingUtil.convertToHex(Blob value)", "convertToHex(${1:value})"),
  ],
  crypto: () => [
    method("generateDigest", "Blob Crypto.generateDigest(String algorithm, Blob input)", "generateDigest(${1:'SHA-256'}, ${2:input})"),
    method("generateMac", "Blob Crypto.generateMac(String algorithm, Blob input, Blob key)", "generateMac(${1:'hmacSHA256'}, ${2:input}, ${3:key})"),
    method("generateAesKey", "Blob Crypto.generateAesKey(Integer size)", "generateAesKey(${1:256})"),
    method("getRandomInteger", "Integer Crypto.getRandomInteger()"),
  ],
  blob: () => [
    method("valueOf", "Blob Blob.valueOf(String value)", "valueOf(${1:value})"),
    method("toPdf", "Blob Blob.toPdf(String html)", "toPdf(${1:html})"),
  ],
  eventbus: () => [
    method("publish", "Database.SaveResult EventBus.publish(SObject event)", "publish(${1:event})"),
  ],
  type: () => [
    method("forName", "System.Type Type.forName(String typeName)", "forName(${1:typeName})"),
  ],
  pattern: () => [
    method("compile", "Pattern Pattern.compile(String regExp)", "compile(${1:regExp})"),
    method("matches", "Boolean Pattern.matches(String regExp, String input)", "matches(${1:regExp}, ${2:input})"),
    method("quote", "String Pattern.quote(String text)", "quote(${1:text})"),
  ],
  approval: () => [
    method("process", "Approval.ProcessResult Approval.process(Approval.ProcessRequest request)", "process(${1:request})"),
  ],
  long: () => [
    method("valueOf", "Long Long.valueOf(String value)", "valueOf(${1:value})"),
  ],
  double: () => [
    method("valueOf", "Double Double.valueOf(String value)", "valueOf(${1:value})"),
  ],
  boolean: () => [
    method("valueOf", "Boolean Boolean.valueOf(Object value)", "valueOf(${1:value})"),
  ],
  limits: () => [
    method("getQueries", "Integer Limits.getQueries()"),
    method("getLimitQueries", "Integer Limits.getLimitQueries()"),
    method("getDmlStatements", "Integer Limits.getDmlStatements()"),
    method("getLimitDmlStatements", "Integer Limits.getLimitDmlStatements()"),
    method("getCpuTime", "Integer Limits.getCpuTime()"),
    method("getLimitCpuTime", "Integer Limits.getLimitCpuTime()"),
    method("getHeapSize", "Integer Limits.getHeapSize()"),
    method("getLimitHeapSize", "Integer Limits.getLimitHeapSize()"),
  ],
};

/**
 * ApexX's collection pipeline, offered in the identifier list so it is discoverable
 * without already knowing it exists.
 */
function pipelineHelperCompletions(): CompletionItem[] {
  return [
    {
      label: "filter",
      kind: CompletionItemKind.Method,
      detail: "ApexX List<T>.filter(item => predicate)",
      insertText: "filter(item => item)",
    },
    {
      label: "map",
      kind: CompletionItemKind.Method,
      detail: "ApexX List<T>.map(item => result)",
      insertText: "map(item => item)",
    },
    {
      label: "find",
      kind: CompletionItemKind.Method,
      detail: "ApexX List<T>.find(item => predicate)",
      insertText: "find(item => item)",
    },
    {
      label: "any",
      kind: CompletionItemKind.Method,
      detail: "ApexX List<T>.any(item => predicate)",
      insertText: "any(item => item)",
    },
    {
      label: "all",
      kind: CompletionItemKind.Method,
      detail: "ApexX List<T>.all(item => predicate)",
      insertText: "all(item => item)",
    },
    {
      label: "count",
      kind: CompletionItemKind.Method,
      detail: "ApexX List<T>.count(item => predicate)",
      insertText: "count(item => item)",
    },
    {
      label: "flatMap",
      kind: CompletionItemKind.Method,
      detail: "ApexX List<T>.flatMap(item => list)",
      insertText: "flatMap(item => item)",
    },
  ];
}

function memberCompletions(members: CompletionItem[]): CompletionItem[] {
  return members.map(member => ({
    ...member,
    sortText: member.sortText ?? `0_${member.label}`,
  }));
}

function method(label: string, detail: string, insertText?: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Method,
    detail,
    insertText: insertText ?? label,
    insertTextFormat: insertText?.includes("${")
      ? InsertTextFormat.Snippet
      : InsertTextFormat.PlainText,
  };
}

function property(label: string, detail: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Property,
    detail,
  };
}

function sObjectMembers(
  typeName: string,
  fields: SObjectFieldInfo[],
): CompletionItem[] {
  return fields.map(fieldInfo => ({
    label: fieldInfo.name,
    kind: CompletionItemKind.Field,
    detail: `${typeName}.${fieldInfo.name}: ${apexTypeForField(fieldInfo)}`,
    documentation:
      fieldInfo.label && fieldInfo.label !== fieldInfo.name
        ? fieldInfo.label
        : undefined,
  }));
}

function funcMembers(typeName: string): CompletionItem[] {
  const args = parseFuncTypeArguments(typeName);
  const parameterTypes = args.slice(0, -1).map(toApexType);
  const returnType = toApexType(args.at(-1) ?? "Object");
  const signature = `${returnType} invoke(${parameterTypes
    .map((parameterType, index) => `${parameterType} arg${index}`)
    .join(", ")})`;
  const insertText =
    parameterTypes.length === 0
      ? "invoke()"
      : `invoke(${parameterTypes.map((_, index) => `\${${index + 1}:arg${index}}`).join(", ")})`;

  return [method("invoke", signature, insertText)];
}

function parseFuncTypeArguments(typeName: string): string[] {
  const match = /^Func\s*<\s*(.+)\s*>$/i.exec(typeName.trim());
  return match ? splitCommaList(match[1]) : [];
}

function apexTypeForField(fieldInfo: SObjectFieldInfo): string {
  if (fieldInfo.referenceTo && fieldInfo.referenceTo.length > 0) {
    return `Id (${fieldInfo.referenceTo.join(" | ")})`;
  }

  switch (fieldInfo.type.toLowerCase()) {
    case "id":
    case "reference":
      return "Id";
    case "boolean":
      return "Boolean";
    case "int":
      return "Integer";
    case "double":
    case "currency":
    case "percent":
      return "Decimal";
    case "date":
      return "Date";
    case "datetime":
      return "Datetime";
    case "phone":
    case "picklist":
    case "textarea":
    case "email":
    case "url":
    case "encryptedstring":
    case "string":
      return "String";
    default:
      return fieldInfo.type;
  }
}

function datetimeMembers(): CompletionItem[] {
  return [
    method("addDays", "Datetime addDays(Integer additionalDays)", "addDays(${1:days})"),
    method("addHours", "Datetime addHours(Integer additionalHours)", "addHours(${1:hours})"),
    method("addMinutes", "Datetime addMinutes(Integer additionalMinutes)", "addMinutes(${1:minutes})"),
    method("addMonths", "Datetime addMonths(Integer additionalMonths)", "addMonths(${1:months})"),
    method("addSeconds", "Datetime addSeconds(Integer additionalSeconds)", "addSeconds(${1:seconds})"),
    method("addYears", "Datetime addYears(Integer additionalYears)", "addYears(${1:years})"),
    method("date", "Date date()"),
    method("day", "Integer day()"),
    method("format", "String format()", "format()"),
    method("formatGmt", "String formatGmt(String dateFormatString)", "formatGmt(${1:format})"),
    method("getTime", "Long getTime()"),
    method("hour", "Integer hour()"),
    method("millisecond", "Integer millisecond()"),
    method("minute", "Integer minute()"),
    method("month", "Integer month()"),
    method("second", "Integer second()"),
    method("time", "Time time()"),
    method("year", "Integer year()"),
  ];
}

function dateMembers(): CompletionItem[] {
  return [
    method("addDays", "Date addDays(Integer additionalDays)", "addDays(${1:days})"),
    method("addMonths", "Date addMonths(Integer additionalMonths)", "addMonths(${1:months})"),
    method("addYears", "Date addYears(Integer additionalYears)", "addYears(${1:years})"),
    method("day", "Integer day()"),
    method("dayOfYear", "Integer dayOfYear()"),
    method("daysBetween", "Integer daysBetween(Date secondDate)", "daysBetween(${1:secondDate})"),
    method("format", "String format()"),
    method("month", "Integer month()"),
    method("toStartOfMonth", "Date toStartOfMonth()"),
    method("toStartOfWeek", "Date toStartOfWeek()"),
    method("year", "Integer year()"),
  ];
}

function stringMembers(): CompletionItem[] {
  return [
    method("abbreviate", "String abbreviate(Integer maxWidth)", "abbreviate(${1:maxWidth})"),
    method("capitalize", "String capitalize()"),
    method("contains", "Boolean contains(String substring)", "contains(${1:substring})"),
    method("endsWith", "Boolean endsWith(String suffix)", "endsWith(${1:suffix})"),
    method("equals", "Boolean equals(Object stringOrId)", "equals(${1:value})"),
    method("isBlank", "Boolean isBlank()"),
    method("length", "Integer length()"),
    method("replace", "String replace(String target, String replacement)", "replace(${1:target}, ${2:replacement})"),
    method("split", "List<String> split(String regExp)", "split(${1:regExp})"),
    method("startsWith", "Boolean startsWith(String prefix)", "startsWith(${1:prefix})"),
    method("substring", "String substring(Integer startIndex)", "substring(${1:startIndex})"),
    method("toLowerCase", "String toLowerCase()"),
    method("toUpperCase", "String toUpperCase()"),
    method("trim", "String trim()"),
  ];
}

function listMembers(): CompletionItem[] {
  return [
    method("filter", "ApexX List<T> filter(item => predicate)", "filter(${1:item} => ${1:item}.${2:field} == ${3:value})"),
    method("map", "ApexX List<R> map(item => result)", "map(${1:item} => ${1:item}.${2:field})"),
    method("flatMap", "ApexX List<R> flatMap(item => List<R>)", "flatMap(${1:item} => ${1:item}.${2:listField})"),
    method("find", "ApexX T find(item => predicate)", "find(${1:item} => ${1:item}.${2:field} == ${3:value})"),
    method("any", "ApexX Boolean any(item => predicate)", "any(${1:item} => ${1:item}.${2:field} == ${3:value})"),
    method("all", "ApexX Boolean all(item => predicate)", "all(${1:item} => ${1:item}.${2:field} != ${3:null})"),
    method("count", "ApexX Integer count(item => predicate)", "count(${1:item} => ${1:item}.${2:field} == ${3:value})"),
    method("add", "Boolean add(T element)", "add(${1:element})"),
    method("addAll", "void addAll(List<T> fromList)", "addAll(${1:fromList})"),
    method("clear", "void clear()"),
    method("contains", "Boolean contains(T element)", "contains(${1:element})"),
    method("get", "T get(Integer index)", "get(${1:index})"),
    method("indexOf", "Integer indexOf(T element)", "indexOf(${1:element})"),
    method("isEmpty", "Boolean isEmpty()"),
    method("remove", "T remove(Integer index)", "remove(${1:index})"),
    method("set", "void set(Integer index, T element)", "set(${1:index}, ${2:element})"),
    method("size", "Integer size()"),
    method("sort", "void sort()"),
    property("iterator", "Iterator<T> iterator()"),
  ];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uriToFilePath(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }

  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function splitCommaList(source: string): string[] {
  return source
    .split(",")
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

function toApexType(typeName: string): string {
  const normalized = normalizeType(typeName);
  const aliases: Record<string, string> = {
    bool: "Boolean",
    boolean: "Boolean",
    int: "Integer",
    integer: "Integer",
    long: "Long",
    decimal: "Decimal",
    double: "Double",
    string: "String",
    object: "Object",
    id: "Id",
    date: "Date",
    datetime: "Datetime",
    time: "Time",
  };

  return aliases[normalized.toLowerCase()] ?? normalized;
}
