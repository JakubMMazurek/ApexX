import {
  ApexErrorListener,
  ApexParserFactory,
} from "@apexdevtools/apex-parser";
import type {
  ApexXDiagnostic,
  ApexXParseResult,
  FilterLambdaExpression,
  ListMethodCallExpression,
  ListMethodCallStep,
} from "@apexx/ast";
import { createRange, isApexIdentifier } from "@apexx/semantics";

const returnStatementPattern = /^([ \t]*)return\s+/gm;
const assignmentStatementPattern =
  /^([ \t]*)(List\s*<\s*[^>\r\n]+\s*>\s+([A-Za-z][A-Za-z0-9_]*))\s*=\s*/gm;

export interface ApexParseResult {
  ok: boolean;
  diagnostics: ApexXDiagnostic[];
}

class CollectingErrorListener extends ApexErrorListener {
  readonly diagnostics: ApexXDiagnostic[] = [];

  apexSyntaxError(line: number, column: number, message: string): void {
    this.diagnostics.push({
      severity: "error",
      source: "apex-parser",
      message,
      range: {
        start: { offset: 0, line, column },
        end: { offset: 0, line, column: column + 1 },
      },
    });
  }
}

export function parseApex(source: string): ApexParseResult {
  const listener = new CollectingErrorListener();
  const { parser } = ApexParserFactory.createLexerAndParser(source, listener);
  parser.compilationUnit();

  return {
    ok: listener.diagnostics.length === 0,
    diagnostics: listener.diagnostics,
  };
}

export function parseApexX(source: string, fileName?: string): ApexXParseResult {
  const listMethodCalls = findListMethodCalls(source);
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

  for (const match of source.matchAll(/=>/g)) {
    const offset = match.index ?? 0;
    const isRecognized = listMethodCalls.some(
      call =>
        offset >= call.range.start.offset && offset < call.range.end.offset,
    );

    if (!isRecognized) {
      diagnostics.push({
        severity: "error",
        source: "apexx-parser",
        message:
          "Unsupported lambda form. v0.1 supports lambdas as arguments to List<T>.filter(...) in return or assignment forms only.",
        range: createRange(source, offset, offset + match[0].length),
      });
    }
  }

  return {
    source,
    fileName,
    listMethodCalls,
    filters: listMethodCalls,
    diagnostics,
  };
}

export function findListMethodCalls(
  source: string,
): ListMethodCallExpression[] {
  const calls: ListMethodCallExpression[] = [];

  for (const match of source.matchAll(assignmentStatementPattern)) {
    const start = match.index ?? 0;
    const expressionStart = start + match[0].length;
    const chain = parseFilterChain(source, expressionStart);

    if (!chain) {
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
    const chain = parseFilterChain(source, expressionStart);

    if (!chain) {
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

  return calls.sort((left, right) => left.range.start.offset - right.range.start.offset);
}

export function findFilterLambdaExpressions(
  source: string,
): FilterLambdaExpression[] {
  return findListMethodCalls(source);
}

interface ParsedFilterChain {
  receiver: string;
  steps: ListMethodCallStep[];
  endOffset: number;
}

interface IdentifierToken {
  name: string;
  startOffset: number;
  endOffset: number;
}

function parseFilterChain(
  source: string,
  startOffset: number,
): ParsedFilterChain | undefined {
  let cursor = skipWhitespace(source, startOffset);
  const receiver = readIdentifier(source, cursor);
  const steps: ListMethodCallStep[] = [];

  if (!receiver) {
    return undefined;
  }

  cursor = receiver.endOffset;

  while (true) {
    const filterStart = skipWhitespace(source, cursor);

    if (!isFilterCallAt(source, filterStart)) {
      break;
    }

    cursor = filterStart + ".filter".length;
    cursor = skipWhitespace(source, cursor);

    if (source[cursor] !== "(") {
      return undefined;
    }

    cursor += 1;
    cursor = skipWhitespace(source, cursor);

    const parameter = readIdentifier(source, cursor);
    if (!parameter) {
      return undefined;
    }

    cursor = skipWhitespace(source, parameter.endOffset);

    if (!source.startsWith("=>", cursor)) {
      return undefined;
    }

    const predicateStart = cursor + 2;
    const predicateEnd = findFilterPredicateEnd(source, predicateStart);
    if (predicateEnd === undefined) {
      return undefined;
    }

    const callEnd = predicateEnd + 1;
    steps.push({
      methodName: "filter",
      lambda: {
        parameterName: parameter.name,
        body: source.slice(predicateStart, predicateEnd).trim(),
        range: createRange(source, parameter.startOffset, predicateEnd),
      },
      range: createRange(source, filterStart, callEnd),
    });

    cursor = callEnd;
  }

  if (steps.length === 0) {
    return undefined;
  }

  cursor = skipHorizontalWhitespace(source, cursor);

  if (source[cursor] === ";") {
    cursor += 1;
  }

  return {
    receiver: receiver.name,
    steps,
    endOffset: cursor,
  };
}

function isFilterCallAt(source: string, offset: number): boolean {
  const filterNameStart = offset + 1;
  const filterNameEnd = filterNameStart + "filter".length;

  return (
    source[offset] === "." &&
    source.slice(filterNameStart, filterNameEnd) === "filter" &&
    !isIdentifierPart(source[filterNameEnd] ?? "")
  );
}

function findFilterPredicateEnd(
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

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}
