import {
  ApexErrorListener,
  ApexParserFactory,
} from "@apexdevtools/apex-parser";
import type {
  ApexXDiagnostic,
  ApexXParseResult,
  FilterLambdaExpression,
  FuncInvocation,
  FuncLambdaAssignment,
  ListMethodCallExpression,
  ListMethodName,
  ListMethodCallStep,
  LambdaParameter,
  SourceRange,
} from "@apexx/ast";
import { createRange, isApexIdentifier } from "@apexx/semantics";

const returnStatementPattern = /^([ \t]*)return\s+/gm;
const assignmentStatementPattern =
  /^([ \t]*)((?:[A-Za-z][A-Za-z0-9_.]*(?:\s*<\s*[^>\r\n]+\s*>)?)\s+([A-Za-z][A-Za-z0-9_]*))\s*=\s*/gm;
const expressionStatementPattern = /^([ \t]*)([A-Za-z][A-Za-z0-9_]*)/gm;
const funcLambdaAssignmentPattern =
  /^([ \t]*)(Func\s*<\s*((?:[^<>\r\n]|<(?:[^<>\r\n]|<[^<>\r\n]*>)*>)+)\s*>)\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\([^)\r\n]*\)|[A-Za-z][A-Za-z0-9_]*)\s*=>(?!\s*\{)\s*([\s\S]*?)\s*;[ \t]*(?=\r?$)/gm;
const funcBlockLambdaAssignmentPattern =
  /^([ \t]*)(Func\s*<\s*((?:[^<>\r\n]|<(?:[^<>\r\n]|<[^<>\r\n]*>)*>)+)\s*>)\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\([^)\r\n]*\)|[A-Za-z][A-Za-z0-9_]*)\s*=>\s*(?=\{)/gm;
const funcLambdaReassignmentPattern =
  /^([ \t]*)([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\([^)\r\n]*\)|[A-Za-z][A-Za-z0-9_]*)\s*=>(?!\s*\{)\s*([\s\S]*?)\s*;[ \t]*(?=\r?$)/gm;
const funcBlockLambdaReassignmentPattern =
  /^([ \t]*)([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\([^)\r\n]*\)|[A-Za-z][A-Za-z0-9_]*)\s*=>\s*(?=\{)/gm;

export interface ApexParseResult {
  ok: boolean;
  diagnostics: ApexXDiagnostic[];
}

class CollectingErrorListener extends ApexErrorListener {
  readonly diagnostics: ApexXDiagnostic[] = [];
  private readonly lineStarts: number[];

  constructor(private readonly source: string) {
    super();
    this.lineStarts = [0];

    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\n") {
        this.lineStarts.push(index + 1);
      }
    }
  }

  apexSyntaxError(line: number, column: number, message: string): void {
    // Recovery from a syntax error invents its own follow-on errors, so only the
    // first is reported. The rest describe the parser's confusion, not the code.
    if (this.diagnostics.length > 0) {
      return;
    }

    const lineStart = this.lineStarts[line - 1] ?? 0;
    const start = Math.min(lineStart + column, this.source.length);
    const end = Math.min(tokenEnd(this.source, start), this.source.length);

    this.diagnostics.push({
      severity: "error",
      source: "apex-parser",
      message: simplifyParseMessage(message),
      // A real offset, because a diagnostic about generated Apex is mapped back to
      // the authored source by offset before anyone sees it.
      range: {
        start: { offset: start, line, column },
        end: { offset: end, line, column: column + Math.max(end - start, 1) },
      },
    });
  }
}

/** The end of the token at `start`, so an error underlines a word and not one character. */
function tokenEnd(source: string, start: number): number {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(start));
  return start + Math.max(identifier?.[0].length ?? 1, 1);
}

/**
 * Rewrites an ANTLR message into something a reader can act on.
 *
 * The generated messages quote the input verbatim -- newlines included -- and
 * enumerate every token the grammar would have accepted, which for a statement
 * position is over two thousand characters of keywords. The information a reader
 * needs is what was unexpected, and at most a hint of what would have fitted.
 */
export function simplifyParseMessage(message: string): string {
  const expected = /^(.*?)\s*expecting\s*\{?(.*?)\}?$/s.exec(message);
  const head = collapse(expected ? expected[1] : message);
  const alternatives = expected
    ? expected[2].split(",").map(entry => entry.trim()).filter(Boolean)
    : [];

  const endOfFile = /'<EOF>'/.test(head);
  const subject = endOfFile
    ? "Unexpected end of file"
    : head
      .replace(/^mismatched input/, "Unexpected")
      .replace(/^extraneous input/, "Unexpected")
      .replace(/^no viable alternative at input/, "Cannot parse")
      .replace(/^missing (.*?) at/, "Missing $1 before");

  if (endOfFile) {
    return `${subject}: the last statement looks incomplete.`;
  }

  // A short list of alternatives is a genuine hint; a long one is the grammar
  // reciting itself.
  if (alternatives.length > 0 && alternatives.length <= 4) {
    const readable = alternatives.map(entry =>
      entry === "'<EOF>'" || entry === '<EOF>' ? 'end of file' : entry,
    );
    return `${subject}, expected ${readable.join(' or ')}.`;
  }

  return `${subject}.`;
}

/**
 * One line, with the quoted input kept only while it is worth quoting.
 *
 * ANTLR echoes the offending input with its line breaks escaped. A quotation that
 * spans lines is the whole statement read back to its author, which says less than
 * naming the position does, so it is dropped.
 */
function collapse(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();

  return flattened.replace(/'([^']*)'/g, (match, inner: string) => {
    if (/\\[rn]/.test(inner)) {
      return "this statement";
    }

    return inner.length > 40 ? `'${inner.slice(0, 40).trimEnd()}…'` : match;
  });
}

export interface ParseApexOptions {
  /**
   * Parse as an anonymous block rather than a compilation unit. An anonymous
   * block is a sequence of statements and block-level declarations, so the
   * compilation-unit rule rejects every script on its first statement.
   */
  anonymous?: boolean;
}

export function parseApex(
  source: string,
  options: ParseApexOptions = {},
): ApexParseResult {
  const listener = new CollectingErrorListener(source);
  const { parser } = ApexParserFactory.createLexerAndParser(source, listener);

  if (options.anonymous) {
    parser.anonymousUnit();
  } else {
    parser.compilationUnit();
  }

  return {
    ok: listener.diagnostics.length === 0,
    diagnostics: listener.diagnostics,
  };
}

export function parseApexX(source: string, fileName?: string): ApexXParseResult {
  const { calls: listMethodCalls, rejections: embeddedRejections } =
    findListMethodCallsWithRejections(source);
  const funcLambdaAssignments = findFuncLambdaAssignments(source);
  const funcVariableNames = new Set(
    funcLambdaAssignments.map(assignment => assignment.variableName),
  );
  const funcInvocations = findFuncInvocations(source, funcVariableNames);
  const diagnostics: ApexXDiagnostic[] = [];

  for (const call of listMethodCalls) {
    for (const step of call.steps) {
      if (!isApexIdentifier(step.lambda.parameterName)) {
        diagnostics.push({
          severity: "error",
          source: "apexx-parser",
          message: `Invalid lambda parameter name '${step.lambda.parameterName}'.`,
          range: step.lambda.range,
        });
      }
    }
  }

  for (const assignment of funcLambdaAssignments) {
    for (const parameter of assignment.lambda.parameters) {
      if (!isApexIdentifier(parameter.name)) {
        diagnostics.push({
          severity: "error",
          source: "apexx-parser",
          message: `Invalid lambda parameter name '${parameter.name}'.`,
          range: parameter.range,
        });
      }
    }

    // A tuple inside a Func type argument is reasonable to write and is not
    // supported: the Func interface would need the tuple's generated carrier as
    // its return or parameter type, and nothing resolves it there, so lowering
    // emits `invoke` returning `(Integer, Integer)` and the Apex parser rejects
    // it with a message pointing at the wrong place. Say so here instead.
    const tupleTypeArgument = [
      ...assignment.parameterTypes,
      assignment.returnType,
    ].find(type => type.trim().startsWith("("));

    if (tupleTypeArgument !== undefined) {
      const offset = assignment.originalText.indexOf(tupleTypeArgument);

      diagnostics.push({
        severity: "error",
        source: "apexx-parser",
        message:
          `A Func type argument cannot be a tuple type yet: '${tupleTypeArgument}'. `
          + "A tuple can hold a Func, but a Func cannot yet return or accept one. "
          + "Return a wrapper class, or use one Func per value.",
        range: offset < 0
          ? assignment.range
          : createRange(
            source,
            assignment.range.start.offset + offset,
            assignment.range.start.offset + offset + tupleTypeArgument.length,
          ),
      });
      continue;
    }

    const expectedParameterCount = assignment.parameterTypes.length;
    const actualParameterCount = assignment.lambda.parameters.length;

    if (!assignment.isReassignment && expectedParameterCount !== actualParameterCount) {
      diagnostics.push({
        severity: "error",
        source: "apexx-parser",
        message: `Func expects ${expectedParameterCount} lambda parameter(s), but got ${actualParameterCount}.`,
        range: assignment.lambda.range,
      });
    }
  }

  const maskedForDiagnostics = maskLiterals(source);

  for (const match of source.matchAll(/=>/g)) {
    const offset = match.index ?? 0;
    const isListMethodCall = listMethodCalls.some(
      call =>
        offset >= call.range.start.offset && offset < call.range.end.offset,
    );
    const isFuncAssignment = funcLambdaAssignments.some(
      assignment =>
        offset >= assignment.range.start.offset &&
        offset < assignment.range.end.offset,
    );

    if (!isListMethodCall && !isFuncAssignment) {
      // A nested chain is normally hoisted above its statement. Where that would change
      // when the chain runs, it is refused instead -- and the reason matters, because
      // "move it to a local" is the fix for all of them but for different causes.
      const rejection = embeddedRejections.find(
        candidate =>
          offset >= candidate.range.start.offset && offset < candidate.range.end.offset,
      );

      const enclosing = rejection
        ? undefined
        : enclosingListMethodCall(source, offset);

      diagnostics.push({
        severity: "error",
        source: "apexx-parser",
        message: rejection
          ? EMBEDDED_REJECTION_MESSAGES[rejection.reason]
          : enclosing
            ? readIdentifierEndingAt(source, maskedForDiagnostics, enclosing.dotOffset)
              ? "An ApexX List<T> call has to be reachable as a statement so its loop can be placed. Assign this chain to a local first and use that."
              : "The receiver of an ApexX List<T> call has to be a local variable declared as List<T> in this file. A field, a property or another call's result is not resolved yet -- assign it to a local first."
            : "Unsupported lambda form. v0.1 supports lambdas in Func assignments and ApexX List<T> methods.",
        range: createRange(source, offset, offset + match[0].length),
      });
    }
  }

  return {
    source,
    fileName,
    listMethodCalls,
    funcLambdaAssignments,
    funcInvocations,
    filters: listMethodCalls,
    diagnostics,
  };
}

export function findFuncLambdaAssignments(
  source: string,
): FuncLambdaAssignment[] {
  const assignments: FuncLambdaAssignment[] = [];

  for (const [pattern, isBlock] of [
    [funcBlockLambdaAssignmentPattern, true],
    [funcLambdaAssignmentPattern, false],
  ] as const) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const matchText = isBlock
        ? blockLambdaText(source, start, match[0])
        : match[0];

      if (matchText === undefined) {
        continue;
      }

      const sourceFuncType = match[2].replace(/\s+/g, " ").trim();
      const typeArguments = splitCommaList(match[3]);
      const parameterTypes = typeArguments.slice(0, -1);
      const returnType = typeArguments.at(-1) ?? "void";
      const parameterListStart = parameterTextStart(start, matchText, match[5]);
      const parameters = parseLambdaParameters(
        source,
        parameterListStart,
        match[5],
      );
      const bodyStart = matchText.indexOf("=>") + 2 + start;
      const bodyEnd = start + matchText.replace(/[ \t]*;?[ \t]*$/, "").length;

      assignments.push({
        kind: "funcLambdaAssignment",
        indent: match[1],
        sourceFuncType,
        parameterTypes,
        returnType,
        variableName: match[4],
        lambda: {
          parameterName: parameters[0]?.name ?? "",
          parameters,
          body: trimmedText(source, bodyStart, bodyEnd),
          bodyRange: trimmedRange(source, bodyStart, bodyEnd),
          range: createRange(source, parameterListStart, bodyEnd),
        },
        originalText: matchText,
        range: createRange(source, start, start + matchText.length),
      });
    }
  }

  for (const [pattern, isBlock] of [
    [funcBlockLambdaReassignmentPattern, true],
    [funcLambdaReassignmentPattern, false],
  ] as const) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const matchText = isBlock
        ? blockLambdaText(source, start, match[0])
        : match[0];

      if (matchText === undefined) {
        continue;
      }

      if (rangesOverlapExistingAssignment(assignments, start, start + matchText.length)) {
        continue;
      }

      const parameterListStart = parameterTextStart(start, matchText, match[3]);
      const parameters = parseLambdaParameters(
        source,
        parameterListStart,
        match[3],
      );
      const bodyStart = matchText.indexOf("=>") + 2 + start;
      const bodyEnd = start + matchText.replace(/[ \t]*;[ \t]*$/, "").length;

      assignments.push({
        kind: "funcLambdaAssignment",
        indent: match[1],
        sourceFuncType: "",
        parameterTypes: [],
        returnType: "Object",
        variableName: match[2],
        isReassignment: true,
        lambda: {
          parameterName: parameters[0]?.name ?? "",
          parameters,
          body: trimmedText(source, bodyStart, bodyEnd),
          bodyRange: trimmedRange(source, bodyStart, bodyEnd),
          range: createRange(source, parameterListStart, bodyEnd),
        },
        originalText: matchText,
        range: createRange(source, start, start + matchText.length),
      });
    }
  }

  return assignments.sort((left, right) => left.range.start.offset - right.range.start.offset);
}

/**
 * Extends a block-lambda prefix match over its body, from the `{` the prefix stops at to
 * the matching `}` and the `;` that must follow.
 *
 * The body is found by matching braces rather than by regex. A regex has to anchor the
 * closing brace somewhere -- the previous one required it at the start of a line, which
 * quietly meant a one-line block body was not a lambda at all.
 */
function blockLambdaText(
  source: string,
  start: number,
  prefix: string,
): string | undefined {
  const openBrace = start + prefix.length;

  if (source[openBrace] !== "{") {
    return undefined;
  }

  const closeBrace = findMatchingDelimiter(source, openBrace, "{", "}");

  if (closeBrace === undefined) {
    return undefined;
  }

  const semicolon = skipWhitespace(source, closeBrace + 1);

  if (source[semicolon] !== ";") {
    return undefined;
  }

  return source.slice(start, semicolon + 1);
}

/** The bounds of `[start, end)` with surrounding whitespace removed. */
function trimmedBounds(
  source: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let from = start;
  let to = end;

  while (from < to && /\s/.test(source[from] ?? "")) {
    from += 1;
  }

  while (to > from && /\s/.test(source[to - 1] ?? "")) {
    to -= 1;
  }

  return { start: from, end: to };
}

function trimmedText(source: string, start: number, end: number): string {
  const bounds = trimmedBounds(source, start, end);
  return source.slice(bounds.start, bounds.end);
}

function trimmedRange(source: string, start: number, end: number): SourceRange {
  const bounds = trimmedBounds(source, start, end);
  return createRange(source, bounds.start, bounds.end);
}

function rangesOverlapExistingAssignment(
  assignments: FuncLambdaAssignment[],
  start: number,
  end: number,
): boolean {
  return assignments.some(
    assignment =>
      start >= assignment.range.start.offset &&
      end <= assignment.range.end.offset,
  );
}

export function findFuncInvocations(
  source: string,
  funcVariableNames: Set<string>,
): FuncInvocation[] {
  const invocations: FuncInvocation[] = [];
  let cursor = 0;
  let state: "code" | "lineComment" | "blockComment" | "string" = "code";

  while (cursor < source.length) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (state === "code" && current === "/" && next === "/") {
      cursor += 2;
      state = "lineComment";
      continue;
    }

    if (state === "code" && current === "/" && next === "*") {
      cursor += 2;
      state = "blockComment";
      continue;
    }

    if (state === "code" && current === "'") {
      cursor += 1;
      state = "string";
      continue;
    }

    if (state === "lineComment") {
      cursor += 1;
      if (current === "\n") {
        state = "code";
      }
      continue;
    }

    if (state === "blockComment") {
      if (current === "*" && next === "/") {
        cursor += 2;
        state = "code";
      } else {
        cursor += 1;
      }
      continue;
    }

    if (state === "string") {
      if (current === "\\" && next) {
        cursor += 2;
      } else {
        cursor += 1;
        if (current === "'") {
          state = "code";
        }
      }
      continue;
    }

    if (!isIdentifierStart(current ?? "")) {
      cursor += 1;
      continue;
    }

    const identifier = readIdentifier(source, cursor);
    if (!identifier) {
      cursor += 1;
      continue;
    }

    const openParen = skipWhitespace(source, identifier.endOffset);
    const previous = previousNonWhitespace(source, identifier.startOffset);

    if (
      (funcVariableNames.has(identifier.name) ||
        funcVariableNames.has(identifier.name.toLowerCase())) &&
      previous !== "." &&
      source[openParen] === "("
    ) {
      const closeParen = findMatchingParen(source, openParen);

      if (closeParen !== undefined) {
        invocations.push({
          kind: "funcInvocation",
          variableName: identifier.name,
          argumentsText: source.slice(openParen + 1, closeParen),
          originalText: source.slice(identifier.startOffset, closeParen + 1),
          range: createRange(source, identifier.startOffset, closeParen + 1),
        });
        cursor = closeParen + 1;
        continue;
      }
    }

    cursor = identifier.endOffset;
  }

  return invocations;
}

export function findListMethodCalls(
  source: string,
): ListMethodCallExpression[] {
  return findListMethodCallsWithRejections(source).calls;
}

/** The three passes for a chain that is a statement in its own right. */
function findStatementListMethodCalls(
  source: string,
): ListMethodCallExpression[] {
  const calls: ListMethodCallExpression[] = [];

  for (const match of source.matchAll(assignmentStatementPattern)) {
    const start = match.index ?? 0;
    const expressionStart = start + match[0].length;
    const chain = parseListMethodChain(source, expressionStart);

    // Only when the chain is the whole statement. `list.filter(...).size()` continues
    // past the chain, so claiming it here would splice the trailing call away; the
    // embedded pass hoists that one instead.
    if (!chain || !chain.terminated) {
      continue;
    }

    calls.push({
      kind: "listMethodCall",
      statementKind: "assignment",
      indent: match[1],
      targetType: match[2].replace(/\s+/g, " ").trim(),
      targetName: match[3],
      receiver: chain.receiver,
      parameterName: chain.steps[0].lambda.parameterName,
      predicate: chain.steps[0].lambda.body,
      steps: chain.steps,
      originalText: source.slice(start, chain.endOffset),
      range: createRange(source, start, chain.endOffset),
    });
  }

  for (const match of source.matchAll(returnStatementPattern)) {
    const start = match.index ?? 0;
    const expressionStart = start + match[0].length;
    const chain = parseListMethodChain(source, expressionStart);

    // Only when the chain is the whole statement. `list.filter(...).size()` continues
    // past the chain, so claiming it here would splice the trailing call away; the
    // embedded pass hoists that one instead.
    if (!chain || !chain.terminated) {
      continue;
    }

    if (calls.some(call => rangesOverlap(call.range.start.offset, call.range.end.offset, start, chain.endOffset))) {
      continue;
    }

    calls.push({
      kind: "listMethodCall",
      statementKind: "return",
      indent: match[1],
      receiver: chain.receiver,
      parameterName: chain.steps[0].lambda.parameterName,
      predicate: chain.steps[0].lambda.body,
      steps: chain.steps,
      originalText: source.slice(start, chain.endOffset),
      range: createRange(source, start, chain.endOffset),
    });
  }

  for (const match of source.matchAll(expressionStatementPattern)) {
    const start = match.index ?? 0;
    const expressionStart = start + match[1].length;
    const chain = parseListMethodChain(source, expressionStart);

    // Only when the chain is the whole statement. `list.filter(...).size()` continues
    // past the chain, so claiming it here would splice the trailing call away; the
    // embedded pass hoists that one instead.
    if (!chain || !chain.terminated) {
      continue;
    }

    if (calls.some(call => rangesOverlap(call.range.start.offset, call.range.end.offset, start, chain.endOffset))) {
      continue;
    }

    calls.push({
      kind: "listMethodCall",
      statementKind: "expression",
      indent: match[1],
      receiver: chain.receiver,
      parameterName: chain.steps[0].lambda.parameterName,
      predicate: chain.steps[0].lambda.body,
      steps: chain.steps,
      originalText: source.slice(start, chain.endOffset),
      range: createRange(source, start, chain.endOffset),
    });
  }

  return calls;
}

const EMBEDDED_REJECTION_MESSAGES: Record<EmbeddedChainRejection["reason"], string> = {
  conditional:
    "An ApexX List<T> call cannot sit after '&&', '||' or in a ternary arm. It lowers to a loop placed before the statement, which would run it even when the condition says it should not. Assign it to a local first and test that.",
  header:
    "An ApexX List<T> call cannot sit in the header of an if, for, while or switch. It lowers to a loop, and there is nowhere before the header to put one. Assign it to a local first and use that.",
  multiple:
    "Only one ApexX List<T> call can be nested in a single statement, because each one rewrites that whole statement. Assign one of them to a local first.",
};

/** Why a nested chain could not be hoisted, so the diagnostic can say which it was. */
export interface EmbeddedChainRejection {
  reason: "conditional" | "header" | "multiple";
  range: SourceRange;
}

export function findListMethodCallsWithRejections(source: string): {
  calls: ListMethodCallExpression[];
  rejections: EmbeddedChainRejection[];
} {
  const calls: ListMethodCallExpression[] = [];
  const rejections: EmbeddedChainRejection[] = [];

  for (const call of findStatementListMethodCalls(source)) {
    calls.push(call);
  }

  collectEmbeddedListMethodCalls(source, calls, rejections);
  calls.sort((left, right) => left.range.start.offset - right.range.start.offset);

  return { calls, rejections };
}

/**
 * Finds chains nested inside a larger statement, such as `System.debug(l.filter(...))`.
 *
 * The three passes above each anchor on a statement that *is* a chain. A chain lowers to
 * a loop, and a loop cannot be written inside an argument list, so a nested one is
 * handled by hoisting: the loop is emitted before the statement and the chain is
 * replaced by the name holding its result. That is only sound where the chain would have
 * been evaluated unconditionally anyway, which is what the guards below check.
 */
function collectEmbeddedListMethodCalls(
  source: string,
  calls: ListMethodCallExpression[],
  rejections: EmbeddedChainRejection[],
): void {
  const masked = maskLiterals(source);

  interface Candidate {
    receiverStart: number;
    chainEnd: number;
    chain: ParsedListMethodChain;
    statement: { start: number; end: number };
  }

  const byStatement = new Map<number, Candidate[]>();

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (masked[cursor] !== ".") {
      continue;
    }

    const methodName = readListMethodNameAt(source, cursor);

    if (!methodName) {
      continue;
    }

    // The receiver is the identifier immediately before the dot, which is the only
    // receiver shape the element-type lookup can resolve.
    const receiver = readIdentifierEndingAt(source, masked, cursor);

    if (!receiver) {
      continue;
    }

    const chain = parseListMethodChain(source, receiver.startOffset);

    if (!chain) {
      continue;
    }

    if (
      calls.some(call =>
        rangesOverlap(
          call.range.start.offset,
          call.range.end.offset,
          receiver.startOffset,
          chain.endOffset,
        ),
      )
    ) {
      continue;
    }

    const placement = findEnclosingStatement(masked, receiver.startOffset);

    if (!placement.statement) {
      if (placement.reason) {
        rejections.push({
          reason: placement.reason,
          range: createRange(source, receiver.startOffset, chain.endOffset),
        });
      }

      cursor = chain.endOffset;
      continue;
    }

    const group = byStatement.get(placement.statement.start) ?? [];
    group.push({
      receiverStart: receiver.startOffset,
      chainEnd: chain.endOffset,
      chain,
      statement: placement.statement,
    });
    byStatement.set(placement.statement.start, group);
    cursor = chain.endOffset;
  }

  for (const group of byStatement.values()) {
    // Each hoist rewrites the whole statement, and the transformation model splices a
    // span once, so two chains in one statement would each drop the other's rewrite.
    if (group.length > 1) {
      for (const candidate of group) {
        rejections.push({
          reason: "multiple",
          range: createRange(source, candidate.receiverStart, candidate.chainEnd),
        });
      }

      continue;
    }

    const [candidate] = group;
    const { statement, chain } = candidate;
    // The generated loop is indented like the line the statement sits on, which is not
    // the same as the text before the statement: `for (...) { System.debug(...); }` puts
    // the statement mid-line, and slicing from there would indent the loop by nothing.
    const lineStart = source.lastIndexOf("\n", statement.start - 1) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
    const indentLength =
      /^[ \t]*/.exec(source.slice(statement.start, statement.end))?.[0].length ?? 0;
    const bodyStart = statement.start + indentLength;

    calls.push({
      kind: "listMethodCall",
      statementKind: "embedded",
      indent,
      receiver: chain.receiver,
      parameterName: chain.steps[0].lambda.parameterName,
      predicate: chain.steps[0].lambda.body,
      steps: chain.steps,
      embedded: {
        statementText: source.slice(bodyStart, statement.end),
        chainStart: candidate.receiverStart - bodyStart,
        chainEnd: candidate.chainEnd - bodyStart,
      },
      originalText: source.slice(statement.start, statement.end),
      range: createRange(source, statement.start, statement.end),
    });
  }
}

function findEnclosingStatement(
  masked: string,
  offset: number,
): {
  statement?: { start: number; end: number };
  reason?: EmbeddedChainRejection["reason"];
} {
  let depth = 0;
  let afterDelimiter = 0;

  for (let cursor = offset - 1; cursor >= 0; cursor -= 1) {
    const character = masked[cursor];

    if (character === ")" || character === "]") {
      depth += 1;
      continue;
    }

    if (character === "(" || character === "[") {
      // An unmatched opener is the call the chain is nested in, not a bracket to pair.
      if (depth > 0) {
        depth -= 1;
      }

      continue;
    }

    if (depth === 0 && (character === ";" || character === "{" || character === "}")) {
      afterDelimiter = cursor + 1;
      break;
    }
  }

  const before = masked.slice(afterDelimiter, offset);

  // A chain in a control statement's header has no statement to be hoisted above, and
  // hoisting out of a loop header would change how often it runs.
  if (/\b(if|for|while|switch|when|do|catch)\s*\(/.test(before)) {
    return { reason: "header" };
  }

  // After `&&`, `||` or a ternary arm the chain may never run. Hoisting it would make it
  // always run, which changes behaviour rather than just where the loop sits.
  if (/(&&|\|\||\?|:)/.test(before)) {
    return { reason: "conditional" };
  }

  let depthForward = 0;
  let end: number | undefined;

  for (let cursor = offset; cursor < masked.length; cursor += 1) {
    const character = masked[cursor];

    if (character === "(" || character === "[") {
      depthForward += 1;
      continue;
    }

    if (character === ")" || character === "]") {
      depthForward -= 1;
      continue;
    }

    // Negative depth means the scan has climbed out of the call the chain sits in, so
    // the statement's own terminator is the next `;` at or above that level.
    if (depthForward <= 0 && character === ";") {
      end = cursor + 1;
      break;
    }

    if (depthForward <= 0 && (character === "{" || character === "}")) {
      return {};
    }
  }

  if (end === undefined) {
    return {};
  }

  // Take the statement from the start of its own line when only indentation precedes it,
  // so the generated loop lines up with the code it replaces.
  const first = skipWhitespace(masked, afterDelimiter);

  if (first >= end) {
    return {};
  }

  const lineStart = masked.lastIndexOf("\n", first - 1) + 1;
  const start = masked.slice(lineStart, first).trim().length === 0 ? lineStart : first;

  return { statement: { start, end } };
}

/**
 * The identifier that ends at `endOffset`, ignoring whitespace in between.
 *
 * Whitespace has to be skipped because a chain is commonly broken across lines with the
 * receiver on its own -- `numbers\n    .filter(...)`. Scanned over the masked source so
 * a comment between the receiver and the dot reads as the whitespace it is.
 */
function readIdentifierEndingAt(
  source: string,
  masked: string,
  endOffset: number,
): IdentifierToken | undefined {
  let end = endOffset;

  while (end > 0 && /\s/.test(masked[end - 1] ?? "")) {
    end -= 1;
  }

  let start = end;

  while (start > 0 && isIdentifierPart(masked[start - 1] ?? "")) {
    start -= 1;
  }

  if (start === end || !isIdentifierStart(masked[start] ?? "")) {
    return undefined;
  }

  // `a.b.filter(...)` and `f().filter(...)` are receivers the element-type lookup cannot
  // resolve, so they are left alone rather than half-handled.
  const previous = previousNonWhitespace(masked, start);

  if (previous === "." || previous === ")" || previous === "]") {
    return undefined;
  }

  return { name: source.slice(start, end), startOffset: start, endOffset: end };
}

/**
 * The source with the contents of strings and comments replaced by spaces, so that
 * scanning for brackets and semicolons cannot be fooled by one that is only text.
 * Offsets and line structure are preserved.
 */
function maskLiterals(source: string): string {
  const characters = source.split("");
  let state: "code" | "lineComment" | "blockComment" | "string" = "code";
  let cursor = 0;

  const blank = (at: number): void => {
    if (characters[at] !== "\n") {
      characters[at] = " ";
    }
  };

  while (cursor < source.length) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (state === "code") {
      if (current === "/" && next === "/") {
        blank(cursor);
        blank(cursor + 1);
        cursor += 2;
        state = "lineComment";
        continue;
      }

      if (current === "/" && next === "*") {
        blank(cursor);
        blank(cursor + 1);
        cursor += 2;
        state = "blockComment";
        continue;
      }

      if (current === "'") {
        blank(cursor);
        cursor += 1;
        state = "string";
        continue;
      }

      cursor += 1;
      continue;
    }

    if (state === "lineComment") {
      if (current === "\n") {
        state = "code";
      } else {
        blank(cursor);
      }

      cursor += 1;
      continue;
    }

    if (state === "blockComment") {
      blank(cursor);

      if (current === "*" && next === "/") {
        blank(cursor + 1);
        cursor += 2;
        state = "code";
        continue;
      }

      cursor += 1;
      continue;
    }

    // string
    if (current === "\\" && next !== undefined) {
      blank(cursor);
      blank(cursor + 1);
      cursor += 2;
      continue;
    }

    blank(cursor);
    cursor += 1;

    if (current === "'") {
      state = "code";
    }
  }

  return characters.join("");
}

export function findFilterLambdaExpressions(
  source: string,
): FilterLambdaExpression[] {
  return findListMethodCalls(source);
}

interface ParsedListMethodChain {
  receiver: string;
  steps: ListMethodCallStep[];
  endOffset: number;
  /** Whether a `;` closed the chain, i.e. the chain really was the whole statement. */
  terminated: boolean;
}

interface IdentifierToken {
  name: string;
  startOffset: number;
  endOffset: number;
}

function parseListMethodChain(
  source: string,
  startOffset: number,
): ParsedListMethodChain | undefined {
  let cursor = skipWhitespace(source, startOffset);
  const receiver = readIdentifier(source, cursor);
  const steps: ListMethodCallStep[] = [];

  if (!receiver) {
    return undefined;
  }

  cursor = receiver.endOffset;

  while (true) {
    const methodStart = skipWhitespace(source, cursor);
    const methodName = readListMethodNameAt(source, methodStart);

    if (!methodName) {
      break;
    }

    cursor = methodStart + 1 + methodName.length;
    cursor = skipWhitespace(source, cursor);

    if (source[cursor] !== "(") {
      return undefined;
    }

    cursor += 1;
    cursor = skipWhitespace(source, cursor);

    // The parameter may be bare, `i => ...`, or parenthesised, `(i) => ...`. A Func
    // assignment has always taken both, and nothing about a List<T> method makes the
    // parenthesised form mean anything different, so it is accepted here too.
    const parenthesized = source[cursor] === "(";

    if (parenthesized) {
      cursor = skipWhitespace(source, cursor + 1);
    }

    const parameter = readIdentifier(source, cursor);
    if (!parameter) {
      return undefined;
    }

    cursor = skipWhitespace(source, parameter.endOffset);

    if (parenthesized) {
      if (source[cursor] !== ")") {
        return undefined;
      }

      cursor = skipWhitespace(source, cursor + 1);
    }

    if (!source.startsWith("=>", cursor)) {
      return undefined;
    }

    const bodyStart = cursor + 2;
    const bodyEnd = findLambdaBodyEnd(source, bodyStart);
    if (bodyEnd === undefined) {
      return undefined;
    }

    const callEnd = bodyEnd + 1;
    steps.push({
      methodName,
      lambda: {
        parameterName: parameter.name,
        parameters: [
          {
            name: parameter.name,
            range: createRange(source, parameter.startOffset, parameter.endOffset),
          },
        ],
        body: trimmedText(source, bodyStart, bodyEnd),
        bodyRange: trimmedRange(source, bodyStart, bodyEnd),
        range: createRange(source, parameter.startOffset, bodyEnd),
      },
      range: createRange(source, methodStart, callEnd),
    });

    cursor = callEnd;
  }

  if (steps.length === 0) {
    return undefined;
  }

  cursor = skipHorizontalWhitespace(source, cursor);
  let terminated = source[cursor] === ";";

  if (terminated) {
    cursor += 1;
  } else {
    // A chain still ends the statement when nothing but the end of a block follows it,
    // which is how it looks mid-edit before the `;` has been typed. What must not count
    // is more expression -- `.size()` or a closing `)` -- because the chain is then part
    // of something larger and the embedded pass has to hoist it instead.
    const next = skipWhitespace(source, cursor);
    terminated = next >= source.length || source[next] === "}";
  }

  return {
    receiver: receiver.name,
    steps,
    endOffset: cursor,
    terminated,
  };
}

/**
 * Whether this arrow sits in the argument list of an ApexX List<T> method -- that is,
 * whether the lambda itself is fine and only its surroundings are not.
 */
function enclosingListMethodCall(
  source: string,
  arrowOffset: number,
): { dotOffset: number; methodName: ListMethodName } | undefined {
  for (let cursor = arrowOffset; cursor >= 0; cursor -= 1) {
    if (source[cursor] !== ".") {
      continue;
    }

    const methodName = readListMethodNameAt(source, cursor);

    if (!methodName) {
      continue;
    }

    const openParen = skipWhitespace(source, cursor + 1 + methodName.length);

    if (source[openParen] !== "(") {
      continue;
    }

    const closeParen = findMatchingParen(source, openParen);

    if (closeParen !== undefined && arrowOffset > openParen && arrowOffset < closeParen) {
      return { dotOffset: cursor, methodName };
    }
  }

  return undefined;
}

function readListMethodNameAt(
  source: string,
  offset: number,
): ListMethodName | undefined {
  if (source[offset] !== ".") {
    return undefined;
  }

  for (const methodName of ["flatMap", "filter", "count", "find", "map", "any", "all"] as const) {
    const nameStart = offset + 1;
    const nameEnd = nameStart + methodName.length;

    if (
      source.slice(nameStart, nameEnd) === methodName &&
      !isIdentifierPart(source[nameEnd] ?? "")
    ) {
      return methodName;
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

function findMatchingParen(
  source: string,
  openParenOffset: number,
): number | undefined {
  return findMatchingDelimiter(source, openParenOffset, "(", ")");
}

/**
 * The delimiter closing the one at `openOffset`, skipping any in strings or comments.
 */
function findMatchingDelimiter(
  source: string,
  openOffset: number,
  open: string,
  close: string,
): number | undefined {
  let cursor = openOffset + 1;
  let depth = 1;
  let state: "code" | "lineComment" | "blockComment" | "string" = "code";

  while (cursor < source.length) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (state === "code" && current === "/" && next === "/") {
      cursor += 2;
      state = "lineComment";
      continue;
    }

    if (state === "code" && current === "/" && next === "*") {
      cursor += 2;
      state = "blockComment";
      continue;
    }

    if (state === "code" && current === "'") {
      cursor += 1;
      state = "string";
      continue;
    }

    if (state === "lineComment") {
      cursor += 1;
      if (current === "\n") {
        state = "code";
      }
      continue;
    }

    if (state === "blockComment") {
      if (current === "*" && next === "/") {
        cursor += 2;
        state = "code";
      } else {
        cursor += 1;
      }
      continue;
    }

    if (state === "string") {
      if (current === "\\" && next) {
        cursor += 2;
      } else {
        cursor += 1;
        if (current === "'") {
          state = "code";
        }
      }
      continue;
    }

    if (current === open) {
      depth += 1;
    } else if (current === close) {
      depth -= 1;

      if (depth === 0) {
        return cursor;
      }
    }

    cursor += 1;
  }

  return undefined;
}

function readIdentifier(
  source: string,
  startOffset: number,
): IdentifierToken | undefined {
  const match = /^[A-Za-z][A-Za-z0-9_]*/.exec(source.slice(startOffset));

  if (!match) {
    return undefined;
  }

  return {
    name: match[0],
    startOffset,
    endOffset: startOffset + match[0].length,
  };
}

function skipWhitespace(source: string, startOffset: number): number {
  let cursor = startOffset;

  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }

  return cursor;
}

function skipHorizontalWhitespace(source: string, startOffset: number): number {
  let cursor = startOffset;

  while (source[cursor] === " " || source[cursor] === "\t") {
    cursor += 1;
  }

  return cursor;
}

function isIdentifierPart(character: string): boolean {
  return /^[A-Za-z0-9_]$/.test(character);
}

function isIdentifierStart(character: string): boolean {
  return /^[A-Za-z]$/.test(character);
}

function previousNonWhitespace(
  source: string,
  startOffset: number,
): string | undefined {
  let cursor = startOffset - 1;

  while (cursor >= 0) {
    const character = source[cursor];

    if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") {
      return character;
    }

    cursor -= 1;
  }

  return undefined;
}

/**
 * Splits a type argument list on its top-level commas.
 *
 * A comma inside `<...>` belongs to a nested generic, not to this list -- without that,
 * `Func<Map<Id, String>, Boolean>` reads as three arguments instead of two.
 */
/**
 * Splits a comma list of *types*, so `<` and `(` both nest.
 *
 * Angles are needed for `Map<Id, Account>`, and parentheses for a tuple type: the
 * return type of `Func<Integer, (Integer, Integer)>` is one type argument, not two.
 * Counting only angles reads that as a two-parameter Func and rejects the one
 * lambda parameter the author wrote.
 */
function splitCommaList(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;
  let parenDepth = 0;

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const current = source[cursor];

    if (current === "<") {
      angleDepth += 1;
    } else if (current === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (current === "(") {
      parenDepth += 1;
    } else if (current === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (current === "," && angleDepth === 0 && parenDepth === 0) {
      parts.push(source.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }

  parts.push(source.slice(start).trim());
  return parts.filter(part => part.length > 0);
}

/**
 * Where a lambda's parameter text starts in the source.
 *
 * It cannot be found by looking for the first `(`: a single parameter may be written
 * bare, `a => ...`, and the first parenthesis would then be one in the body. The
 * parameters are whatever sits immediately before the arrow, so it is located from there.
 */
function parameterTextStart(
  matchStart: number,
  matchText: string,
  parameterText: string,
): number {
  const arrow = matchText.indexOf("=>");
  return matchStart + matchText.lastIndexOf(parameterText, arrow);
}

function parseLambdaParameters(
  source: string,
  parameterListStart: number,
  parameterList: string,
): LambdaParameter[] {
  const parameters: LambdaParameter[] = [];
  const parameterPattern = /[A-Za-z][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;

  while ((match = parameterPattern.exec(parameterList)) !== null) {
    const start = parameterListStart + match.index;
    parameters.push({
      name: match[0],
      range: createRange(source, start, start + match[0].length),
    });
  }

  return parameters;
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}
