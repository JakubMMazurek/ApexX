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
  findEnclosingMethodReturnType,
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
    const expectedResultType = inferExpectedListMethodResultType(
      source,
      call,
    );
    const chainTypes = inferListMethodChainTypes({
      source,
      call,
      receiverElementType: listType.elementType,
      expectedResultType,
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

    call.resultElementType = chainTypes.finalKind === "list"
      ? chainTypes.finalElementType
      : undefined;
    call.resultType = chainTypes.finalType;
    call.resultKind = chainTypes.finalKind;
    call.stepInputTypes = chainTypes.inputTypes;
    call.stepResultTypes = chainTypes.resultTypes;
    call.stepResultKinds = chainTypes.resultKinds;
    call.resultTempNames = call.steps.map(step =>
      findAvailableName(tempPrefixForListMethod(step.methodName), usedNames),
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
  const resultKinds = call.stepResultKinds;
  const resultNames = call.resultTempNames;

  if (
    !inputTypes ||
    !resultTypes ||
    !resultKinds ||
    !resultNames ||
    inputTypes.length !== call.steps.length ||
    resultTypes.length !== call.steps.length ||
    resultKinds.length !== call.steps.length ||
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
    const resultKind = resultKinds[index];

    if (resultKind === "list") {
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
      } else if (step.methodName === "flatMap") {
        lines.push(
          `${inner}${resultName}.addAll(${rewriteFuncInvocations(lambda.body, funcVariableNames)});`,
        );
      } else {
        lines.push(
          `${inner}${resultName}.add(${rewriteFuncInvocations(lambda.body, funcVariableNames)});`,
        );
      }

      lines.push(`${indent}}`);
      currentReceiver = resultName;
      continue;
    }

    if (step.methodName === "any") {
      lines.push(
        `${indent}Boolean ${resultName} = false;`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
        `${inner}if (${rewriteFuncInvocations(lambda.body, funcVariableNames)}) {`,
        `${nested}${resultName} = true;`,
        `${nested}break;`,
        `${inner}}`,
        `${indent}}`,
      );
    } else if (step.methodName === "all") {
      lines.push(
        `${indent}Boolean ${resultName} = true;`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
        `${inner}if (!(${rewriteFuncInvocations(lambda.body, funcVariableNames)})) {`,
        `${nested}${resultName} = false;`,
        `${nested}break;`,
        `${inner}}`,
        `${indent}}`,
      );
    } else if (step.methodName === "count") {
      lines.push(
        `${indent}Integer ${resultName} = 0;`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
        `${inner}if (${rewriteFuncInvocations(lambda.body, funcVariableNames)}) {`,
        `${nested}${resultName}++;`,
        `${inner}}`,
        `${indent}}`,
      );
    } else {
      lines.push(
        `${indent}${resultType} ${resultName} = null;`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
        `${inner}if (${rewriteFuncInvocations(lambda.body, funcVariableNames)}) {`,
        `${nested}${resultName} = ${lambda.parameterName};`,
        `${nested}break;`,
        `${inner}}`,
        `${indent}}`,
      );
    }

    currentReceiver = resultName;
  }

  if (call.statementKind === "assignment") {
    lines.push(`${indent}${call.targetType} = ${currentReceiver};`);
  } else if (call.statementKind === "return") {
    lines.push(`${indent}return ${currentReceiver};`);
  }

  return lines.join("\n");
}

function inferExpectedListMethodResultType(
  source: string,
  call: ListMethodCallExpression,
): string | undefined {
  if (call.statementKind === "assignment") {
    return extractAssignmentDeclaredType(call.targetType ?? "");
  }

  if (call.statementKind === "return") {
    return findEnclosingMethodReturnType(source, call.range.start.offset);
  }

  return undefined;
}

function extractAssignmentDeclaredType(targetType: string): string | undefined {
  const match = /^(.*)\s+[A-Za-z][A-Za-z0-9_]*$/.exec(targetType.trim());
  return match?.[1].replace(/\s+/g, " ").trim();
}

function tempPrefixForListMethod(methodName: string): string {
  const prefixes: Record<string, string> = {
    filter: "apexxFilter",
    map: "apexxMap",
    flatMap: "apexxFlatMap",
    any: "apexxAny",
    all: "apexxAll",
    count: "apexxCount",
    find: "apexxFind",
  };

  return prefixes[methodName] ?? "apexxResult";
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
