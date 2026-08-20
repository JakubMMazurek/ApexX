import fs from "node:fs";
import path from "node:path";
import type {
  ApexXDiagnostic,
  FuncInvocation,
  FuncLambdaAssignment,
  GeneratedApexSupportClass,
  ListMethodCallExpression,
  TranspileOptions,
  TranspileResult,
} from "@apexx/ast";
import { findFuncInvocations, parseApex, parseApexX } from "@apexx/parser";
import {
  collectDeclaredVariables,
  collectIdentifiers,
  collectListVariables,
  createRange,
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
  const methodLowering = lowerApexXMethods(output, {
    workspaceRoot: options.workspaceRoot,
    usedNames,
  });
  output = methodLowering.output;
  diagnostics.push(...methodLowering.diagnostics);

  const generated = addHeader(output, options.sourceFileName);
  const generatedParse = parseApex(generated);
  if (!generatedParse.ok) {
    diagnostics.push(...generatedParse.diagnostics);
  }

  return {
    source,
    output: generated,
    supportClasses: methodLowering.needsDecoratorSupport
      ? [createApexXSupportClass()]
      : [],
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

interface MethodLoweringResult {
  output: string;
  diagnostics: ApexXDiagnostic[];
  needsDecoratorSupport: boolean;
}

interface ApexXMethod {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  indent: string;
  annotations: ApexXAnnotation[];
  modifiers: string;
  returnType: string;
  name: string;
  parameters: ApexXMethodParameter[];
  className: string;
  rangeStart: number;
}

interface ApexXAnnotation {
  name: string;
  argumentsText: string;
  originalText: string;
}

interface ApexXMethodParameter {
  type: string;
  name: string;
  defaultValue?: string;
  originalText: string;
}

function lowerApexXMethods(
  source: string,
  options: { workspaceRoot?: string; usedNames: Set<string> },
): MethodLoweringResult {
  const diagnostics: ApexXDiagnostic[] = [];
  methodBodySource = source;
  const decoratorClassNames = collectDecoratorClassNames(source, options.workspaceRoot);
  const methods = findApexXMethods(source);
  const transformations: Transformation[] = [];
  let needsDecoratorSupport = false;

  for (const method of methods) {
    const defaultDiagnostics = validateDefaultParameters(source, method);
    diagnostics.push(...defaultDiagnostics);
    if (defaultDiagnostics.some(diagnostic => diagnostic.severity === "error")) {
      continue;
    }

    const nativeAnnotations = method.annotations.filter(annotation =>
      isNativeApexAnnotation(annotation.name),
    );
    const unknownAnnotations = method.annotations.filter(annotation =>
      !isNativeApexAnnotation(annotation.name),
    );
    const decoratorAnnotations = unknownAnnotations.filter(annotation =>
      decoratorClassNames.has(annotation.name.toLowerCase()),
    );
    const unresolvedAnnotations = unknownAnnotations.filter(annotation =>
      !decoratorClassNames.has(annotation.name.toLowerCase()),
    );

    for (const annotation of unresolvedAnnotations) {
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        message: `Unknown ApexX annotation @${annotation.name}. Add a class named ${annotation.name} that implements ApexX.Decorator, or use a native Apex annotation.`,
        range: createRange(source, method.rangeStart, method.rangeStart + annotation.originalText.length),
      });
    }

    if (unresolvedAnnotations.length > 0) {
      continue;
    }

    if (decoratorAnnotations.length > 0 && !/\bstatic\b/i.test(method.modifiers)) {
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        message: "ApexX decorators currently support static methods only.",
        range: createRange(source, method.start, method.start + method.end - method.start),
      });
      continue;
    }

    if (!method.parameters.some(parameter => parameter.defaultValue) && decoratorAnnotations.length === 0) {
      continue;
    }

    needsDecoratorSupport ||= decoratorAnnotations.length > 0;
    transformations.push({
      start: method.start,
      end: method.end,
      replacement: renderLoweredMethod({
        method,
        nativeAnnotations,
        decoratorAnnotations,
        usedNames: options.usedNames,
      }),
    });
  }

  let output = "";
  let cursor = 0;

  for (const transformation of transformations.sort((left, right) => left.start - right.start)) {
    if (transformation.start < cursor) {
      continue;
    }

    output += source.slice(cursor, transformation.start);
    output += transformation.replacement;
    cursor = transformation.end;
  }

  output += source.slice(cursor);
  return { output, diagnostics, needsDecoratorSupport };
}

function renderLoweredMethod(options: {
  method: ApexXMethod;
  nativeAnnotations: ApexXAnnotation[];
  decoratorAnnotations: ApexXAnnotation[];
  usedNames: Set<string>;
}): string {
  const { method, nativeAnnotations, decoratorAnnotations, usedNames } = options;
  const overloads = renderDefaultParameterOverloads(method, nativeAnnotations);
  const methodWithoutDefaults = renderMethodParameterList(method.parameters, {
    includeDefaults: false,
  });
  const nativeAnnotationText = renderAnnotations(nativeAnnotations, method.indent);

  if (decoratorAnnotations.length === 0) {
    return [
      overloads,
      nativeAnnotationText,
      `${method.indent}${method.modifiers}${method.returnType} ${method.name}(${methodWithoutDefaults}) {`,
      sourceIndentBody(sourceMethodBody(method), method.indent),
      `${method.indent}}`,
    ].filter(part => part.length > 0).join("\n");
  }

  const bodyMethodName = findAvailableName(`${method.name}_ApexXBody`, usedNames);
  const firstNextName = renderDecoratorNextClasses({
    method,
    decoratorAnnotations,
    bodyMethodName,
    usedNames,
  });
  const wrapperCall = renderDecoratorCall({
    method,
    annotation: decoratorAnnotations[0],
    nextClassName: firstNextName.nextClassName,
    nextArguments: method.parameters.map(parameter => parameter.name),
  });
  const wrapperLines = renderWrapperMethodLines(method, wrapperCall);
  const bodyMethod = renderBodyMethod(method, bodyMethodName);

  return [
    overloads,
    nativeAnnotationText,
    `${method.indent}${method.modifiers}${method.returnType} ${method.name}(${methodWithoutDefaults}) {`,
    wrapperLines.join("\n"),
    `${method.indent}}`,
    "",
    bodyMethod,
    "",
    firstNextName.declarations,
  ].filter(part => part.length > 0).join("\n");
}

function renderDefaultParameterOverloads(
  method: ApexXMethod,
  nativeAnnotations: ApexXAnnotation[],
): string {
  const firstDefaultIndex = method.parameters.findIndex(parameter => parameter.defaultValue);
  if (firstDefaultIndex < 0) {
    return "";
  }

  const overloads: string[] = [];
  for (let parameterCount = firstDefaultIndex; parameterCount < method.parameters.length; parameterCount += 1) {
    const parameters = method.parameters.slice(0, parameterCount);
    const argumentsText = method.parameters
      .map((parameter, index) =>
        index < parameterCount ? parameter.name : parameter.defaultValue ?? parameter.name,
      )
      .join(", ");
    const lines = [
      renderAnnotations(nativeAnnotations, method.indent),
      `${method.indent}${method.modifiers}${method.returnType} ${method.name}(${renderMethodParameterList(parameters, { includeDefaults: false })}) {`,
    ].filter(part => part.length > 0);

    if (isVoidType(method.returnType)) {
      lines.push(`${method.indent}    ${method.name}(${argumentsText});`);
      lines.push(`${method.indent}    return;`);
    } else {
      lines.push(`${method.indent}    return ${method.name}(${argumentsText});`);
    }

    lines.push(`${method.indent}}`);
    overloads.push(lines.join("\n"));
  }

  return overloads.join("\n\n");
}

function renderDecoratorNextClasses(options: {
  method: ApexXMethod;
  decoratorAnnotations: ApexXAnnotation[];
  bodyMethodName: string;
  usedNames: Set<string>;
}): { nextClassName: string; declarations: string } {
  const { method, decoratorAnnotations, bodyMethodName, usedNames } = options;
  const declarations: string[] = [];
  const nextClassNames = decoratorAnnotations.map(() =>
    findAvailableName("ApexXNext", usedNames),
  );

  for (const [index, annotation] of decoratorAnnotations.entries()) {
    const nextClassName = nextClassNames[index];
    const nextAnnotation = decoratorAnnotations[index + 1];
    const nextStageClassName = nextClassNames[index + 1];
    const fields = method.parameters
      .map(parameter => `${method.indent}    private ${parameter.type} ${parameter.name};`)
      .join("\n");
    const constructorAssignments = method.parameters
      .map(parameter => `${method.indent}        this.${parameter.name} = ${parameter.name};`)
      .join("\n");
    const parameterList = renderMethodParameterList(method.parameters, {
      includeDefaults: false,
    });
    const callText = nextAnnotation && nextStageClassName
      ? renderDecoratorCall({
          method,
          annotation: nextAnnotation,
          nextClassName: nextStageClassName,
          nextArguments: method.parameters.map(parameter => parameter.name),
        })
      : renderBodyCall(method, bodyMethodName);

    declarations.push([
      `${method.indent}private class ${nextClassName} implements ApexX.Next {`,
      fields,
      "",
      `${method.indent}    private ${nextClassName}(${parameterList}) {`,
      constructorAssignments,
      `${method.indent}    }`,
      "",
      `${method.indent}    public Object call() {`,
      isVoidType(nextAnnotation ? "Object" : method.returnType)
        ? `${method.indent}        ${callText};\n${method.indent}        return null;`
        : `${method.indent}        return ${callText};`,
      `${method.indent}    }`,
      `${method.indent}}`,
    ].filter(part => part.length > 0).join("\n"));
  }

  return {
    nextClassName: nextClassNames[0],
    declarations: declarations.join("\n\n"),
  };
}

function renderWrapperMethodLines(method: ApexXMethod, wrapperCall: string): string[] {
  if (isVoidType(method.returnType)) {
    return [
      `${method.indent}    ${wrapperCall};`,
      `${method.indent}    return;`,
    ];
  }

  return [`${method.indent}    return (${method.returnType}) ${wrapperCall};`];
}

function renderBodyMethod(method: ApexXMethod, bodyMethodName: string): string {
  return [
    `${method.indent}private static ${method.returnType} ${bodyMethodName}(${renderMethodParameterList(method.parameters, { includeDefaults: false })}) {`,
    sourceIndentBody(sourceMethodBody(method), method.indent),
    `${method.indent}}`,
  ].join("\n");
}

function renderDecoratorCall(options: {
  method: ApexXMethod;
  annotation: ApexXAnnotation;
  nextClassName: string;
  nextArguments: string[];
}): string {
  const { method, annotation, nextClassName, nextArguments } = options;
  return `new ${annotation.name}().handle(${renderInvocation(method, annotation)}, new ${nextClassName}(${nextArguments.join(", ")}))`;
}

function renderBodyCall(method: ApexXMethod, bodyMethodName: string): string {
  return `${method.className}.${bodyMethodName}(${method.parameters.map(parameter => parameter.name).join(", ")})`;
}

function renderInvocation(method: ApexXMethod, annotation: ApexXAnnotation): string {
  return [
    "new ApexX.Invocation(",
    `'${method.className}', `,
    `'${method.name}', `,
    `new List<String>{ ${method.parameters.map(parameter => `'${parameter.name}'`).join(", ")} }, `,
    `new List<Object>{ ${method.parameters.map(parameter => parameter.name).join(", ")} }, `,
    renderAnnotationConfig(annotation.argumentsText),
    ")",
  ].join("");
}

function renderAnnotationConfig(argumentsText: string): string {
  const argumentsTrimmed = argumentsText.trim();
  if (argumentsTrimmed.length === 0) {
    return "new Map<String, Object>()";
  }

  const entries = splitCommaList(argumentsTrimmed).map((part, index) => {
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:=|:)\s*(.+)$/.exec(part);
    if (match) {
      return `'${match[1]}' => ${match[2].trim()}`;
    }

    return `'value${index === 0 ? "" : index}' => ${part}`;
  });

  return `new Map<String, Object>{ ${entries.join(", ")} }`;
}

function validateDefaultParameters(
  source: string,
  method: ApexXMethod,
): ApexXDiagnostic[] {
  const diagnostics: ApexXDiagnostic[] = [];
  let sawDefault = false;

  for (const parameter of method.parameters) {
    if (parameter.defaultValue) {
      sawDefault = true;
      continue;
    }

    if (sawDefault) {
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        message: `Default parameter values must be trailing. Parameter '${parameter.name}' is required after an optional parameter.`,
        range: createRange(source, method.start, method.start + method.end - method.start),
      });
    }
  }

  return diagnostics;
}

function findApexXMethods(source: string): ApexXMethod[] {
  const methods: ApexXMethod[] = [];
  const pattern =
    /((?:^[ \t]*@[A-Za-z][A-Za-z0-9_]*(?:\s*\([^\r\n]*\))?[ \t]*(?:\r?\n))*)^([ \t]*)((?:(?:public|private|protected|global|static|final|virtual|abstract|override|webservice|testmethod)\s+)*)((?:List|Set)\s*<\s*[^>\r\n]+>|Map\s*<\s*[^>\r\n]+>|[A-Za-z][A-Za-z0-9_.]*)\s+([A-Za-z][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const start = match.index ?? 0;
    const openBrace = start + match[0].length - 1;
    const bodyEnd = findMatchingBrace(source, openBrace);
    const className = findEnclosingClassName(source, start);

    if (bodyEnd === undefined || !className) {
      continue;
    }

    methods.push({
      start,
      end: bodyEnd + 1,
      bodyStart: openBrace + 1,
      bodyEnd,
      indent: match[2],
      annotations: parseAnnotations(match[1]),
      modifiers: match[3],
      returnType: toApexType(match[4]),
      name: match[5],
      parameters: parseMethodParameters(match[6]),
      className,
      rangeStart: start,
    });
  }

  return methods;
}

function parseAnnotations(source: string): ApexXAnnotation[] {
  const annotations: ApexXAnnotation[] = [];

  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*@([A-Za-z][A-Za-z0-9_]*)(?:\s*\((.*)\))?\s*$/.exec(line);
    if (match) {
      annotations.push({
        name: match[1],
        argumentsText: match[2] ?? "",
        originalText: line,
      });
    }
  }

  return annotations;
}

function parseMethodParameters(source: string): ApexXMethodParameter[] {
  return splitCommaList(source).map(parameterText => {
    const equalsIndex = findTopLevelEquals(parameterText);
    const declarationText = equalsIndex >= 0
      ? parameterText.slice(0, equalsIndex).trim()
      : parameterText.trim();
    const defaultValue = equalsIndex >= 0
      ? parameterText.slice(equalsIndex + 1).trim()
      : undefined;
    const match = /^(.*\S)\s+([A-Za-z][A-Za-z0-9_]*)$/.exec(declarationText);
    return {
      type: match ? toApexType(match[1]) : declarationText,
      name: match?.[2] ?? "",
      defaultValue,
      originalText: parameterText,
    };
  }).filter(parameter => parameter.name.length > 0);
}

function findTopLevelEquals(source: string): number {
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (inString) {
      if (current === "\\" && next) {
        index += 1;
        continue;
      }

      if (current === "'") {
        inString = false;
      }
      continue;
    }

    if (current === "'") {
      inString = true;
    } else if (current === "<") {
      angleDepth += 1;
    } else if (current === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (current === "(") {
      parenDepth += 1;
    } else if (current === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (current === "{") {
      braceDepth += 1;
    } else if (current === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (
      current === "=" &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function renderMethodParameterList(
  parameters: ApexXMethodParameter[],
  options: { includeDefaults: boolean },
): string {
  return parameters
    .map(parameter => {
      const defaultText = options.includeDefaults && parameter.defaultValue
        ? ` = ${parameter.defaultValue}`
        : "";
      return `${parameter.type} ${parameter.name}${defaultText}`;
    })
    .join(", ");
}

function renderAnnotations(
  annotations: ApexXAnnotation[],
  indent: string,
): string {
  return annotations
    .map(annotation => `${indent}@${annotation.name}${annotation.argumentsText ? `(${annotation.argumentsText})` : ""}`)
    .join("\n");
}

function sourceMethodBody(method: ApexXMethod): string {
  return methodBodySource?.slice(method.bodyStart, method.bodyEnd) ?? "";
}

let methodBodySource = "";

function sourceIndentBody(body: string, indent: string): string {
  const trimmed = body.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
  if (trimmed.length === 0) {
    return "";
  }

  return trimmed
    .split(/\r?\n/)
    .map(line => `${indent}${line}`)
    .join("\n");
}

function collectDecoratorClassNames(
  source: string,
  workspaceRoot?: string,
): Set<string> {
  const classNames = new Set<string>();
  collectDecoratorClassNamesFromSource(source, classNames);

  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return classNames;
  }

  for (const file of collectApexSourceFiles(workspaceRoot)) {
    try {
      collectDecoratorClassNamesFromSource(fs.readFileSync(file, "utf8"), classNames);
    } catch {
      // Ignore unreadable workspace files.
    }
  }

  return classNames;
}

function collectDecoratorClassNamesFromSource(
  source: string,
  classNames: Set<string>,
): void {
  const pattern =
    /\bclass\s+([A-Za-z][A-Za-z0-9_]*)\b[^{;]*\bimplements\b[^{;]*\bApexX\s*\.\s*Decorator\b/g;
  for (const match of source.matchAll(pattern)) {
    classNames.add(match[1].toLowerCase());
  }
}

function collectApexSourceFiles(root: string): string[] {
  const files: string[] = [];
  const ignored = new Set(["node_modules", ".git", ".sf", ".sfdx", "generated", "dist"]);

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && /\.(cls|clsx)$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  visit(root);
  return files;
}

function findEnclosingClassName(source: string, offset: number): string | undefined {
  const pattern = /\bclass\s+([A-Za-z][A-Za-z0-9_]*)\b[^{]*\{/g;
  let match: RegExpExecArray | null;
  let className: string | undefined;

  while ((match = pattern.exec(source)) !== null) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    const closeBrace = findMatchingBrace(source, openBrace);
    if (openBrace < offset && closeBrace !== undefined && offset < closeBrace) {
      className = match[1];
    }
  }

  return className;
}

function findMatchingBrace(source: string, openBraceOffset: number): number | undefined {
  let cursor = openBraceOffset;
  let depth = 0;
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

    if (current === "{") {
      depth += 1;
    } else if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }

    cursor += 1;
  }

  return undefined;
}

function splitCommaList(source: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let start = 0;
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
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

    if (current === "<") {
      angleDepth += 1;
    } else if (current === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (current === "(") {
      parenDepth += 1;
    } else if (current === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (current === "{") {
      braceDepth += 1;
    } else if (current === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (
      current === "," &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0
    ) {
      parts.push(source.slice(start, cursor).trim());
      start = cursor + 1;
    }

    cursor += 1;
  }

  parts.push(source.slice(start).trim());
  return parts.filter(part => part.length > 0);
}

function isNativeApexAnnotation(name: string): boolean {
  return new Set([
    "AuraEnabled",
    "Deprecated",
    "Future",
    "HttpDelete",
    "HttpGet",
    "HttpPatch",
    "HttpPost",
    "HttpPut",
    "InvocableMethod",
    "InvocableVariable",
    "IsTest",
    "JsonAccess",
    "NamespaceAccessible",
    "ReadOnly",
    "RemoteAction",
    "RestResource",
    "SuppressWarnings",
    "TestSetup",
    "TestVisible",
    "future",
    "isTest",
    "testSetup",
  ].map(value => value.toLowerCase())).has(name.toLowerCase());
}

function isVoidType(typeName: string): boolean {
  return /^void$/i.test(typeName.trim());
}

function createApexXSupportClass(): GeneratedApexSupportClass {
  const source = addHeader([
    "public with sharing class ApexX {",
    "    public class Invocation {",
    "        public String className;",
    "        public String methodName;",
    "        public List<String> parameterNames;",
    "        public List<Object> arguments;",
    "        public Map<String, Object> config;",
    "",
    "        public Invocation(String className, String methodName, List<String> parameterNames, List<Object> arguments, Map<String, Object> config) {",
    "            this.className = className;",
    "            this.methodName = methodName;",
    "            this.parameterNames = parameterNames;",
    "            this.arguments = arguments;",
    "            this.config = config;",
    "        }",
    "    }",
    "",
    "    public interface Next {",
    "        Object call();",
    "    }",
    "",
    "    public interface Decorator {",
    "        Object handle(Invocation ctx, Next next);",
    "    }",
    "}",
  ].join("\n"), "ApexX.clsx support");

  return { className: "ApexX", source };
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
