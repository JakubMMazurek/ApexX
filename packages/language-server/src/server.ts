#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  InsertTextFormat,
  Position,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
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
  const document = documents.get(params.textDocument.uri);

  if (!document || !document.uri.toLowerCase().endsWith(".clsx")) {
    return null;
  }

  const word = wordAtPosition(document, params.position);
  const markdown = word ? hoverDocumentation(word) : undefined;

  return markdown
    ? { contents: { kind: "markdown", value: markdown } }
    : null;
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
