import type {
  ApexXDiagnostic,
  FuncInvocation,
  FuncLambdaAssignment,
  ListMethodCallExpression,
  TranspileOptions,
  TranspileResult,
} from "@apexx/ast";
import { findFuncInvocations, parseApex, parseApexX } from "@apexx/parser";
import {
  collectDeclaredVariables,
  collectIdentifiers,
  collectListVariables,
  createApexTypeProvider,
  extractListElementType,
  findEnclosingListReturnElementType,
  findAvailableName,
  inferListMethodChainTypes,
} from "@apexx/semantics";

export function transpileApexX(
  source: string,
  options: TranspileOptions = {},
): TranspileResult {
  const parseResult = parseApexX(source, options.sourceFileName);
  const diagnostics: ApexXDiagnostic[] = [...parseResult.diagnostics];
  const listVariables = collectListVariables(source);
  const declaredVariables = collectDeclaredVariables(source);
  const typeProvider = createApexTypeProvider({
    workspaceRoot: options.workspaceRoot,
  });
  const usedNames = collectIdentifiers(source);
  const listMethodCalls = parseResult.listMethodCalls.map(call => ({ ...call }));
  const funcLambdaAssignments = parseResult.funcLambdaAssignments.map(assignment => ({
    ...assignment,
  }));
  const funcInvocations = parseResult.funcInvocations.map(invocation => ({
    ...invocation,
  }));
  const funcVariableNames = new Set(
    funcLambdaAssignments.map(assignment => assignment.variableName),
  );
  const transformations: Transformation[] = [];
  let output = "";
  let cursor = 0;

  for (const call of listMethodCalls) {
    const listType = listVariables.get(call.receiver);

    if (!listType) {
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        message: `Cannot infer List<T> element type for '${call.receiver}'. Declare it as a List<T> variable in this file for v0.1.`,
        range: call.range,
      });
      continue;
    }

    call.elementType = listType.elementType;
    const expectedResultElementType = inferExpectedListResultElementType(
      source,
      call,
    );
    const chainTypes = inferListMethodChainTypes({
      source,
      call,
      receiverElementType: listType.elementType,
      expectedResultElementType,
      variables: declaredVariables,
      typeProvider,
    });
    const chainErrors = chainTypes.diagnostics.filter(
      diagnostic => diagnostic.severity === "error",
    );
    diagnostics.push(...chainTypes.diagnostics);

    if (chainErrors.length > 0) {
      continue;
    }

    call.resultElementType = chainTypes.finalElementType;
    call.stepInputTypes = chainTypes.inputTypes;
    call.stepResultTypes = chainTypes.resultTypes;
    call.resultTempNames = call.steps.map(step =>
      findAvailableName(step.methodName === "map" ? "apexxMap" : "apexxFilter", usedNames),
    );
    call.resultTempName = call.resultTempNames.at(-1);

    transformations.push({
      start: call.range.start.offset,
      end: call.range.end.offset,
      replacement: lowerListMethodCall(call, funcVariableNames),
    });
  }

  for (const assignment of funcLambdaAssignments) {
    assignment.interfaceName = findAvailableName("ApexXFunc", usedNames);
    assignment.implementationName = findAvailableName("ApexXLambda", usedNames);

    if (assignment.parameterTypes.length === assignment.lambda.parameters.length) {
      transformations.push({
        start: assignment.range.start.offset,
        end: assignment.range.end.offset,
        replacement: lowerFuncLambdaAssignment(assignment),
      });
    }
  }

  for (const invocation of funcInvocations) {
    transformations.push({
      start: invocation.range.start.offset,
      end: invocation.range.end.offset,
      replacement: lowerFuncInvocation(invocation, funcVariableNames),
    });
  }

  for (const transformation of transformations.sort((left, right) => left.start - right.start)) {
    if (transformation.start < cursor) {
      continue;
    }

    output += source.slice(cursor, transformation.start);
    output += transformation.replacement;
    cursor = transformation.end;
  }

  output += source.slice(cursor);
  output = addGeneratedFuncTypes(output, funcLambdaAssignments, funcVariableNames);

  const generated = addHeader(output, options.sourceFileName);
  const generatedParse = parseApex(generated);
  if (!generatedParse.ok) {
    diagnostics.push(...generatedParse.diagnostics);
  }

  return {
    source,
    output: generated,
    diagnostics,
    listMethodCalls,
    funcLambdaAssignments,
    funcInvocations,
    filters: listMethodCalls,
  };
}

interface Transformation {
  start: number;
  end: number;
  replacement: string;
}

function lowerListMethodCall(
  call: ListMethodCallExpression,
  funcVariableNames: Set<string>,
): string {
  const inputTypes = call.stepInputTypes;
  const resultTypes = call.stepResultTypes;
  const resultNames = call.resultTempNames;

  if (
    !inputTypes ||
    !resultTypes ||
    !resultNames ||
    inputTypes.length !== call.steps.length ||
    resultTypes.length !== call.steps.length ||
    resultNames.length !== call.steps.length
  ) {
    return call.originalText;
  }

  const indent = call.indent;
  const inner = `${indent}    `;
  const nested = `${indent}        `;
  const lines: string[] = [];
  let currentReceiver = call.receiver;

  for (const [index, step] of call.steps.entries()) {
    const resultName = resultNames[index];
    const lambda = step.lambda;
    const inputType = inputTypes[index];
    const resultType = resultTypes[index];

    lines.push(
      `${indent}List<${resultType}> ${resultName} = new List<${resultType}>();`,
      `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
    );

    if (step.methodName === "filter") {
      lines.push(
        `${inner}if (${rewriteFuncInvocations(lambda.body, funcVariableNames)}) {`,
        `${nested}${resultName}.add(${lambda.parameterName});`,
        `${inner}}`,
      );
    } else {
      lines.push(
        `${inner}${resultName}.add(${rewriteFuncInvocations(lambda.body, funcVariableNames)});`,
      );
    }

    lines.push(`${indent}}`);

    currentReceiver = resultName;
  }

  if (call.statementKind === "assignment") {
    lines.push(`${indent}${call.targetType} = ${currentReceiver};`);
  } else if (call.statementKind === "return") {
    lines.push(`${indent}return ${currentReceiver};`);
  }

  return lines.join("\n");
}

function inferExpectedListResultElementType(
  source: string,
  call: ListMethodCallExpression,
): string | undefined {
  if (call.statementKind === "assignment") {
    return extractListElementType(call.targetType ?? "");
  }

  if (call.statementKind === "return") {
    return findEnclosingListReturnElementType(source, call.range.start.offset);
  }

  return undefined;
}

function lowerFuncLambdaAssignment(assignment: FuncLambdaAssignment): string {
  return `${assignment.indent}${assignment.interfaceName} ${assignment.variableName} = new ${assignment.implementationName}();`;
}

function lowerFuncInvocation(
  invocation: FuncInvocation,
  funcVariableNames: Set<string>,
): string {
  return `${invocation.variableName}.invoke(${rewriteFuncInvocations(invocation.argumentsText, funcVariableNames)})`;
}

function addGeneratedFuncTypes(
  source: string,
  assignments: FuncLambdaAssignment[],
  funcVariableNames: Set<string>,
): string {
  const supportedAssignments = assignments.filter(
    assignment =>
      assignment.interfaceName &&
      assignment.implementationName &&
      assignment.parameterTypes.length === assignment.lambda.parameters.length,
  );

  if (supportedAssignments.length === 0) {
    return source;
  }

  const classStart = findClassBodyStart(source);
  if (classStart === undefined) {
    return source;
  }

  const declarations = supportedAssignments
    .map(assignment => renderFuncTypeDeclaration(assignment, "    ", funcVariableNames))
    .join("\n\n");

  return `${source.slice(0, classStart)}\n${declarations}\n${source.slice(classStart)}`;
}

function renderFuncTypeDeclaration(
  assignment: FuncLambdaAssignment,
  indent: string,
  funcVariableNames: Set<string>,
): string {
  const inner = `${indent}    `;
  const nested = `${indent}        `;
  const parameters = assignment.lambda.parameters.map((parameter, index) => ({
    name: parameter.name,
    type: toApexType(assignment.parameterTypes[index]),
  }));
  const parameterText = parameters
    .map(parameter => `${parameter.type} ${parameter.name}`)
    .join(", ");
  const returnType = toApexType(assignment.returnType);

  return [
    `${indent}public interface ${assignment.interfaceName} {`,
    `${inner}${returnType} invoke(${parameterText});`,
    `${indent}}`,
    "",
    `${indent}private class ${assignment.implementationName} implements ${assignment.interfaceName} {`,
    `${inner}public ${returnType} invoke(${parameterText}) {`,
    `${nested}return ${rewriteFuncInvocations(assignment.lambda.body, funcVariableNames)};`,
    `${inner}}`,
    `${indent}}`,
  ].join("\n");
}

function findClassBodyStart(source: string): number | undefined {
  const match = /\bclass\s+[A-Za-z][A-Za-z0-9_]*[^{]*\{/.exec(source);
  return match ? match.index + match[0].length : undefined;
}

function addHeader(source: string, sourceFileName?: string): string {
  const sourceLine = sourceFileName
    ? `// Source: ${sourceFileName}\n`
    : "";

  return `// AUTO-GENERATED BY ApexX.\n${sourceLine}// DO NOT EDIT.\n\n${source}`;
}

function toApexType(typeName: string): string {
  const normalized = typeName.replace(/\s+/g, "");
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

function rewriteFuncInvocations(
  source: string,
  funcVariableNames: Set<string>,
): string {
  if (funcVariableNames.size === 0) {
    return source;
  }

  const invocations = findFuncInvocations(source, funcVariableNames);
  let output = "";
  let cursor = 0;

  for (const invocation of invocations) {
    const start = invocation.range.start.offset;
    const end = invocation.range.end.offset;

    if (start < cursor) {
      continue;
    }

    output += source.slice(cursor, start);
    output += lowerFuncInvocation(invocation, funcVariableNames);
    cursor = end;
  }

  output += source.slice(cursor);
  return output;
}
