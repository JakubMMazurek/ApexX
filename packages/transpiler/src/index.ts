import fs from "node:fs";
import path from "node:path";
import type {
  ApexXStructuralTypes,
  ApexXUnitMode,
  CapturedVariable,
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
  checkFuncLambdaReturnTypes,
  collectDeclaredVariables,
  collectIdentifiers,
  collectListVariables,
  createRange,
  createApexTypeProvider,
  findEnclosingMethodReturnType,
  findAvailableName,
  inferListMethodChainTypes,
} from "@apexx/semantics";
import { lowerApexXTuples } from "./tuples.js";
export { mapIdentifierOffset } from "./sourceMap.js";
import {
  applySplices,
  chainMaps,
  identityMap,
  splicesFromReplace,
  spanToSource,
  type PositionMap,
  type Splice,
} from "./sourceMap.js";
import {
  FUNC_REGISTRY_CLASS,
  sharedFuncTypeName,
  sharedTypeMemberName,
  type SharedTypeNaming,
} from "./sharedTypes.js";
import {
  renderStructuralRegistry,
} from "./structuralRegistry.js";

export { mergeGeneratedSupportClasses } from "./structuralRegistry.js";

export function transpileApexX(
  source: string,
  options: TranspileOptions = {},
): TranspileResult {
  const mode: ApexXUnitMode = options.mode ?? "class";
  const structuralTypes: ApexXStructuralTypes = options.structuralTypes ?? "inline";
  // A class-mode build deploys the structural registries alongside the class. A
  // script declares its own by default, so its structural types are named flat
  // and carried in the block; asking for the deployed ones puts it back on the
  // registry names, which is what interop with a deployed class requires.
  const naming: SharedTypeNaming =
    mode === "anonymous" && structuralTypes === "inline" ? "flat" : "registry";
  const tupleLowering = lowerApexXTuples(source, { naming });
  const workingSource = tupleLowering.output;
  const parseResult = parseApexX(workingSource, options.sourceFileName);
  // Diagnostics carry offsets into whichever pipeline stage produced them, while
  // every consumer reports them against the authored `.clsx`. Each batch is kept
  // in its own coordinate space here and remapped to the source once the stage
  // maps that separate it from the source exist.
  const sourceDiagnostics: ApexXDiagnostic[] = [
    ...tupleLowering.diagnostics,
    ...(naming === "flat" ? checkStructuralTypeBoundaries(source) : []),
  ];
  const diagnostics: ApexXDiagnostic[] = [...parseResult.diagnostics];
  const listVariables = collectListVariables(workingSource);
  const declaredVariables = collectDeclaredVariables(workingSource);
  const typeProvider = createApexTypeProvider({
    workspaceRoot: options.workspaceRoot,
  });
  const usedNames = collectIdentifiers(workingSource);
  const funcTypeAliases = collectFuncTypeAliases(
    `${source}\n${workingSource}`,
    usedNames,
    naming,
  );
  const listMethodCalls = parseResult.listMethodCalls.map(call => ({ ...call }));
  const funcLambdaAssignments = parseResult.funcLambdaAssignments.map(assignment => ({
    ...assignment,
  }));
  const funcVariableNames = collectFuncVariableNames(
    declaredVariables,
    funcLambdaAssignments,
  );
  const funcInvocations = findFuncInvocations(workingSource, funcVariableNames);
  const transformations: Transformation[] = [];
  let output = "";

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
      workingSource,
      call,
    );
    const chainTypes = inferListMethodChainTypes({
      source: workingSource,
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
    completeFuncLambdaAssignmentTypes(assignment, declaredVariables);
    diagnostics.push(
      ...checkFuncLambdaReturnTypes({
        source: workingSource,
        assignment,
        variables: declaredVariables,
        typeProvider,
      }),
    );
    const signature = funcSignatureKey(assignment.parameterTypes, assignment.returnType);
    assignment.interfaceName = funcTypeAliases.get(signature)?.interfaceName
      ?? sharedFuncTypeName(
        assignment.parameterTypes,
        assignment.returnType,
        naming,
      );
    assignment.implementationName = findAvailableName("ApexXLambda", usedNames);
  }

  for (const assignment of funcLambdaAssignments) {
    assignment.captures = inferCapturedVariables(
      assignment,
      declaredVariables,
      funcLambdaAssignments,
      funcTypeAliases,
    );

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

  const mainStage = applySplices(workingSource, transformations);
  output = mainStage.output;

  const funcTypeStage = replaceFuncTypeReferences(output, funcTypeAliases);
  output = funcTypeStage.output;

  const generatedTypeStage = addGeneratedFuncTypes(
    output,
    funcLambdaAssignments,
    funcVariableNames,
    funcTypeAliases,
    { mode, naming, inlineDeclarations: tupleLowering.inlineDeclarations },
  );
  output = generatedTypeStage.output;

  const methodLowering = lowerApexXMethods(output, {
    workspaceRoot: options.workspaceRoot,
    usedNames,
    mode,
  });
  output = methodLowering.output;

  // Trailing-whitespace trimming and the header both shift offsets, so both are
  // stages like any other.
  const trimStage = applySplices(output, trimTrailingWhitespaceSplices(output));
  const headerStage = applySplices(trimStage.output, [
    { start: 0, end: 0, replacement: headerText(options.sourceFileName) },
  ]);
  const generated = headerStage.output;
  const generatedParse = parseApex(generated, {
    anonymous: mode === "anonymous",
  });

  const stageMaps = [
    tupleLowering.map,
    mainStage.map,
    funcTypeStage.map,
    generatedTypeStage.map,
    methodLowering.map,
    trimStage.map,
    headerStage.map,
  ];
  const sourceMap = chainMaps(stageMaps);

  // Stage maps in pipeline order, so a slice of this list is the path from the
  // authored source to the stage that produced a given batch of diagnostics.
  const [tupleMap, mainMap, funcTypeMap, generatedTypeMap] = stageMaps;
  const reportedDiagnostics: ApexXDiagnostic[] = [
    ...reportAgainstSource(sourceDiagnostics, source, []),
    ...reportAgainstSource(diagnostics, source, [tupleMap]),
    ...reportAgainstSource(methodLowering.diagnostics, source, [
      tupleMap,
      mainMap,
      funcTypeMap,
      generatedTypeMap,
    ]),
  ];

  // An error in the ApexX front end leaves that construct un-lowered, so the Apex
  // parser then fails on syntax the user never wrote. Those cascade errors would
  // bury the diagnostic that actually explains the problem.
  if (!generatedParse.ok && !reportedDiagnostics.some(entry => entry.severity === "error")) {
    reportedDiagnostics.push(
      ...reportAgainstSource(generatedParse.diagnostics, source, stageMaps),
    );
  }

  const generatedTypeNames = new Map<string, string>();
  for (const alias of funcTypeAliases.values()) {
    generatedTypeNames.set(
      alias.interfaceName,
      `Func<${[...alias.parameterTypes, alias.returnType].join(", ")}>`,
    );
  }

  return {
    source,
    output: generated,
    sourceMap,
    generatedTypeNames,
    supportClasses: deduplicateSupportClasses([
      ...tupleLowering.supportClasses,
      ...createFuncSupportClasses(funcTypeAliases, naming),
      ...(methodLowering.needsDecoratorSupport ? [createApexXSupportClass()] : []),
    ]),
    diagnostics: reportedDiagnostics,
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

/**
 * Rewrites diagnostic ranges from a stage's coordinate space into the authored source.
 *
 * Pass the stage maps in pipeline order; an empty list means the diagnostics are
 * already in authored coordinates and only need tightening.
 */
function reportAgainstSource(
  diagnostics: ApexXDiagnostic[],
  source: string,
  maps: PositionMap[],
): ApexXDiagnostic[] {
  return diagnostics.map(diagnostic => {
    if (!diagnostic.range) {
      return diagnostic;
    }

    const mapped = spanToSource(
      maps,
      diagnostic.range.start.offset,
      diagnostic.range.end.offset,
    );
    const span = tightenSpan(source, mapped);

    return { ...diagnostic, range: createRange(source, span.start, span.end) };
  });
}

/**
 * Pulls a span in off surrounding whitespace.
 *
 * A statement span starts at column zero because the lowering splices the
 * indentation along with the statement, which would otherwise draw the squiggle
 * from the left margin instead of from the offending code.
 */
function tightenSpan(
  source: string,
  span: { start: number; end: number },
): { start: number; end: number } {
  let start = span.start;
  let end = span.end;

  while (start < end && /\s/.test(source[start] ?? "")) {
    start += 1;
  }

  while (end > start && /\s/.test(source[end - 1] ?? "")) {
    end -= 1;
  }

  return end > start ? { start, end } : span;
}

interface FuncTypeAlias {
  interfaceName: string;
  parameterTypes: string[];
  returnType: string;
}

interface MethodLoweringResult {
  output: string;
  diagnostics: ApexXDiagnostic[];
  needsDecoratorSupport: boolean;
  map: PositionMap;
}

interface ApexXMethod {
  start: number;
  end: number;
  /** Start of the declaration, after any annotations above it. */
  declarationStart: number;
  bodyStart: number;
  bodyEnd: number;
  indent: string;
  annotations: ApexXAnnotation[];
  modifiers: string;
  returnType: string;
  name: string;
  parameters: ApexXMethodParameter[];
  /** Undefined for a method declared at the top level of an anonymous block. */
  className: string | undefined;
}

interface ApexXAnnotation {
  name: string;
  argumentsText: string;
  /** The annotation as written, without the indentation before it. */
  originalText: string;
  offset: number;
}

interface ApexXMethodParameter {
  type: string;
  name: string;
  defaultValue?: string;
  /** The parameter as written, without the whitespace around it. */
  originalText: string;
  offset: number;
}

function lowerApexXMethods(
  source: string,
  options: {
    workspaceRoot?: string;
    usedNames: Set<string>;
    mode: ApexXUnitMode;
  },
): MethodLoweringResult {
  const diagnostics: ApexXDiagnostic[] = [];
  methodBodySource = source;
  const decoratorClassNames = collectDecoratorClassNames(source, options.workspaceRoot);
  // A block-level method has no enclosing class, which is only a legal shape in
  // an anonymous block.
  const methods = findApexXMethods(source, {
    allowTopLevel: options.mode === "anonymous",
  });
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
        range: createRange(
          source,
          annotation.offset,
          annotation.offset + annotation.originalText.length,
        ),
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
        // The signature, not the whole method: the missing `static` belongs there.
        range: createRange(source, method.declarationStart, method.bodyStart - 1),
      });
      continue;
    }

    if (options.mode === "anonymous" && decoratorAnnotations.length > 0) {
      const annotation = decoratorAnnotations[0];
      const annotationRange = createRange(
        source,
        annotation.offset,
        annotation.offset + annotation.originalText.length,
      );

      // A decorated method lowers into a wrapper plus a Next class beside it. In
      // an anonymous block both would sit inside a class the block declares,
      // which is an inner type, and Apex rejects an inner type that has inner
      // types. A block-level method has no class to hold the pair at all.
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        code: method.className === undefined ? "APXX2620" : "APXX2621",
        message: method.className === undefined
          ? `@${annotation.name} cannot decorate a method declared at the top level of a script, because the decorator is dispatched through the class that holds the method. Move it to a deployed class and call that class from the script.`
          : `@${annotation.name} cannot decorate a method of a class declared in a script, because the generated helper class would be an inner type of an inner type. Move it to a deployed class and call that class from the script.`,
        range: annotationRange,
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

  const { output, map } = applySplices(source, transformations);
  return { output, diagnostics, needsDecoratorSupport, map };
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
        range: createRange(
          source,
          parameter.offset,
          parameter.offset + parameter.originalText.length,
        ),
      });
    }
  }

  return diagnostics;
}

function findApexXMethods(
  source: string,
  options: { allowTopLevel: boolean },
): ApexXMethod[] {
  const methods: ApexXMethod[] = [];
  const pattern =
    /((?:^[ \t]*@[A-Za-z][A-Za-z0-9_]*(?:\s*\([^\r\n]*\))?[ \t]*(?:\r?\n))*)^([ \t]*)((?:(?:public|private|protected|global|static|final|virtual|abstract|override|webservice|testmethod)\s+)*)((?:List|Set)\s*<\s*[^>\r\n]+>|Map\s*<\s*[^>\r\n]+>|[A-Za-z][A-Za-z0-9_.]*)\s+([A-Za-z][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const start = match.index ?? 0;
    const openBrace = start + match[0].length - 1;
    const bodyEnd = findMatchingBrace(source, openBrace);
    const className = findEnclosingClassName(source, start);

    if (bodyEnd === undefined || (!className && !options.allowTopLevel)) {
      continue;
    }

    // `start` is the top of the annotation block; the declaration itself begins
    // after it, and the parameter list is the last parenthesised run in the header.
    const declarationStart = start + match[1].length;
    const parametersStart = start + match[0].lastIndexOf(")") - match[6].length;

    methods.push({
      start,
      end: bodyEnd + 1,
      declarationStart,
      bodyStart: openBrace + 1,
      bodyEnd,
      indent: match[2],
      annotations: parseAnnotations(match[1], start),
      modifiers: match[3],
      returnType: toApexType(match[4]),
      name: match[5],
      parameters: parseMethodParameters(match[6], parametersStart),
      className,
    });
  }

  return methods;
}

function parseAnnotations(source: string, baseOffset: number): ApexXAnnotation[] {
  const annotations: ApexXAnnotation[] = [];
  const pattern = /^([ \t]*)@([A-Za-z][A-Za-z0-9_]*)(?:[ \t]*\((.*)\))?[ \t]*$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    annotations.push({
      name: match[2],
      argumentsText: match[3] ?? "",
      originalText: match[0].trim(),
      offset: baseOffset + (match.index ?? 0) + match[1].length,
    });
  }

  return annotations;
}

function parseMethodParameters(
  source: string,
  baseOffset: number,
): ApexXMethodParameter[] {
  // Split parts come back trimmed, so each offset is recovered by walking the
  // parameter list in order.
  let cursor = 0;

  return splitCommaList(source).map(parameterText => {
    const found = source.indexOf(parameterText, cursor);
    const offset = found >= 0 ? found : cursor;
    cursor = offset + parameterText.length;
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
      offset: baseOffset + offset,
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

export interface ApexXDecorator {
  name: string;
  /** Keys the decorator reads out of `ctx.config`, which are its parameter names. */
  configKeys: string[];
  file?: string;
}

/**
 * Decorator classes available to a workspace, with the parameters each one accepts.
 *
 * A decorator takes its arguments as an untyped `Map<String, Object>`, so there is no
 * signature to read. What a decorator actually understands is the set of keys it pulls
 * out of `ctx.config`, which is what this reports -- derived from the decorator's own
 * source rather than from a list that would drift away from it.
 */
export function findApexXDecorators(
  source: string,
  workspaceRoot?: string,
): ApexXDecorator[] {
  const decorators = new Map<string, ApexXDecorator>();
  collectDecorators(source, undefined, decorators);

  if (workspaceRoot && fs.existsSync(workspaceRoot)) {
    for (const file of collectApexSourceFiles(workspaceRoot)) {
      try {
        collectDecorators(fs.readFileSync(file, "utf8"), file, decorators);
      } catch {
        // Ignore unreadable workspace files.
      }
    }
  }

  return [...decorators.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Native Apex annotations, which a decorator name must not be confused with. */
export function nativeApexAnnotations(): string[] {
  return [...NATIVE_APEX_ANNOTATIONS];
}

function collectDecorators(
  source: string,
  file: string | undefined,
  decorators: Map<string, ApexXDecorator>,
): void {
  const pattern =
    /\bclass\s+([A-Za-z][A-Za-z0-9_]*)\b[^{;]*\bimplements\b[^{;]*\bApexX\s*\.\s*Decorator\b/g;

  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const bodyStart = source.indexOf("{", (match.index ?? 0) + match[0].length);
    const bodyEnd = bodyStart >= 0 ? findMatchingBrace(source, bodyStart) : undefined;
    const body = bodyEnd === undefined
      ? source.slice(match.index ?? 0)
      : source.slice(bodyStart, bodyEnd);
    const configKeys = new Set<string>();

    for (const key of body.matchAll(/\bconfig\s*\.\s*get\s*\(\s*'([^']+)'/g)) {
      configKeys.add(key[1]);
    }

    const existing = decorators.get(name.toLowerCase());
    decorators.set(name.toLowerCase(), {
      name,
      configKeys: [...new Set([...(existing?.configKeys ?? []), ...configKeys])].sort(),
      file: existing?.file ?? file,
    });
  }
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

/** Matching is case-insensitive, the way the Apex compiler reads an annotation name. */
function isNativeApexAnnotation(name: string): boolean {
  const lowered = name.toLowerCase();
  return NATIVE_APEX_ANNOTATIONS.some(
    annotation => annotation.toLowerCase() === lowered,
  );
}

/** Canonical spellings, which are also what completion offers. */
const NATIVE_APEX_ANNOTATIONS = [
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
];

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
    const blockLambda = isBlockLambdaBody(lambda.body)
      ? lowerCollectionBlockLambda(lambda.body, inner, funcVariableNames)
      : undefined;
    const lambdaExpression = blockLambda?.expression
      ?? rewriteFuncInvocations(lambda.body, funcVariableNames);

    if (resultKind === "list") {
      lines.push(
        `${indent}List<${resultType}> ${resultName} = new List<${resultType}>();`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
      );

      if (blockLambda) {
        lines.push(...blockLambda.prelude);
      }

      if (step.methodName === "filter") {
        lines.push(
          `${inner}if (${lambdaExpression}) {`,
          `${nested}${resultName}.add(${lambda.parameterName});`,
          `${inner}}`,
        );
      } else if (step.methodName === "flatMap") {
        lines.push(
          `${inner}${resultName}.addAll(${lambdaExpression});`,
        );
      } else {
        lines.push(
          `${inner}${resultName}.add(${lambdaExpression});`,
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
        ...(blockLambda?.prelude ?? []),
        `${inner}if (${lambdaExpression}) {`,
        `${nested}${resultName} = true;`,
        `${nested}break;`,
        `${inner}}`,
        `${indent}}`,
      );
    } else if (step.methodName === "all") {
      lines.push(
        `${indent}Boolean ${resultName} = true;`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
        ...(blockLambda?.prelude ?? []),
        `${inner}if (!(${lambdaExpression})) {`,
        `${nested}${resultName} = false;`,
        `${nested}break;`,
        `${inner}}`,
        `${indent}}`,
      );
    } else if (step.methodName === "count") {
      lines.push(
        `${indent}Integer ${resultName} = 0;`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
        ...(blockLambda?.prelude ?? []),
        `${inner}if (${lambdaExpression}) {`,
        `${nested}${resultName}++;`,
        `${inner}}`,
        `${indent}}`,
      );
    } else {
      lines.push(
        `${indent}${resultType} ${resultName} = null;`,
        `${indent}for (${inputType} ${lambda.parameterName} : ${currentReceiver}) {`,
        ...(blockLambda?.prelude ?? []),
        `${inner}if (${lambdaExpression}) {`,
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
  } else if (call.statementKind === "embedded" && call.embedded) {
    // The loops are above; what is left is the statement the chain was nested in, with
    // the chain itself replaced by the name the loops left the result in.
    const { statementText, chainStart, chainEnd } = call.embedded;
    const before = closeUpTowardsChain(statementText.slice(0, chainStart), "end");
    const after = closeUpTowardsChain(statementText.slice(chainEnd), "start");
    lines.push(`${indent}${before}${currentReceiver}${after}`);
  }

  return lines.join("\n");
}

/**
 * Pulls the rest of a statement back onto one line where the chain used to span several.
 *
 * A chain written across lines leaves its line breaks behind once it collapses to a
 * single name: `System.debug(numbers\n  .filter(...)\n)` would otherwise rebuild as
 * `System.debug(apexxMap0\n)`. A break next to a bracket or separator closes up
 * completely; anywhere else it becomes one space, because the tokens either side of it
 * still need separating.
 */
function closeUpTowardsChain(text: string, side: "start" | "end"): string {
  if (side === "end") {
    return text.replace(/\s*\n\s*$/, match =>
      /[([,]\s*$/.test(text.slice(0, text.length - match.length)) ? "" : " ",
    );
  }

  return text.replace(/^\s*\n\s*/, match =>
    /^[)\],;]/.test(text.slice(match.length)) ? "" : " ",
  );
}

function isBlockLambdaBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function lowerCollectionBlockLambda(
  body: string,
  indent: string,
  funcVariableNames: Set<string>,
): { prelude: string[]; expression: string } {
  const statements = normalizeBlockLambdaBody(body);
  const finalStatement = statements.at(-1) ?? "";
  const returnMatch = /^return\s+([\s\S]+);$/.exec(finalStatement.trim());

  if (!returnMatch) {
    return {
      prelude: statements.map(statement =>
        `${indent}${rewriteFuncInvocations(statement, funcVariableNames)}`,
      ),
      expression: "null",
    };
  }

  return {
    prelude: statements.slice(0, -1).map(statement =>
      `${indent}${rewriteFuncInvocations(statement, funcVariableNames)}`,
    ),
    expression: formatBlockLambdaExpression(
      rewriteFuncInvocations(returnMatch[1].trim(), funcVariableNames),
      indent,
    ),
  };
}

function formatBlockLambdaExpression(expression: string, continuationIndent: string): string {
  const lines = expression.split(/\r?\n/);

  if (lines.length === 1) {
    return lines[0].trim();
  }

  return [
    lines[0].trim(),
    ...lines.slice(1).map(line => `${continuationIndent}${line.trim()}`),
  ].join("\n");
}

function normalizeBlockLambdaBody(body: string): string[] {
  const inner = body.trim().replace(/^\{/, "").replace(/\}$/, "");
  const lines = inner
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/g, ""))
    .filter(line => line.trim().length > 0);
  const indents = lines
    .filter(line => line.trim().length > 0)
    .map(line => /^(\s*)/.exec(line)?.[1].length ?? 0);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;

  return splitBlockStatements(lines.map(line => line.slice(commonIndent)).join("\n"));
}

function splitBlockStatements(source: string): string[] {
  const statements: string[] = [];
  let cursor = 0;
  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
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
      parenDepth += 1;
    } else if (current === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (current === "{") {
      braceDepth += 1;
    } else if (current === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (current === "<") {
      angleDepth += 1;
    } else if (current === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (
      current === ";" &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      statements.push(source.slice(start, cursor + 1).trim());
      start = cursor + 1;
    }

    cursor += 1;
  }

  const tail = source.slice(start).trim();
  if (tail.length > 0) {
    statements.push(tail);
  }

  return statements;
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
  const captureArguments = assignment.captures
    ?.map(capture => capture.name)
    .join(", ") ?? "";

  const declarationPrefix = assignment.isReassignment
    ? ""
    : `${assignment.interfaceName} `;

  return `${assignment.indent}${declarationPrefix}${assignment.variableName} = new ${assignment.implementationName}(${captureArguments});`;
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
  funcTypeAliases: Map<string, FuncTypeAlias>,
  options: {
    mode: ApexXUnitMode;
    naming: SharedTypeNaming;
    /** Tuple carriers to declare inline, already rendered. */
    inlineDeclarations: string[];
  },
): { output: string; map: PositionMap } {
  const supportedAssignments = assignments.filter(
    assignment =>
      assignment.interfaceName &&
      assignment.implementationName &&
      assignment.parameterTypes.length === assignment.lambda.parameters.length,
  );

  if (options.mode === "anonymous") {
    // A block-level declaration is an inner type, so the interfaces and tuple
    // carriers are declared flat beside the statements rather than nested in a
    // registry class. Interfaces come first, so each implementation follows the
    // type it implements. With `deployed` naming the block refers to the registry
    // members instead, and declares only the lambdas it defines itself.
    const declarations = [
      ...(options.naming === "flat"
        ? [...funcTypeAliases.values()].map(alias =>
            renderFuncInterfaceDeclaration(alias, ""),
          )
        : []),
      ...options.inlineDeclarations,
      ...supportedAssignments.map(assignment =>
        renderFuncImplementationDeclaration(assignment, "", funcVariableNames),
      ),
    ];

    if (declarations.length === 0) {
      return { output: source, map: identityMap(source.length) };
    }

    return applySplices(source, [
      { start: 0, end: 0, replacement: `${declarations.join("\n\n")}\n\n` },
    ]);
  }

  if (supportedAssignments.length === 0) {
    return { output: source, map: identityMap(source.length) };
  }

  const classStart = findClassBodyStart(source);
  if (classStart === undefined) {
    return { output: source, map: identityMap(source.length) };
  }

  const implementations = supportedAssignments
    .map(assignment => renderFuncImplementationDeclaration(assignment, "    ", funcVariableNames))
    .join("\n\n");
  const declarations = implementations;

  return applySplices(source, [
    { start: classStart, end: classStart, replacement: `\n${declarations}\n` },
  ]);
}

function renderFuncInterfaceDeclaration(
  alias: FuncTypeAlias,
  indent: string,
): string {
  const inner = `${indent}    `;
  const parameterText = alias.parameterTypes
    .map((parameterType, index) => `${toApexType(parameterType)} arg${index}`)
    .join(", ");
  const returnType = toApexType(alias.returnType);

  return [
    `${indent}public interface ${sharedTypeMemberName(alias.interfaceName)} {`,
    `${inner}${returnType} invoke(${parameterText});`,
    `${indent}}`,
  ].join("\n");
}

function createFuncSupportClasses(
  aliases: Map<string, FuncTypeAlias>,
  naming: SharedTypeNaming,
): GeneratedApexSupportClass[] {
  // Flat naming means the unit declares these interfaces itself.
  if (aliases.size === 0 || naming === "flat") {
    return [];
  }

  return [renderStructuralRegistry(
    FUNC_REGISTRY_CLASS,
    [...aliases.values()].map(alias => ({
      name: sharedTypeMemberName(alias.interfaceName),
      source: renderFuncInterfaceDeclaration(alias, "    "),
    })),
  )];
}

function deduplicateSupportClasses(
  supportClasses: GeneratedApexSupportClass[],
): GeneratedApexSupportClass[] {
  const byName = new Map<string, GeneratedApexSupportClass>();
  for (const supportClass of supportClasses) {
    byName.set(supportClass.className, supportClass);
  }
  return [...byName.values()];
}

function renderFuncImplementationDeclaration(
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
  const captures = assignment.captures ?? [];
  const parameterText = parameters
    .map(parameter => `${parameter.type} ${parameter.name}`)
    .join(", ");
  const constructorText = captures
    .map(capture => `${capture.type} ${capture.name}`)
    .join(", ");
  const fields = captures
    .map(capture => `${inner}private ${capture.type} ${capture.name};`);
  const constructor = captures.length > 0
    ? [
        `${inner}public ${assignment.implementationName}(${constructorText}) {`,
        ...captures.map(capture => `${nested}this.${capture.name} = ${capture.name};`),
        `${inner}}`,
        "",
      ]
    : [];
  const returnType = toApexType(assignment.returnType);
  const blockBody = isBlockLambdaBody(assignment.lambda.body)
    ? renderFuncBlockLambdaBody(
        assignment.lambda.body,
        nested,
        funcVariableNames,
      )
    : undefined;

  return [
    `${indent}private class ${assignment.implementationName} implements ${assignment.interfaceName} {`,
    ...fields,
    ...(fields.length > 0 ? [""] : []),
    ...constructor,
    `${inner}public ${returnType} invoke(${parameterText}) {`,
    ...(blockBody ?? [
      `${nested}return ${rewriteFuncInvocations(assignment.lambda.body, funcVariableNames)};`,
    ]),
    `${inner}}`,
    `${indent}}`,
  ].join("\n");
}

function renderFuncBlockLambdaBody(
  body: string,
  indent: string,
  funcVariableNames: Set<string>,
): string[] {
  const inner = body.trim().slice(1, -1).replace(/^\s*\r?\n/, "").replace(/\r?\n\s*$/, "");
  const lines = inner.split(/\r?\n/);
  const nonEmptyIndents = lines
    .filter(line => line.trim().length > 0)
    .map(line => /^(\s*)/.exec(line)?.[1].length ?? 0);
  const commonIndent = nonEmptyIndents.length > 0
    ? Math.min(...nonEmptyIndents)
    : 0;
  const normalized = lines.map(line => line.slice(commonIndent)).join("\n");

  return rewriteFuncInvocations(normalized, funcVariableNames)
    .split(/\r?\n/)
    .map(line => `${indent}${line}`);
}

function collectFuncTypeAliases(
  source: string,
  _usedNames: Set<string>,
  naming: SharedTypeNaming,
): Map<string, FuncTypeAlias> {
  const aliases = new Map<string, FuncTypeAlias>();
  const pattern = /Func\s*<\s*([^>\r\n]+?)\s*>/g;

  for (const match of source.matchAll(pattern)) {
    const typeArguments = splitCommaList(match[1]);

    if (typeArguments.length < 1) {
      continue;
    }

    const parameterTypes = typeArguments.slice(0, -1).map(toApexType);
    const returnType = toApexType(typeArguments.at(-1) ?? "Object");

    // The scan covers the authored source as well as the lowered one, so a Func
    // carrying a tuple is seen twice: once as `(Integer, Integer)` and once as the
    // carrier the tuple pass rewrote it to. Only the lowered form is a real Apex
    // type, and registering the other would emit an interface returning a tuple
    // literal type.
    if ([...parameterTypes, returnType].some(type => type.startsWith("("))) {
      continue;
    }

    const signature = funcSignatureKey(parameterTypes, returnType);

    if (!aliases.has(signature)) {
      aliases.set(signature, {
        interfaceName: sharedFuncTypeName(parameterTypes, returnType, naming),
        parameterTypes,
        returnType,
      });
    }
  }

  return aliases;
}

// The text-level pass below rewrites every `Func<...>` the source contains.
// Generated capture fields never go through it, so they need the same lookup.
function lowerFuncTypeReference(
  type: string | undefined,
  aliases: Map<string, FuncTypeAlias>,
): string | undefined {
  if (type === undefined) {
    return undefined;
  }

  const match = /^Func\s*<\s*([^>\r\n]+?)\s*>$/.exec(type.trim());

  if (!match) {
    return type;
  }

  const typeArguments = splitCommaList(match[1] ?? "");

  if (typeArguments.length < 1) {
    return type;
  }

  const parameterTypes = typeArguments.slice(0, -1).map(toApexType);
  const returnType = toApexType(typeArguments.at(-1) ?? "Object");

  return aliases.get(funcSignatureKey(parameterTypes, returnType))?.interfaceName
    ?? type;
}

function replaceFuncTypeReferences(
  source: string,
  aliases: Map<string, FuncTypeAlias>,
): { output: string; map: PositionMap } {
  const splices = splicesFromReplace(
    source,
    /Func\s*<\s*([^>\r\n]+?)\s*>/g,
    match => {
      const typeArguments = splitCommaList(match[1] ?? "");
      const parameterTypes = typeArguments.slice(0, -1).map(toApexType);
      const returnType = toApexType(typeArguments.at(-1) ?? "Object");

      return aliases.get(funcSignatureKey(parameterTypes, returnType))?.interfaceName;
    },
  );

  return applySplices(source, splices);
}

function collectFuncVariableNames(
  declaredVariables: Map<string, string>,
  assignments: FuncLambdaAssignment[],
): Set<string> {
  const names = new Set(assignments.map(assignment => assignment.variableName));

  for (const [variableName, typeName] of declaredVariables.entries()) {
    if (isFuncType(typeName)) {
      names.add(variableName);
    }
  }

  return names;
}

function completeFuncLambdaAssignmentTypes(
  assignment: FuncLambdaAssignment,
  declaredVariables: Map<string, string>,
): void {
  if (!assignment.isReassignment) {
    return;
  }

  const funcType = declaredVariables.get(assignment.variableName.toLowerCase());
  const typeArguments = funcType ? extractFuncTypeArguments(funcType) : [];

  if (typeArguments.length === 0) {
    return;
  }

  assignment.sourceFuncType = funcType ?? "";
  assignment.parameterTypes = typeArguments.slice(0, -1);
  assignment.returnType = typeArguments.at(-1) ?? "Object";
}

function extractFuncTypeArguments(typeName: string): string[] {
  const match = /^Func\s*<\s*(.+)\s*>$/i.exec(typeName.trim());
  return match ? splitCommaList(match[1]).map(toApexType) : [];
}

function isFuncType(typeName: string): boolean {
  return /^Func\s*</i.test(typeName.trim());
}

function funcSignatureKey(parameterTypes: string[], returnType: string): string {
  return [...parameterTypes.map(toApexType), toApexType(returnType)].join("=>");
}

function inferCapturedVariables(
  assignment: FuncLambdaAssignment,
  declaredVariables: Map<string, string>,
  funcLambdaAssignments: FuncLambdaAssignment[],
  funcTypeAliases: Map<string, FuncTypeAlias>,
): CapturedVariable[] {
  const captures: CapturedVariable[] = [];
  const capturedNames = new Set<string>();
  const parameterNames = new Set(
    assignment.lambda.parameters.map(parameter => parameter.name.toLowerCase()),
  );
  const lambdaLocalNames = new Set(
    collectDeclaredVariables(assignment.lambda.body).keys(),
  );
  const funcAssignmentsByName = new Map(
    funcLambdaAssignments.map(funcAssignment => [
      funcAssignment.variableName.toLowerCase(),
      funcAssignment,
    ]),
  );
  const identifiers = collectIdentifierUsages(assignment.lambda.body);

  for (const identifier of identifiers) {
    const normalized = identifier.name.toLowerCase();

    if (
      parameterNames.has(normalized) ||
      lambdaLocalNames.has(normalized) ||
      normalized === assignment.variableName.toLowerCase() ||
      capturedNames.has(normalized) ||
      identifier.isMemberName
    ) {
      continue;
    }

    const capturedFunc = funcAssignmentsByName.get(normalized);
    // A captured variable that is itself a Func -- a parameter, a loop variable,
    // or a copy of another Func -- is not a lambda assignment, so its declared
    // type is the authored `Func<...>`. The generated inner class has to declare
    // the field with the lowered interface name: `Func` is not an Apex type, and
    // emitting it produces a class that only fails when the org compiles it.
    const capturedType = capturedFunc?.interfaceName
      ?? lowerFuncTypeReference(declaredVariables.get(normalized), funcTypeAliases);

    if (!capturedType) {
      continue;
    }

    captures.push({
      name: identifier.name,
      type: toApexType(capturedType),
    });
    capturedNames.add(normalized);
  }

  return captures;
}

function collectIdentifierUsages(
  source: string,
): Array<{ name: string; isMemberName: boolean }> {
  const usages: Array<{ name: string; isMemberName: boolean }> = [];
  const pattern = /\b[A-Za-z][A-Za-z0-9_]*\b/g;

  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const before = source.slice(0, start).trimEnd();

    usages.push({
      name: match[0],
      isMemberName: before.endsWith("."),
    });
  }

  return usages;
}

/**
 * Reports a structural value that crosses into a type the script does not declare.
 *
 * A `Func` or tuple from a deployed ApexX class is a member of the deployed
 * registry, and a script that declares its structural types inline names them
 * flat. The two are different Apex types with the same signature, so the platform
 * rejects the assignment with a message that names neither the script nor the
 * fix. Reported here instead.
 */
function checkStructuralTypeBoundaries(source: string): ApexXDiagnostic[] {
  const diagnostics: ApexXDiagnostic[] = [];
  const declaredTypes = new Set<string>();

  for (const match of source.matchAll(
    /\b(?:class|interface|enum)\s+([A-Za-z][A-Za-z0-9_]*)/g,
  )) {
    declaredTypes.add(match[1].toLowerCase());
  }

  // A tuple destructuring, and a Func declaration, initialised from `Type.method(`.
  const patterns = [
    /^[ \t]*\(([^()\r\n]*(?:Func\s*<[^>\r\n]*>[^()\r\n]*)?[^()\r\n]*)\)\s*=(?!>)\s*([A-Za-z][A-Za-z0-9_]*)\s*\.\s*[A-Za-z][A-Za-z0-9_]*\s*\(/gm,
    /^[ \t]*Func\s*<[^>\r\n]+>\s+[A-Za-z][A-Za-z0-9_]*\s*=\s*([A-Za-z][A-Za-z0-9_]*)\s*\.\s*[A-Za-z][A-Za-z0-9_]*\s*\(/gm,
  ];

  for (const [index, pattern] of patterns.entries()) {
    for (const match of source.matchAll(pattern)) {
      const owner = index === 0 ? match[2] : match[1];

      if (declaredTypes.has(owner.toLowerCase())) {
        continue;
      }

      const start = match.index ?? 0;
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        code: "APXX2630",
        message: `this value comes from ${owner}, so its type is a member of the deployed ApexXFuncs or ApexXTuples registry, but this script declares its structural types inline. Build it with --script-types deployed (or set apexx.scriptStructuralTypes to "deployed") and deploy those registries.`,
        range: createRange(source, start + (match[0].match(/^[ \t]*/)?.[0].length ?? 0), start + match[0].length),
      });
    }
  }

  return diagnostics;
}

function findClassBodyStart(source: string): number | undefined {
  const match = /\bclass\s+[A-Za-z][A-Za-z0-9_]*[^{]*\{/.exec(source);
  return match ? match.index + match[0].length : undefined;
}

/** Header plus trailing-whitespace trim, for generated support classes that have
 * no authored counterpart and so need no position mapping. */
function addHeader(source: string, sourceFileName?: string): string {
  return headerText(sourceFileName) + source.replace(/[ \t]+$/gm, "");
}

function headerText(sourceFileName?: string): string {
  const sourceLine = sourceFileName ? `// Source: ${sourceFileName}\n` : "";
  return `// AUTO-GENERATED BY ApexX.\n${sourceLine}// DO NOT EDIT.\n\n`;
}

/** Trailing whitespace is stripped as splices so the stage reports its offsets. */
function trimTrailingWhitespaceSplices(source: string): Splice[] {
  return splicesFromReplace(source, /[ \t]+$/gm, () => "");
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
