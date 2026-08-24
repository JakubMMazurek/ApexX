#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  CompletionItem,
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
import { transpileApexX } from "@apexx/transpiler";
import type { ApexXDiagnostic } from "@apexx/ast";
import {
  collectListVariables,
  createApexTypeProvider,
  extractListElementType,
  inferExpressionType,
  normalizeType,
} from "@apexx/semantics";
import {
  getSObjectFields,
  type SObjectFieldInfo,
} from "./sobjectSchema.js";
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
  resolveSymbol,
  type ApexSymbol,
  type ApexSymbolKind,
  type DocumentModel,
} from "./apexModel.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let workspaceRoot: string | undefined;

connection.onInitialize(params => {
  workspaceRoot = uriToFilePath(
    params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined,
  );

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ["."],
        resolveProvider: false,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      workspaceSymbolProvider: true,
    },
  };
});

connection.onCompletion(params => {
  try {
    const document = documents.get(params.textDocument.uri);

    if (!document || !document.uri.toLowerCase().endsWith(".clsx")) {
      return [];
    }

    return getCompletions(document, params.position);
  } catch (error) {
    connection.console.error(formatError(error));
    return [];
  }
});

connection.onHover(params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return null;
  }

  const source = document.getText();
  const offset = document.offsetAt(params.position);
  const identifier = identifierAt(source, offset);
  const sections: string[] = [];

  if (identifier) {
    const symbol = resolveSymbol(modelFor(document), identifier.name, offset);

    if (symbol) {
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
  }

  return sections.length > 0
    ? { contents: { kind: "markdown", value: sections.join("\n\n---\n\n") } }
    : null;
});

connection.onDocumentSymbol(params => {
  const document = apexxDocument(params.textDocument.uri);

  if (!document) {
    return [];
  }

  return outline(document, modelFor(document));
});

connection.onDefinition(params => {
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
  const local = resolveSymbol(modelFor(document), identifier.name, offset);

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

connection.onReferences(params => {
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

connection.onRenameRequest(params => {
  const found = symbolUnderCursor(params.textDocument.uri, params.position);

  if (!found || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.newName)) {
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

  const model = modelFor(document);
  const candidates = model.symbols.filter(
    symbol =>
      (symbol.kind === "method" || symbol.kind === "constructor") &&
      symbol.name === call.name,
  );

  if (candidates.length === 0) {
    return null;
  }

  return {
    signatures: candidates.map(symbol => ({
      label: describeSymbol(symbol),
      parameters: (symbol.parameters ?? []).map(parameter => ({
        label: `${parameter.type} ${parameter.name}`,
      })),
    })),
    activeSignature: 0,
    activeParameter: call.activeParameter,
  };
});

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(event => validateDocument(event.document));
documents.onDidClose(event => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();

async function validateDocument(document: TextDocument): Promise<void> {
  if (!document.uri.toLowerCase().endsWith(".clsx")) {
    return;
  }

  try {
    const result = transpileApexX(document.getText(), {
      sourceFileName: document.uri.split("/").at(-1),
      workspaceRoot,
    });

    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: result.diagnostics.map(toLspDiagnostic),
    });
  } catch (error) {
    connection.console.error(formatError(error));
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: [
        {
          severity: DiagnosticSeverity.Error,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          message: `ApexX language server error: ${formatError(error)}`,
          source: "apexx",
        },
      ],
    });
  }
}

function toLspDiagnostic(diagnostic: ApexXDiagnostic) {
  const line = Math.max((diagnostic.range?.start.line ?? 1) - 1, 0);
  const character = Math.max(diagnostic.range?.start.column ?? 0, 0);

  return {
    severity:
      diagnostic.severity === "error"
        ? DiagnosticSeverity.Error
        : diagnostic.severity === "warning"
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Information,
    range: {
      start: { line, character },
      end: {
        line,
        character: Math.max(character + 1, diagnostic.range?.end.column ?? character + 1),
      },
    },
    message: diagnostic.message,
    source: diagnostic.source ?? "apexx",
  };
}

function getCompletions(
  document: TextDocument,
  position: Position,
): CompletionItem[] {
  const source = document.getText();
  const offset = document.offsetAt(position);
  const receiver = findReceiverBeforeDot(source.slice(0, offset));

  if (!receiver) {
    return topLevelCompletions();
  }

  const receiverType = inferReceiverType(source, offset, receiver);
  if (!receiverType) {
    return [];
  }

  return completionsForType(receiverType);
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

  const model = buildDocumentModel(document.getText());
  modelCache.set(document.uri, { version: document.version, model });
  return model;
}

function apexxDocument(uri: string): TextDocument | undefined {
  const document = documents.get(uri);
  return document && document.uri.toLowerCase().endsWith(".clsx")
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
): { name: string; activeParameter: number } | undefined {
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

      const name = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(source.slice(0, index))?.[1];
      return name ? { name, activeParameter: commas } : undefined;
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

function findReceiverBeforeDot(prefix: string): string | undefined {
  return prefix.match(/([A-Za-z][A-Za-z0-9_]*)\.\s*$/)?.[1];
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
    return memberCompletions(datetimeMembers());
  }

  if (normalized === "date") {
    return memberCompletions(dateMembers());
  }

  if (normalized === "string") {
    return memberCompletions(stringMembers());
  }

  if (/^list<.+>$/i.test(normalized)) {
    return memberCompletions(listMembers());
  }

  if (/^func<.+>$/i.test(normalized)) {
    return memberCompletions(funcMembers(typeName));
  }

  const sObjectFields = getSObjectFields(typeName, workspaceRoot);
  if (sObjectFields) {
    return memberCompletions(sObjectMembers(typeName, sObjectFields));
  }

  return [];
}

function topLevelCompletions(): CompletionItem[] {
  return [
    typeCompletion("Date"),
    typeCompletion("Datetime"),
    typeCompletion("String"),
    typeCompletion("Integer"),
    typeCompletion("Boolean"),
    typeCompletion("List"),
    typeCompletion("Func"),
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

function typeCompletion(label: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Class,
    detail: `Apex type ${label}`,
  };
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
