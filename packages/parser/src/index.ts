import {
  ApexErrorListener,
  ApexParserFactory,
} from "@apexdevtools/apex-parser";
import type {
  ApexXDiagnostic,
  ApexXParseResult,
  FilterLambdaExpression,
} from "@apexx/ast";
import { createRange, isApexIdentifier } from "@apexx/semantics";

const returnFilterPattern =
  /^([ \t]*)return\s+([A-Za-z][A-Za-z0-9_]*)\.filter\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*=>\s*(.+?)\s*\)\s*;/gm;

const assignmentFilterPattern =
  /^([ \t]*)(List\s*<\s*[^>\r\n]+\s*>\s+([A-Za-z][A-Za-z0-9_]*))\s*=\s*([A-Za-z][A-Za-z0-9_]*)\.filter\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*=>\s*(.+?)\s*\)\s*;/gm;

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
  const filters = findFilterLambdaExpressions(source);
  const diagnostics: ApexXDiagnostic[] = [];

  for (const filter of filters) {
    if (!isApexIdentifier(filter.parameterName)) {
      diagnostics.push({
        severity: "error",
        source: "apexx-parser",
        message: `Invalid lambda parameter name '${filter.parameterName}'.`,
        range: filter.range,
      });
    }
  }

  for (const match of source.matchAll(/=>/g)) {
    const offset = match.index ?? 0;
    const isRecognized = filters.some(
      filter =>
        offset >= filter.range.start.offset && offset < filter.range.end.offset,
    );

    if (!isRecognized) {
      diagnostics.push({
        severity: "error",
        source: "apexx-parser",
        message:
          "Unsupported lambda form. v0.1 supports simple List<T>.filter(item => predicate) statements only.",
        range: createRange(source, offset, offset + match[0].length),
      });
    }
  }

  return {
    source,
    fileName,
    filters,
    diagnostics,
  };
}

export function findFilterLambdaExpressions(
  source: string,
): FilterLambdaExpression[] {
  const filters: FilterLambdaExpression[] = [];

  for (const match of source.matchAll(assignmentFilterPattern)) {
    const start = match.index ?? 0;
    filters.push({
      kind: "filter",
      statementKind: "assignment",
      indent: match[1],
      targetType: match[2].replace(/\s+/g, " ").trim(),
      targetName: match[3],
      receiver: match[4],
      parameterName: match[5],
      predicate: match[6].trim(),
      originalText: match[0],
      range: createRange(source, start, start + match[0].length),
    });
  }

  for (const match of source.matchAll(returnFilterPattern)) {
    const start = match.index ?? 0;
    if (filters.some(filter => rangesOverlap(filter.range.start.offset, filter.range.end.offset, start, start + match[0].length))) {
      continue;
    }

    filters.push({
      kind: "filter",
      statementKind: "return",
      indent: match[1],
      receiver: match[2],
      parameterName: match[3],
      predicate: match[4].trim(),
      originalText: match[0],
      range: createRange(source, start, start + match[0].length),
    });
  }

  return filters.sort((left, right) => left.range.start.offset - right.range.start.offset);
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}
