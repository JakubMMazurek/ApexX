import {
  ApexErrorListener,
  ApexParseTreeWalker,
  ApexParserBaseListener,
  ApexParserFactory,
} from "@apexdevtools/apex-parser";
import { parseApexX } from "@apexx/parser";

export type ApexSymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "method"
  | "constructor"
  | "field"
  | "property"
  | "parameter"
  | "local";

export interface ApexParameter {
  name: string;
  type: string;
  nameStart: number;
  nameEnd: number;
}

export interface ApexSymbol {
  name: string;
  kind: ApexSymbolKind;
  /** Declared type, or the return type for a method. */
  type?: string;
  parameters?: ApexParameter[];
  /** Name of the enclosing class or method, when there is one. */
  container?: string;
  /** Offsets of the declared identifier itself. */
  nameStart: number;
  nameEnd: number;
  /** Offsets of the whole declaration, used for outline ranges and scoping. */
  declStart: number;
  declEnd: number;
}

export interface DocumentModel {
  source: string;
  /** Offset-preserving plain-Apex projection of the ApexX source. */
  normalizedApex: string;
  symbols: ApexSymbol[];
  /** Syntax errors remaining after normalization; high counts mean degraded results. */
  parseErrorCount: number;
}

class CollectingErrorListener extends ApexErrorListener {
  count = 0;

  apexSyntaxError(): void {
    this.count += 1;
  }
}

const pad = (width: number): string => " ".repeat(Math.max(0, width));
const blank = (text: string): string => text.replace(/[^\n\r]/g, " ");
const fit = (text: string, width: number): string =>
  (text + pad(width - text.length)).slice(0, width);

/** A comma-separated run of bare identifiers or dotted paths, i.e. an ApexX tuple literal. */
const TUPLE_LITERAL =
  /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\s*)+$/;
/** `Type name`, the shape of the last entry in a tuple destructuring binding list. */
const TUPLE_BINDING = /[A-Za-z_][A-Za-z0-9_.<>,\s]*\s+[A-Za-z_][A-Za-z0-9_]*\s*$/;

/**
 * Rewrites ApexX-only syntax into plain Apex without moving a single character.
 *
 * Every substitution is padded to the width it replaces and newlines are never
 * touched, so offsets and line numbers in the result address exactly the same
 * source text. That is what lets the Apex parse tree be reported back to the
 * editor as positions in the original `.clsx` file.
 */
export function normalizeToApex(source: string): {
  text: string;
  tupleBindings: ApexParameter[];
} {
  const apexx = parseApexX(source);
  const characters = [...source];

  // Constructs the ApexX parser already located: pipelines, Func lambdas, Func calls.
  const ranges = [
    ...apexx.listMethodCalls.map(entry => entry.range),
    ...apexx.funcLambdaAssignments.map(entry => entry.range),
    ...apexx.funcInvocations.map(entry => entry.range),
  ];

  for (const range of ranges) {
    if (!range) {
      continue;
    }

    const { offset: start } = range.start;
    const { offset: end } = range.end;

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }

    for (let index = start; index < end && index < characters.length; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
      }
    }
  }

  let text = characters.join("");
  const tupleBindings: ApexParameter[] = [];

  // A variable declared by an ApexX pipeline or Func lambda is blanked along with
  // its statement, so its declaration is recovered from the ApexX parse result.
  for (const call of apexx.listMethodCalls) {
    if (call.statementKind === "assignment" && call.targetName) {
      recordBinding(
        source,
        call.range.start.offset,
        call.range.end.offset,
        call.targetName,
        call.targetType ?? call.resultType ?? "Object",
        tupleBindings,
      );
    }
  }

  for (const assignment of apexx.funcLambdaAssignments) {
    if (!assignment.isReassignment && assignment.variableName) {
      recordBinding(
        source,
        assignment.range.start.offset,
        assignment.range.end.offset,
        assignment.variableName,
        assignment.sourceFuncType ?? "Func",
        tupleBindings,
      );
    }
  }

  // Tuple destructuring, semicolon included. Forbidding parentheses inside the
  // binding list stops a match running past the first `)`, so an unrelated `(`
  // earlier in the file cannot swallow the statement we are actually looking for.
  text = text.replace(
    /^[ \t]*\(([^();]*)\)[ \t\r\n]*=[^;]*;/gm,
    (match, inner: string, offset: number) => {
      if (!TUPLE_BINDING.test(inner.split(",").pop() ?? "")) {
        return match;
      }

      collectTupleBindings(inner, offset + match.indexOf("(") + 1, tupleBindings);
      return blank(match);
    },
  );

  // A tuple return type in a method signature.
  text = text.replace(
    /((?:public|private|global|protected)[^\n(]*?(?:static[ \t]+)?)(\((?:[^()\n]|\([^()\n]*\))*\))(\s+[A-Za-z][A-Za-z0-9_]*\s*\()/g,
    (_match, lead: string, tuple: string, tail: string) =>
      lead + fit("Object", tuple.length) + tail,
  );

  // A tuple nested in generic type arguments, e.g. `Map<Id, (Decimal, Boolean)>`.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = text.replace(
      /(<[^<>\n]*?)\(([^()\n]*)\)/g,
      (_match, lead: string, inner: string) => lead + fit("Object", inner.length + 2),
    );

    if (next === text) {
      break;
    }

    text = next;
  }

  // Default parameter values.
  text = text.replace(
    /(\b[A-Za-z][A-Za-z0-9_.<>, \t]*\s+[A-Za-z][A-Za-z0-9_]*\s*)=\s*('[^'\n]*'|[-\w.]+)(?=\s*[,)])/g,
    (match, keep: string) => keep + pad(match.length - keep.length),
  );

  // A returned tuple literal.
  text = text.replace(
    /(\breturn\s+)\(([^()\n]*)\)(\s*;)/g,
    (match, lead: string, inner: string, tail: string) =>
      TUPLE_LITERAL.test(inner) ? lead + fit("null", inner.length + 2) + tail : match,
  );

  // A tuple literal in argument position. An Apex parenthesised expression cannot
  // hold a top-level comma, so a bare identifier list here is always a tuple --
  // which is what keeps SOQL subqueries and `IN (...)` lists untouched.
  text = text.replace(
    /(^|[^A-Za-z0-9_)\]])([ \t]*)\(([^()\n]*)\)/g,
    (match, before: string, spacing: string, inner: string) =>
      TUPLE_LITERAL.test(inner)
        ? `${before}${spacing}(${fit("null", inner.length)})`
        : match,
  );

  return { text, tupleBindings };
}

/** Locates `name` inside a blanked statement so its declaration keeps a real position. */
function recordBinding(
  source: string,
  start: number,
  end: number,
  name: string,
  type: string,
  into: ApexParameter[],
): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return;
  }

  const window = source.slice(start, end);
  const match = new RegExp(`\\b${name}\\b`).exec(window);

  if (!match) {
    return;
  }

  into.push({
    name,
    type,
    nameStart: start + match.index,
    nameEnd: start + match.index + name.length,
  });
}

/**
 * Recovers the variables bound by a tuple destructuring statement. The statement
 * itself is blanked before parsing, so these would otherwise be invisible.
 */
function collectTupleBindings(
  inner: string,
  innerOffset: number,
  into: ApexParameter[],
): void {
  let cursor = 0;

  for (const part of inner.split(",")) {
    const match = /([A-Za-z_][A-Za-z0-9_.<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(part);

    if (match?.[2] && match[2] !== "_") {
      const nameStart = innerOffset + cursor + part.lastIndexOf(match[2]);
      into.push({
        name: match[2],
        type: match[1] ?? "Object",
        nameStart,
        nameEnd: nameStart + match[2].length,
      });
    }

    cursor += part.length + 1;
  }
}

/**
 * Parses a `.clsx` document and returns every declaration it contains, with
 * offsets that address the original source.
 */
export function buildDocumentModel(source: string): DocumentModel {
  const { text: normalizedApex, tupleBindings } = normalizeToApex(source);
  const errorListener = new CollectingErrorListener();
  const symbols: ApexSymbol[] = [];

  try {
    const { parser } = ApexParserFactory.createLexerAndParser(
      normalizedApex,
      errorListener,
    );
    const tree = parser.compilationUnit();
    ApexParseTreeWalker.DEFAULT.walk(new DeclarationListener(symbols), tree);
  } catch {
    // A hard parse failure still leaves whatever was collected before it.
  }

  for (const binding of tupleBindings) {
    symbols.push({
      name: binding.name,
      kind: "local",
      type: binding.type,
      container: enclosingMethodName(symbols, binding.nameStart),
      nameStart: binding.nameStart,
      nameEnd: binding.nameEnd,
      declStart: binding.nameStart,
      declEnd: binding.nameEnd,
    });
  }

  symbols.sort((left, right) => left.nameStart - right.nameStart);

  return {
    source,
    normalizedApex,
    symbols,
    parseErrorCount: errorListener.count,
  };
}

function enclosingMethodName(
  symbols: ApexSymbol[],
  offset: number,
): string | undefined {
  let best: ApexSymbol | undefined;

  for (const symbol of symbols) {
    if (
      (symbol.kind === "method" || symbol.kind === "constructor") &&
      symbol.declStart <= offset &&
      offset <= symbol.declEnd &&
      (!best || symbol.declStart > best.declStart)
    ) {
      best = symbol;
    }
  }

  return best?.name;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
class DeclarationListener extends ApexParserBaseListener {
  private readonly typeStack: string[] = [];
  private readonly methodStack: string[] = [];

  constructor(private readonly symbols: ApexSymbol[]) {
    super();
  }

  private get container(): string | undefined {
    return this.methodStack.at(-1) ?? this.typeStack.at(-1);
  }

  private pushType(context: any, kind: ApexSymbolKind): void {
    const name = text(context?.id?.());

    if (!name) {
      return;
    }

    this.symbols.push({
      name,
      kind,
      container: this.typeStack.at(-1),
      ...identifierRange(context.id()),
      ...declarationRange(context),
    });
    this.typeStack.push(name);
  }

  enterClassDeclaration(context: any): void {
    this.pushType(context, "class");
  }

  exitClassDeclaration(): void {
    this.typeStack.pop();
  }

  enterInterfaceDeclaration(context: any): void {
    this.pushType(context, "interface");
  }

  exitInterfaceDeclaration(): void {
    this.typeStack.pop();
  }

  enterEnumDeclaration(context: any): void {
    this.pushType(context, "enum");
  }

  exitEnumDeclaration(): void {
    this.typeStack.pop();
  }

  enterMethodDeclaration(context: any): void {
    const name = text(context?.id?.());

    if (!name) {
      return;
    }

    this.symbols.push({
      name,
      kind: "method",
      type: text(context?.typeRef?.()) ?? "void",
      parameters: readParameters(context),
      container: this.typeStack.at(-1),
      ...identifierRange(context.id()),
      ...declarationRange(context),
    });
    this.methodStack.push(name);
  }

  exitMethodDeclaration(): void {
    this.methodStack.pop();
  }

  enterConstructorDeclaration(context: any): void {
    const name = text(context?.qualifiedName?.()) ?? this.typeStack.at(-1);

    if (!name) {
      return;
    }

    this.symbols.push({
      name,
      kind: "constructor",
      parameters: readParameters(context),
      container: this.typeStack.at(-1),
      ...identifierRange(context.qualifiedName?.() ?? context),
      ...declarationRange(context),
    });
    this.methodStack.push(name);
  }

  exitConstructorDeclaration(): void {
    this.methodStack.pop();
  }

  enterFormalParameter(context: any): void {
    const name = text(context?.id?.());

    if (!name) {
      return;
    }

    this.symbols.push({
      name,
      kind: "parameter",
      type: text(context?.typeRef?.()),
      container: this.container,
      ...identifierRange(context.id()),
      ...declarationRange(context),
    });
  }

  enterFieldDeclaration(context: any): void {
    this.pushVariables(context, "field");
  }

  enterLocalVariableDeclaration(context: any): void {
    this.pushVariables(context, "local");
  }

  enterPropertyDeclaration(context: any): void {
    const name = text(context?.id?.());

    if (!name) {
      return;
    }

    this.symbols.push({
      name,
      kind: "property",
      type: text(context?.typeRef?.()),
      container: this.typeStack.at(-1),
      ...identifierRange(context.id()),
      ...declarationRange(context),
    });
  }

  private pushVariables(context: any, kind: ApexSymbolKind): void {
    const type = text(context?.typeRef?.());
    const declarators: any[] =
      context?.variableDeclarators?.()?.variableDeclarator_list?.() ?? [];

    for (const declarator of declarators) {
      const name = text(declarator?.id?.());

      if (!name) {
        continue;
      }

      this.symbols.push({
        name,
        kind,
        type,
        container: this.container,
        ...identifierRange(declarator.id()),
        ...declarationRange(declarator),
      });
    }
  }
}

function readParameters(context: any): ApexParameter[] {
  const list: any[] =
    context?.formalParameters?.()?.formalParameterList?.()?.formalParameter_list?.() ??
    [];

  return list.flatMap(parameter => {
    const name = text(parameter?.id?.());

    if (!name) {
      return [];
    }

    const range = identifierRange(parameter.id());
    return [
      {
        name,
        type: text(parameter?.typeRef?.()) ?? "Object",
        nameStart: range.nameStart,
        nameEnd: range.nameEnd,
      },
    ];
  });
}

function text(context: any): string | undefined {
  try {
    const value = context?.getText?.();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function identifierRange(context: any): { nameStart: number; nameEnd: number } {
  const start = context?.start?.start ?? 0;
  const stop = context?.stop?.stop ?? start;
  return { nameStart: start, nameEnd: stop + 1 };
}

function declarationRange(context: any): { declStart: number; declEnd: number } {
  const start = context?.start?.start ?? 0;
  const stop = context?.stop?.stop ?? start;
  return { declStart: start, declEnd: stop + 1 };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Every standalone occurrence of `name`, skipping comments and string literals so
 * that rename and reference results never point inside text.
 */
export function findOccurrences(source: string, name: string): number[] {
  const offsets: number[] = [];

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return offsets;
  }

  const masked = maskCommentsAndStrings(source);
  const pattern = new RegExp(`\\b${name}\\b`, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(masked)) !== null) {
    offsets.push(match.index);
  }

  return offsets;
}

/** Replaces comment and string content with spaces, preserving every offset. */
export function maskCommentsAndStrings(source: string): string {
  const characters = [...source];
  let index = 0;

  const hide = (from: number, to: number): void => {
    for (let cursor = from; cursor < to && cursor < characters.length; cursor += 1) {
      if (characters[cursor] !== "\n" && characters[cursor] !== "\r") {
        characters[cursor] = " ";
      }
    }
  };

  while (index < source.length) {
    const two = source.slice(index, index + 2);

    if (two === "//") {
      const end = source.indexOf("\n", index);
      hide(index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }

    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      hide(index, end < 0 ? source.length : end + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }

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

      hide(index, Math.min(cursor + 1, source.length));
      index = cursor + 1;
      continue;
    }

    index += 1;
  }

  return characters.join("");
}

/** The identifier surrounding `offset`, with its bounds. */
export function identifierAt(
  source: string,
  offset: number,
): { name: string; start: number; end: number } | undefined {
  const before = /[A-Za-z_][A-Za-z0-9_]*$/.exec(source.slice(0, offset))?.[0] ?? "";
  const after = /^[A-Za-z0-9_]*/.exec(source.slice(offset))?.[0] ?? "";
  const name = `${before}${after}`;

  if (name.length === 0 || /^[0-9]/.test(name)) {
    return undefined;
  }

  return { name, start: offset - before.length, end: offset + after.length };
}

/**
 * Resolves `name` at `offset` to the declaration an editor should jump to,
 * preferring the innermost scope: locals and parameters of the enclosing method,
 * then members of the enclosing type, then anything else in the file.
 */
export function resolveSymbol(
  model: DocumentModel,
  name: string,
  offset: number,
): ApexSymbol | undefined {
  const candidates = model.symbols.filter(symbol => symbol.name === name);

  if (candidates.length === 0) {
    return undefined;
  }

  const method = model.symbols.find(
    symbol =>
      (symbol.kind === "method" || symbol.kind === "constructor") &&
      symbol.declStart <= offset &&
      offset <= symbol.declEnd,
  );

  if (method) {
    const scoped = candidates.find(
      symbol =>
        (symbol.kind === "local" || symbol.kind === "parameter") &&
        symbol.container === method.name,
    );

    if (scoped) {
      return scoped;
    }
  }

  const rank: Record<ApexSymbolKind, number> = {
    parameter: 0,
    local: 1,
    property: 2,
    field: 3,
    method: 4,
    constructor: 5,
    class: 6,
    interface: 7,
    enum: 8,
  };

  return [...candidates].sort((left, right) => rank[left.kind] - rank[right.kind])[0];
}

/** A human-readable signature, used for hover text and outline detail. */
export function describeSymbol(symbol: ApexSymbol): string {
  if (symbol.kind === "method" || symbol.kind === "constructor") {
    const parameters = (symbol.parameters ?? [])
      .map(parameter => `${parameter.type} ${parameter.name}`)
      .join(", ");
    const returnType = symbol.kind === "method" ? `${symbol.type ?? "void"} ` : "";
    return `${returnType}${symbol.name}(${parameters})`;
  }

  if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum") {
    return `${symbol.kind} ${symbol.name}`;
  }

  return `${symbol.type ?? "Object"} ${symbol.name}`;
}
