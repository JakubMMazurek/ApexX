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
} from "@apexx/ast";
import { createRange, isApexIdentifier } from "@apexx/semantics";

const returnStatementPattern = /^([ \t]*)return\s+/gm;
const assignmentStatementPattern =
  /^([ \t]*)((?:[A-Za-z][A-Za-z0-9_.]*(?:\s*<\s*[^>\r\n]+\s*>)?)\s+([A-Za-z][A-Za-z0-9_]*))\s*=\s*/gm;
const expressionStatementPattern = /^([ \t]*)([A-Za-z][A-Za-z0-9_]*)/gm;
const funcLambdaAssignmentPattern =
  /^([ \t]*)(Func\s*<\s*([^>\r\n]+?)\s*>)\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*\(([^)\r\n]*)\)\s*=>\s*([\s\S]*?)\s*;[ \t]*(?=\r?$)/gm;
const funcLambdaReassignmentPattern =
  /^([ \t]*)([A-Za-z][A-Za-z0-9_]*)\s*=\s*\(([^)\r\n]*)\)\s*=>\s*([\s\S]*?)\s*;[ \t]*(?=\r?$)/gm;

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
      diagnostics.push({
        severity: "error",
        source: "apexx-parser",
        message:
          "Unsupported lambda form. v0.1 supports lambdas in Func assignments and ApexX List<T> methods.",
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

  for (const match of source.matchAll(funcLambdaAssignmentPattern)) {
    const start = match.index ?? 0;
    const sourceFuncType = match[2].replace(/\s+/g, " ").trim();
    const typeArguments = splitCommaList(match[3]);
    const parameterTypes = typeArguments.slice(0, -1);
    const returnType = typeArguments.at(-1) ?? "void";
    const parameterListStart = start + match[0].indexOf("(") + 1;
    const parameters = parseLambdaParameters(
      source,
      parameterListStart,
      match[5],
    );
    const bodyStart = match[0].indexOf("=>") + 2 + start;
    const bodyEnd = start + match[0].replace(/[ \t]*;?[ \t]*$/, "").length;

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
        body: source.slice(bodyStart, bodyEnd).trim(),
        range: createRange(source, parameterListStart, bodyEnd),
      },
      originalText: match[0],
      range: createRange(source, start, start + match[0].length),
    });
  }

  for (const match of source.matchAll(funcLambdaReassignmentPattern)) {
    const start = match.index ?? 0;

    if (rangesOverlapExistingAssignment(assignments, start, start + match[0].length)) {
      continue;
    }

    const parameterListStart = start + match[0].indexOf("(") + 1;
    const parameters = parseLambdaParameters(
      source,
      parameterListStart,
      match[3],
    );
    const bodyStart = match[0].indexOf("=>") + 2 + start;
    const bodyEnd = start + match[0].replace(/[ \t]*;[ \t]*$/, "").length;

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
        body: source.slice(bodyStart, bodyEnd).trim(),
        range: createRange(source, parameterListStart, bodyEnd),
      },
      originalText: match[0],
      range: createRange(source, start, start + match[0].length),
    });
  }

  return assignments.sort((left, right) => left.range.start.offset - right.range.start.offset);
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
  const calls: ListMethodCallExpression[] = [];

  for (const match of source.matchAll(assignmentStatementPattern)) {
    const start = match.index ?? 0;
    const expressionStart = start + match[0].length;
    const chain = parseListMethodChain(source, expressionStart);

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
    const chain = parseListMethodChain(source, expressionStart);

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

  for (const match of source.matchAll(expressionStatementPattern)) {
    const start = match.index ?? 0;
    const expressionStart = start + match[1].length;
    const chain = parseListMethodChain(source, expressionStart);

    if (!chain) {
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

  return calls.sort((left, right) => left.range.start.offset - right.range.start.offset);
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

    const parameter = readIdentifier(source, cursor);
    if (!parameter) {
      return undefined;
    }

    cursor = skipWhitespace(source, parameter.endOffset);

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
        body: source.slice(bodyStart, bodyEnd).trim(),
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

  if (source[cursor] === ";") {
    cursor += 1;
  }

  return {
    receiver: receiver.name,
    steps,
    endOffset: cursor,
  };
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
  let cursor = openParenOffset + 1;
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

    if (current === "(") {
      depth += 1;
    } else if (current === ")") {
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

function splitCommaList(source: string): string[] {
  return source
    .split(",")
    .map(part => part.trim())
    .filter(part => part.length > 0);
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
