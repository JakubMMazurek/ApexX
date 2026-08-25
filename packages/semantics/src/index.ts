import fs from "node:fs";
import path from "node:path";
import type {
  ApexXDiagnostic,
  FuncLambdaAssignment,
  LambdaExpression,
  ListMethodCallExpression,
  ListMethodResultKind,
  ListTypeInfo,
  SourcePosition,
  SourceRange,
} from "@apexx/ast";

const identifierPattern = /\b[A-Za-z][A-Za-z0-9_]*\b/g;
const listDeclarationPattern =
  /\bList\s*<\s*([A-Za-z][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z][A-Za-z0-9_]*)?)\s*>\s+([A-Za-z][A-Za-z0-9_]*)\b/g;
const methodReturningPattern =
  /\b(?:public|private|protected|global|static|final|virtual|abstract|override|webservice|testmethod|\s)*((?:List|Set)\s*<\s*[A-Za-z][A-Za-z0-9_.]*\s*>|Map\s*<\s*[A-Za-z][A-Za-z0-9_.]*\s*,\s*[A-Za-z][A-Za-z0-9_.]*\s*>|[A-Za-z][A-Za-z0-9_.]*)\s+[A-Za-z][A-Za-z0-9_]*\s*\([^;{}]*\)\s*\{/g;

export interface ApexXTypeProvider {
  getFieldType?: (receiverType: string, fieldName: string) => string | undefined;
  getMethodReturnType?: (
    receiverType: string,
    methodName: string,
    argumentTypes: string[],
  ) => string | undefined;
  getStaticMethodReturnType?: (
    typeName: string,
    methodName: string,
    argumentTypes: string[],
  ) => string | undefined;
}

export interface ExpressionTypeScope {
  variables?: Map<string, string>;
  typeProvider?: ApexXTypeProvider;
}

export interface InferListMethodChainTypesOptions {
  source: string;
  call: ListMethodCallExpression;
  receiverElementType: string;
  expectedResultElementType?: string;
  expectedResultType?: string;
  variables?: Map<string, string>;
  typeProvider?: ApexXTypeProvider;
}

export interface InferListMethodChainTypesResult {
  inputTypes: string[];
  resultTypes: string[];
  resultKinds: ListMethodResultKind[];
  finalElementType: string;
  finalType: string;
  finalKind: ListMethodResultKind;
  diagnostics: ApexXDiagnostic[];
}

export interface SObjectFieldTypeInfo {
  name: string;
  type: string;
  referenceTo?: string[];
}

interface SObjectSchemaFile {
  fields?: SObjectFieldTypeInfo[];
}

const schemaCache = new Map<string, SObjectFieldTypeInfo[] | undefined>();
const commonSObjectFields: SObjectFieldTypeInfo[] = [
  field("Id", "id"),
  field("OwnerId", "reference", ["User", "Group"]),
  field("CreatedDate", "datetime"),
  field("CreatedById", "reference", ["User"]),
  field("LastModifiedDate", "datetime"),
  field("LastModifiedById", "reference", ["User"]),
  field("SystemModstamp", "datetime"),
  field("IsDeleted", "boolean"),
];
const fallbackSObjectFields: Record<string, SObjectFieldTypeInfo[]> = {
  account: [
    ...commonSObjectFields,
    field("Name", "string"),
    field("Rating", "picklist"),
    field("Type", "picklist"),
    field("Industry", "picklist"),
    field("Phone", "phone"),
    field("Fax", "phone"),
    field("Website", "url"),
    field("AccountNumber", "string"),
    field("AccountSource", "picklist"),
    field("AnnualRevenue", "currency"),
    field("NumberOfEmployees", "int"),
    field("ParentId", "reference", ["Account"]),
    field("Description", "textarea"),
    field("Site", "string"),
    field("BillingStreet", "textarea"),
    field("BillingCity", "string"),
    field("BillingState", "string"),
    field("BillingPostalCode", "string"),
    field("BillingCountry", "string"),
    field("ShippingStreet", "textarea"),
    field("ShippingCity", "string"),
    field("ShippingState", "string"),
    field("ShippingPostalCode", "string"),
    field("ShippingCountry", "string"),
    field("LastActivityDate", "date"),
    field("LastViewedDate", "datetime"),
    field("LastReferencedDate", "datetime"),
    field("Contacts", "List<Contact>"),
  ],
  contact: [
    ...commonSObjectFields,
    field("AccountId", "reference", ["Account"]),
    field("FirstName", "string"),
    field("LastName", "string"),
    field("Name", "string"),
    field("Email", "email"),
    field("Phone", "phone"),
    field("Title", "string"),
  ],
};

export function indexToPosition(source: string, offset: number): SourcePosition {
  let line = 1;
  let column = 0;

  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }

  return { offset, line, column };
}

export function createRange(
  source: string,
  startOffset: number,
  endOffset: number,
): SourceRange {
  return {
    start: indexToPosition(source, startOffset),
    end: indexToPosition(source, endOffset),
  };
}

export function isApexIdentifier(name: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9_]*$/.test(name) &&
    !name.endsWith("_") &&
    !name.includes("__")
  );
}

export function collectIdentifiers(source: string): Set<string> {
  const identifiers = new Set<string>();

  for (const match of source.matchAll(identifierPattern)) {
    identifiers.add(match[0]);
  }

  return identifiers;
}

export function collectListVariables(source: string): Map<string, ListTypeInfo> {
  const masked = maskCommentsAndStrings(source);
  const variables = new Map<string, ListTypeInfo>();

  for (const match of masked.matchAll(listDeclarationPattern)) {
    const elementType = normalizeType(match[1]);
    const variableName = match[2];
    const nextCharacter = masked
      .slice((match.index ?? 0) + match[0].length)
      .trimStart()[0];

    if (nextCharacter === "(") {
      continue;
    }

    variables.set(variableName, {
      collectionType: "List",
      elementType,
      variableName,
    });
  }

  return variables;
}

export function collectDeclaredVariables(source: string): Map<string, string> {
  const variables = new Map<string, string>();
  const masked = maskCommentsAndStrings(source);
  const declarationPattern =
    /\b(Func\s*<\s*[^>\r\n]+?\s*>|(?:List|Set)\s*<\s*[A-Za-z][A-Za-z0-9_.]*\s*>|Map\s*<\s*[A-Za-z][A-Za-z0-9_.]*\s*,\s*[A-Za-z][A-Za-z0-9_.]*\s*>|DateTime|Datetime|Date|String|string|Integer|int|Long|Decimal|Double|Boolean|bool|Id|Object|[A-Za-z][A-Za-z0-9_.]*)\s+([A-Za-z][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = declarationPattern.exec(masked)) !== null) {
    const typeName = toApexType(match[1]);
    const variableName = match[2];
    const nextCharacter = masked
      .slice((match.index ?? 0) + match[0].length)
      .trimStart()[0];

    if (
      nextCharacter !== "(" &&
      isLikelyDeclaration(masked, match.index, typeName)
    ) {
      variables.set(variableName.toLowerCase(), typeName);
    }
  }

  return variables;
}

export function extractListElementType(typeName: string): string | undefined {
  const match =
    /^\s*List\s*<\s*([A-Za-z][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z][A-Za-z0-9_]*)?)\s*>/i.exec(
      typeName,
    );

  return match ? normalizeType(match[1]) : undefined;
}

function extractFuncReturnType(typeName: string): string | undefined {
  const match = /^Func\s*<\s*(.+)\s*>$/i.exec(typeName);

  if (!match) {
    return undefined;
  }

  const typeArguments = splitCommaList(match[1]);
  const returnType = typeArguments.at(-1);

  return returnType ? toApexType(returnType) : undefined;
}

export function findEnclosingListReturnElementType(
  source: string,
  offset: number,
): string | undefined {
  const returnType = findEnclosingMethodReturnType(source, offset);
  return returnType ? extractListElementType(returnType) : undefined;
}

export function findEnclosingMethodReturnType(
  source: string,
  offset: number,
): string | undefined {
  return findEnclosingReturnType(source, offset, methodReturningPattern);
}

export function createApexTypeProvider(
  options: { workspaceRoot?: string } = {},
): ApexXTypeProvider {
  return {
    getFieldType: (receiverType, fieldName) =>
      getSObjectFieldType(receiverType, fieldName, options.workspaceRoot),
  };
}

export function inferExpressionType(
  expression: string,
  scope: ExpressionTypeScope = {},
): string | undefined {
  const trimmed = stripOuterParentheses(expression.trim());

  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^null$/i.test(trimmed)) {
    return "Null";
  }

  if (/^'(?:\\.|[^'\\])*'$/.test(trimmed)) {
    return "String";
  }

  if (/^(?:true|false)$/i.test(trimmed)) {
    return "Boolean";
  }

  if (/^\d+$/.test(trimmed)) {
    return "Integer";
  }

  if (/^\d+\.\d+$/.test(trimmed)) {
    return "Decimal";
  }

  const conditional = findTopLevelConditional(trimmed);
  if (conditional) {
    return mergeBranchTypes(
      inferExpressionType(conditional.whenTrue, scope),
      inferExpressionType(conditional.whenFalse, scope),
    );
  }

  if (findTopLevelOperator(trimmed, ["||", "&&"])) {
    return "Boolean";
  }

  if (findTopLevelOperator(trimmed, ["==", "!=", ">=", "<=", ">", "<"])) {
    return "Boolean";
  }

  if (trimmed.startsWith("!")) {
    return "Boolean";
  }

  const additiveOperator = findTopLevelOperator(trimmed, ["+", "-"]);
  if (additiveOperator) {
    const leftType = inferExpressionType(
      trimmed.slice(0, additiveOperator.index),
      scope,
    );
    const rightType = inferExpressionType(
      trimmed.slice(additiveOperator.index + additiveOperator.operator.length),
      scope,
    );
    return inferAdditiveResultType(additiveOperator.operator, leftType, rightType);
  }

  const multiplicativeOperator = findTopLevelOperator(trimmed, ["*", "/"]);
  if (multiplicativeOperator) {
    const leftType = inferExpressionType(
      trimmed.slice(0, multiplicativeOperator.index),
      scope,
    );
    const rightType = inferExpressionType(
      trimmed.slice(multiplicativeOperator.index + multiplicativeOperator.operator.length),
      scope,
    );
    return inferNumericResultType(leftType, rightType);
  }

  const newExpression = /^new\s+([A-Za-z][A-Za-z0-9_.]*(?:\s*<\s*[^>]+\s*>)?)\s*\(/.exec(
    trimmed,
  );
  if (newExpression) {
    return normalizeType(newExpression[1]);
  }

  const funcInvocation = /^([A-Za-z][A-Za-z0-9_]*)\s*\((.*)\)$/.exec(trimmed);
  if (funcInvocation) {
    const funcType = lookupVariableType(scope.variables, funcInvocation[1]);
    const returnType = funcType ? extractFuncReturnType(funcType) : undefined;

    if (returnType) {
      return returnType;
    }
  }

  return inferChainExpressionType(trimmed, scope);
}

export interface FuncLambdaReturnCheckOptions {
  source: string;
  assignment: FuncLambdaAssignment;
  variables?: Map<string, string>;
  typeProvider?: ApexXTypeProvider;
}

/**
 * Checks a Func lambda against the return type its `Func<...>` declaration promises.
 *
 * The lowering drops the lambda body into `invoke()` on a generated class, so a body
 * that returns the wrong type produces Apex that only the platform compiler rejects,
 * naming a class the user never wrote. Each `return` is checked separately, because a
 * block lambda may legitimately have several.
 */
export function checkFuncLambdaReturnTypes(
  options: FuncLambdaReturnCheckOptions,
): ApexXDiagnostic[] {
  const { assignment } = options;
  const expectedType = toApexType(assignment.returnType ?? "");

  // Nothing was promised: an untyped reassignment, or a Func whose declaration this
  // file cannot see.
  if (!expectedType || expectedType === "Object" || /^void$/i.test(expectedType)) {
    return [];
  }

  const variables = new Map(
    options.variables ?? collectDeclaredVariables(options.source),
  );

  assignment.lambda.parameters.forEach((parameter, index) => {
    const parameterType = assignment.parameterTypes[index];

    if (parameterType) {
      variables.set(parameter.name.toLowerCase(), toApexType(parameterType));
    }
  });

  const scope = { variables, typeProvider: options.typeProvider };
  // Rendered from the parts rather than echoed from the source, so a declaration and
  // a later reassignment of the same variable read identically.
  const declaredType = `Func<${[...assignment.parameterTypes, assignment.returnType]
    .map(toApexType)
    .join(", ")}>`;
  const diagnostics: ApexXDiagnostic[] = [];

  for (const returned of lambdaReturnExpressions(assignment.lambda)) {
    const actualType = inferExpressionType(returned.expression, scope);

    if (!actualType || isCompatibleApexType(expectedType, actualType)) {
      continue;
    }

    diagnostics.push({
      severity: "error",
      source: "apexx-semantics",
      message: `${declaredType} must return ${expectedType}, but this returns ${actualType}.`,
      range: createRange(
        options.source,
        returned.start,
        returned.end,
      ),
    });
  }

  return diagnostics;
}

interface ReturnedExpression {
  expression: string;
  start: number;
  end: number;
}

/**
 * The expressions a lambda hands back: the body itself for an expression lambda, or
 * every top-level `return` for a block lambda. Offsets are absolute, so a diagnostic
 * lands on the `return` at fault rather than on the whole lambda.
 */
function lambdaReturnExpressions(lambda: LambdaExpression): ReturnedExpression[] {
  const bodyStart = lambda.bodyRange.start.offset;

  if (!isBlockLambdaBody(lambda.body)) {
    return [
      { expression: lambda.body, start: bodyStart, end: lambda.bodyRange.end.offset },
    ];
  }

  const masked = maskCommentsAndStrings(lambda.body);
  const returned: ReturnedExpression[] = [];

  for (const match of masked.matchAll(/\breturn\b/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const semicolon = topLevelSemicolon(masked, start);

    if (semicolon === undefined) {
      continue;
    }

    const expression = lambda.body.slice(start, semicolon).trim();

    if (expression.length === 0) {
      continue;
    }

    const leading = lambda.body.slice(start, semicolon).length
      - lambda.body.slice(start, semicolon).trimStart().length;
    returned.push({
      expression,
      start: bodyStart + start + leading,
      end: bodyStart + start + leading + expression.length,
    });
  }

  return returned;
}

function topLevelSemicolon(masked: string, start: number): number | undefined {
  let depth = 0;

  for (let index = start; index < masked.length; index += 1) {
    const current = masked[index];

    if (current === "(" || current === "[" || current === "{") {
      depth += 1;
    } else if (current === ")" || current === "]" || current === "}") {
      depth -= 1;
    } else if (current === ";" && depth <= 0) {
      return index;
    }
  }

  return undefined;
}

export function inferListMethodChainTypes(
  options: InferListMethodChainTypesOptions,
): InferListMethodChainTypesResult {
  const diagnostics: ApexXDiagnostic[] = [];
  const inputTypes: string[] = [];
  const resultTypes: string[] = [];
  const resultKinds: ListMethodResultKind[] = [];
  const baseVariables = options.variables ?? collectDeclaredVariables(options.source);
  const expectedResultType = inferExpectedResultType(options);
  const expectedListElementType = expectedResultType
    ? extractListElementType(expectedResultType)
    : options.expectedResultElementType;
  let currentType = toApexType(options.receiverElementType);
  let currentKind: ListMethodResultKind = "list";

  for (const [index, step] of options.call.steps.entries()) {
    if (currentKind !== "list") {
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        message: `${step.methodName}(...) cannot run after a list method that returns ${currentType}.`,
        range: step.range,
      });
      break;
    }

    inputTypes.push(currentType);

    const variables = new Map(baseVariables);
    for (const listVariable of collectListVariables(options.source).values()) {
      variables.set(
        listVariable.variableName.toLowerCase(),
        `List<${toApexType(listVariable.elementType)}>`,
      );
    }
    variables.set(step.lambda.parameterName.toLowerCase(), currentType);

    const blockReturnExpression = finalBlockLambdaReturnExpression(step.lambda.body);
    const invalidBlockLambda = isBlockLambdaBody(step.lambda.body)
      && blockReturnExpression === undefined;
    if (invalidBlockLambda) {
      diagnostics.push({
        severity: "error",
        source: "apexx-semantics",
        message: `${step.methodName}(...) block lambda must finish with one top-level return expression.`,
        range: step.lambda.range,
      });
    }

    const bodyType = inferExpressionType(blockReturnExpression ?? step.lambda.body, {
      variables,
      typeProvider: options.typeProvider,
    });

    if (isPredicateMethod(step.methodName)) {
      if (bodyType && !isAssignableType("Boolean", bodyType)) {
        diagnostics.push({
          severity: "error",
          source: "apexx-semantics",
          message: `${step.methodName}(...) expects a Boolean predicate, but this lambda returns ${bodyType}.`,
          range: step.lambda.range,
        });
      }
    }

    if (step.methodName === "filter") {
      currentKind = "list";
    } else if (step.methodName === "map") {
      const isLastStep = index === options.call.steps.length - 1;
      const fallbackType = isLastStep
        ? expectedListElementType
        : undefined;
      const mappedType = bodyType ?? fallbackType;

      if (!mappedType) {
        diagnostics.push({
          severity: "error",
          source: "apexx-semantics",
          message: `Cannot infer map(...) result type from '${step.lambda.body}'. Add a typed intermediate List<T> assignment.`,
          range: step.lambda.range,
        });
      } else {
        currentType = toApexType(mappedType);
      }
      currentKind = "list";
    } else if (step.methodName === "flatMap") {
      const isLastStep = index === options.call.steps.length - 1;
      const fallbackType = isLastStep ? expectedListElementType : undefined;
      const flattenedType = bodyType
        ? extractListElementType(bodyType)
        : fallbackType;

      if (bodyType && !extractListElementType(bodyType)) {
        diagnostics.push({
          severity: "error",
          source: "apexx-semantics",
          message: `flatMap(...) expects a lambda that returns List<R>, but this lambda returns ${bodyType}.`,
          range: step.lambda.range,
        });
      } else if (!flattenedType) {
        diagnostics.push({
          severity: "error",
          source: "apexx-semantics",
          message: `Cannot infer flatMap(...) result type from '${step.lambda.body}'. Return a List<R> expression or add typed context.`,
          range: step.lambda.range,
        });
      } else {
        currentType = toApexType(flattenedType);
      }
      currentKind = "list";
    } else if (step.methodName === "any" || step.methodName === "all") {
      currentType = "Boolean";
      currentKind = "scalar";
    } else if (step.methodName === "count") {
      currentType = "Integer";
      currentKind = "scalar";
    } else {
      currentKind = "scalar";
    }

    resultTypes.push(currentType);
    resultKinds.push(currentKind);
  }

  const finalType = currentKind === "list" ? `List<${currentType}>` : currentType;

  if (expectedResultType && !isAssignableType(expectedResultType, finalType)) {
    diagnostics.push({
      severity: "error",
      source: "apexx-semantics",
      message: `List chain returns ${finalType}, but the surrounding context expects ${toApexType(expectedResultType)}.`,
      range: options.call.range,
    });
  }

  return {
    inputTypes,
    resultTypes,
    resultKinds,
    finalElementType: currentType,
    finalType,
    finalKind: currentKind,
    diagnostics,
  };
}

function isBlockLambdaBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function finalBlockLambdaReturnExpression(body: string): string | undefined {
  if (!isBlockLambdaBody(body)) {
    return undefined;
  }

  const inner = body.trim().slice(1, -1).trim();
  const match = /(?:^|[;}])\s*return\s+([\s\S]+);\s*$/.exec(inner);
  if (!match) {
    return undefined;
  }

  const beforeReturn = inner.slice(0, match.index + (match[0].startsWith("return") ? 0 : 1));
  if (/\breturn\b/.test(beforeReturn)) {
    return undefined;
  }

  return match[1].trim();
}

export function findAvailableName(prefix: string, usedNames: Set<string>): string {
  let suffix = 0;

  while (usedNames.has(`${prefix}${suffix}`)) {
    suffix += 1;
  }

  const name = `${prefix}${suffix}`;
  usedNames.add(name);
  return name;
}

export function normalizeType(typeName: string): string {
  return typeName.replace(/\s+/g, "").replace(/\s*\.\s*/g, ".");
}

export function toApexType(typeName: string): string {
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

function inferChainExpressionType(
  expression: string,
  scope: ExpressionTypeScope,
): string | undefined {
  const segments = splitTopLevelMemberChain(expression);
  if (segments.length === 0) {
    return undefined;
  }

  let currentType = lookupVariableType(scope.variables, segments[0]);
  let staticType: string | undefined;

  if (!currentType && isKnownApexType(segments[0])) {
    staticType = toApexType(segments[0]);
  }

  if (!currentType && !staticType) {
    return undefined;
  }

  for (const segment of segments.slice(1)) {
    const methodCall = /^([A-Za-z][A-Za-z0-9_]*)\s*\((.*)\)$/.exec(segment);

    if (methodCall) {
      const methodName = methodCall[1];
      const argumentTypes = splitCommaList(methodCall[2])
        .map(argument => inferExpressionType(argument, scope))
        .filter((type): type is string => type !== undefined);

      if (staticType) {
        currentType = inferStaticMethodReturnType(
          staticType,
          methodName,
          argumentTypes,
          scope.typeProvider,
        );
        staticType = undefined;
      } else if (currentType) {
        currentType = inferMethodReturnType(
          currentType,
          methodName,
          argumentTypes,
          scope.typeProvider,
        );
      }
    } else if (currentType) {
      currentType = inferFieldType(currentType, segment, scope.typeProvider);
    } else {
      return undefined;
    }

    if (!currentType) {
      return undefined;
    }
  }

  return currentType;
}

function inferExpectedResultType(
  options: InferListMethodChainTypesOptions,
): string | undefined {
  if (options.expectedResultType) {
    return toApexType(options.expectedResultType);
  }

  if (options.expectedResultElementType) {
    return `List<${toApexType(options.expectedResultElementType)}>`;
  }

  return undefined;
}

function isPredicateMethod(methodName: string): boolean {
  return (
    methodName === "filter" ||
    methodName === "any" ||
    methodName === "all" ||
    methodName === "count" ||
    methodName === "find"
  );
}

function inferFieldType(
  receiverType: string,
  fieldName: string,
  typeProvider: ApexXTypeProvider | undefined,
): string | undefined {
  return (
    typeProvider?.getFieldType?.(receiverType, fieldName) ??
    getSObjectFieldType(receiverType, fieldName)
  );
}

function inferMethodReturnType(
  receiverType: string,
  methodName: string,
  argumentTypes: string[],
  typeProvider: ApexXTypeProvider | undefined,
): string | undefined {
  return (
    typeProvider?.getMethodReturnType?.(receiverType, methodName, argumentTypes) ??
    getBuiltInMethodReturnType(receiverType, methodName)
  );
}

function inferStaticMethodReturnType(
  typeName: string,
  methodName: string,
  argumentTypes: string[],
  typeProvider: ApexXTypeProvider | undefined,
): string | undefined {
  return (
    typeProvider?.getStaticMethodReturnType?.(typeName, methodName, argumentTypes) ??
    getBuiltInStaticMethodReturnType(typeName, methodName)
  );
}

function lookupVariableType(
  variables: Map<string, string> | undefined,
  variableName: string,
): string | undefined {
  const typeName = variables?.get(variableName.toLowerCase());
  return typeName ? toApexType(typeName) : undefined;
}

function isKnownApexType(typeName: string): boolean {
  return /^(Boolean|bool|Integer|int|Long|Decimal|Double|String|string|Id|Object|Date|Datetime|DateTime|Time|System)$/i.test(
    typeName,
  );
}

function getBuiltInMethodReturnType(
  receiverType: string,
  methodName: string,
): string | undefined {
  const normalizedType = toApexType(receiverType).toLowerCase();
  const normalizedMethod = methodName.toLowerCase();

  const table: Record<string, Record<string, string>> = {
    string: {
      abbreviate: "String",
      capitalize: "String",
      contains: "Boolean",
      endswith: "Boolean",
      equals: "Boolean",
      isblank: "Boolean",
      length: "Integer",
      replace: "String",
      split: "List<String>",
      startswith: "Boolean",
      substring: "String",
      tolowercase: "String",
      touppercase: "String",
      trim: "String",
    },
    date: {
      adddays: "Date",
      addmonths: "Date",
      addyears: "Date",
      day: "Integer",
      dayofyear: "Integer",
      daysbetween: "Integer",
      format: "String",
      month: "Integer",
      tostartofmonth: "Date",
      tostartofweek: "Date",
      year: "Integer",
    },
    datetime: {
      adddays: "Datetime",
      addhours: "Datetime",
      addminutes: "Datetime",
      addmonths: "Datetime",
      addseconds: "Datetime",
      addyears: "Datetime",
      date: "Date",
      day: "Integer",
      format: "String",
      formatgmt: "String",
      gettime: "Long",
      hour: "Integer",
      millisecond: "Integer",
      minute: "Integer",
      month: "Integer",
      second: "Integer",
      time: "Time",
      year: "Integer",
    },
    integer: {
      format: "String",
    },
    long: {
      format: "String",
    },
    decimal: {
      abs: "Decimal",
      divide: "Decimal",
      format: "String",
      intvalue: "Integer",
      longvalue: "Long",
      round: "Decimal",
      setscale: "Decimal",
    },
    id: {
      tostring: "String",
    },
    object: {
      tostring: "String",
    },
  };

  return table[normalizedType]?.[normalizedMethod];
}

function getBuiltInStaticMethodReturnType(
  typeName: string,
  methodName: string,
): string | undefined {
  const normalizedType = toApexType(typeName).toLowerCase();
  const normalizedMethod = methodName.toLowerCase();

  const table: Record<string, Record<string, string>> = {
    string: {
      valueof: "String",
      format: "String",
      isblank: "Boolean",
      isnotblank: "Boolean",
      isempty: "Boolean",
      isnotempty: "Boolean",
    },
    date: {
      newinstance: "Date",
      parse: "Date",
      today: "Date",
      valueof: "Date",
    },
    datetime: {
      newinstance: "Datetime",
      now: "Datetime",
      valueof: "Datetime",
    },
    integer: {
      valueof: "Integer",
    },
    long: {
      valueof: "Long",
    },
    decimal: {
      valueof: "Decimal",
    },
    boolean: {
      valueof: "Boolean",
    },
    system: {
      now: "Datetime",
      today: "Date",
    },
  };

  return table[normalizedType]?.[normalizedMethod];
}

function getSObjectFieldType(
  receiverType: string,
  fieldName: string,
  workspaceRoot?: string,
): string | undefined {
  const objectName = normalizeSObjectName(receiverType);
  if (!objectName) {
    return undefined;
  }

  const fields = mergeSObjectFields(
    fallbackSObjectFields[objectName.toLowerCase()] ?? [],
    readWorkspaceSObjectFields(objectName, workspaceRoot) ?? [],
  );
  const fieldInfo = fields?.find(
    candidate => candidate.name.toLowerCase() === fieldName.toLowerCase(),
  );

  return fieldInfo ? apexTypeForSObjectField(fieldInfo) : undefined;
}

function mergeSObjectFields(
  fallbackFields: SObjectFieldTypeInfo[],
  workspaceFields: SObjectFieldTypeInfo[],
): SObjectFieldTypeInfo[] {
  const merged = new Map<string, SObjectFieldTypeInfo>();

  for (const fieldInfo of fallbackFields) {
    merged.set(fieldInfo.name.toLowerCase(), fieldInfo);
  }

  for (const fieldInfo of workspaceFields) {
    merged.set(fieldInfo.name.toLowerCase(), fieldInfo);
  }

  return [...merged.values()];
}

function apexTypeForSObjectField(fieldInfo: SObjectFieldTypeInfo): string {
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

function readWorkspaceSObjectFields(
  typeName: string,
  workspaceRoot: string | undefined,
): SObjectFieldTypeInfo[] | undefined {
  if (!workspaceRoot) {
    return undefined;
  }

  const cacheKey = `${workspaceRoot}:${typeName.toLowerCase()}`;
  if (schemaCache.has(cacheKey)) {
    return schemaCache.get(cacheKey);
  }

  const schemaPath = path.join(
    workspaceRoot,
    ".apexx",
    "schema",
    "sobjects",
    `${typeName}.json`,
  );
  const fields = readSObjectSchemaFile(schemaPath);
  schemaCache.set(cacheKey, fields);
  return fields;
}

function readSObjectSchemaFile(schemaPath: string): SObjectFieldTypeInfo[] | undefined {
  if (!fs.existsSync(schemaPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as SObjectSchemaFile;
    const fields = parsed.fields?.filter(isValidSObjectField) ?? [];
    return fields.length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}

function isValidSObjectField(fieldInfo: SObjectFieldTypeInfo): boolean {
  return (
    typeof fieldInfo.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_]*(__c)?$/.test(fieldInfo.name) &&
    typeof fieldInfo.type === "string"
  );
}

function normalizeSObjectName(typeName: string): string | undefined {
  const normalized = typeName.trim().split(".").at(-1) ?? "";

  if (isKnownApexType(normalized)) {
    return undefined;
  }

  return /^[A-Za-z][A-Za-z0-9_]*(__c)?$/.test(normalized)
    ? normalized
    : undefined;
}

function inferAdditiveResultType(
  operator: string,
  leftType: string | undefined,
  rightType: string | undefined,
): string | undefined {
  if (operator === "+" && (isType(leftType, "String") || isType(rightType, "String"))) {
    return "String";
  }

  return inferNumericResultType(leftType, rightType);
}

function inferNumericResultType(
  leftType: string | undefined,
  rightType: string | undefined,
): string | undefined {
  if (!leftType || !rightType) {
    return undefined;
  }

  const left = toApexType(leftType);
  const right = toApexType(rightType);

  if (!isNumericType(left) || !isNumericType(right)) {
    return undefined;
  }

  if (left === "Decimal" || right === "Decimal" || left === "Double" || right === "Double") {
    return "Decimal";
  }

  if (left === "Long" || right === "Long") {
    return "Long";
  }

  return "Integer";
}

function isNumericType(typeName: string | undefined): boolean {
  return typeName ? /^(Integer|Long|Decimal|Double)$/i.test(toApexType(typeName)) : false;
}

function isAssignableType(expectedType: string, actualType: string): boolean {
  const expected = toApexType(expectedType);
  const actual = toApexType(actualType);

  return (
    expected === actual ||
    expected === "Object" ||
    actual === "Null"
  );
}

/** Apex widens along this chain implicitly, so a narrower value fits a wider slot. */
const numericWideningOrder = ["Integer", "Long", "Double", "Decimal"];

/**
 * Assignability as the Apex compiler applies it, for checks that run against code
 * the user wrote rather than against a type this compiler inferred.
 *
 * `isAssignableType` demands an exact match, which is the right rule when the
 * expected type was itself derived from a list chain. Here the expected type is
 * declared in the source, so rejecting the conversions Apex performs silently —
 * numeric widening, and `Id` where a `String` is wanted — would report working code
 * as broken. An unknown type on either side is treated as compatible: staying quiet
 * beats guessing.
 */
export function isCompatibleApexType(
  expectedType: string | undefined,
  actualType: string | undefined,
): boolean {
  if (!expectedType || !actualType) {
    return true;
  }

  const expected = toApexType(expectedType);
  const actual = toApexType(actualType);

  if (isAssignableType(expected, actual)) {
    return true;
  }

  const expectedRank = numericWideningOrder.indexOf(expected);
  const actualRank = numericWideningOrder.indexOf(actual);

  if (expectedRank >= 0 && actualRank >= 0) {
    return actualRank <= expectedRank;
  }

  const idAndString = new Set(["Id", "String"]);
  if (idAndString.has(expected) && idAndString.has(actual)) {
    return true;
  }

  // A declared SObject or interface type cannot be resolved here, so any type this
  // module does not model is left alone.
  return !isKnownApexType(expected) || !isKnownApexType(actual);
}


function isType(typeName: string | undefined, expectedType: string): boolean {
  return typeName ? toApexType(typeName) === expectedType : false;
}

/**
 * Splits `condition ? whenTrue : whenFalse` at its top level.
 *
 * The conditional operator binds loosest of all, so it has to be recognised before
 * any other operator: the condition itself almost always contains a comparison, and
 * reading that comparison as the whole expression types a ternary as `Boolean`.
 * Safe navigation (`?.`) and null coalescing (`??`) are not conditionals, and a
 * nested conditional in the true branch takes its own `:` with it.
 */
function findTopLevelConditional(
  expression: string,
): { whenTrue: string; whenFalse: string } | undefined {
  let depth = 0;
  let inString = false;
  let questionIndex = -1;
  let pending = 0;

  for (let index = 0; index < expression.length; index += 1) {
    const current = expression[index];
    const next = expression[index + 1];

    if (inString) {
      if (current === "'" && expression[index - 1] !== "\\") {
        inString = false;
      }
      continue;
    }

    if (current === "'") {
      inString = true;
      continue;
    }

    if (current === "(" || current === "[" || current === "{") {
      depth += 1;
      continue;
    }

    if (current === ")" || current === "]" || current === "}") {
      depth -= 1;
      continue;
    }

    if (depth !== 0) {
      continue;
    }

    if (current === "?") {
      if (next === "." || next === "?") {
        index += 1;
        continue;
      }

      if (questionIndex < 0) {
        questionIndex = index;
      } else {
        pending += 1;
      }

      continue;
    }

    if (current === ":" && questionIndex >= 0) {
      if (pending > 0) {
        pending -= 1;
        continue;
      }

      return {
        whenTrue: expression.slice(questionIndex + 1, index),
        whenFalse: expression.slice(index + 1),
      };
    }
  }

  return undefined;
}

/**
 * The type of a conditional expression, from its two branches.
 *
 * Branches that disagree on anything but numeric width leave the type unknown, so a
 * caller stays quiet rather than reporting against a guess.
 */
function mergeBranchTypes(
  leftType: string | undefined,
  rightType: string | undefined,
): string | undefined {
  if (!leftType || !rightType) {
    return undefined;
  }

  if (isType(leftType, "Null")) {
    return toApexType(rightType);
  }

  if (isType(rightType, "Null")) {
    return toApexType(leftType);
  }

  const left = toApexType(leftType);
  const right = toApexType(rightType);

  if (left === right) {
    return left;
  }

  const leftRank = numericWideningOrder.indexOf(left);
  const rightRank = numericWideningOrder.indexOf(right);

  if (leftRank >= 0 && rightRank >= 0) {
    return leftRank >= rightRank ? left : right;
  }

  return undefined;
}

function findTopLevelOperator(
  expression: string,
  operators: string[],
): { operator: string; index: number } | undefined {
  let depth = 0;
  let inString = false;

  for (let index = expression.length - 1; index >= 0; index -= 1) {
    const current = expression[index];
    const previous = expression[index - 1];

    if (inString) {
      if (current === "'" && previous !== "\\") {
        inString = false;
      }
      continue;
    }

    if (current === "'") {
      inString = true;
      continue;
    }

    if (current === ")") {
      depth += 1;
      continue;
    }

    if (current === "(") {
      depth -= 1;
      continue;
    }

    if (depth !== 0) {
      continue;
    }

    for (const operator of operators) {
      const start = index - operator.length + 1;
      if (start < 0) {
        continue;
      }

      if (expression.slice(start, index + 1) === operator) {
        if ((operator === "+" || operator === "-") && isUnarySign(expression, start)) {
          continue;
        }

        return { operator, index: start };
      }
    }
  }

  return undefined;
}

function isUnarySign(expression: string, operatorIndex: number): boolean {
  let cursor = operatorIndex - 1;

  while (cursor >= 0 && /\s/.test(expression[cursor])) {
    cursor -= 1;
  }

  if (cursor < 0) {
    return true;
  }

  return /[({[,:=+\-*/!<>|&]/.test(expression[cursor]);
}

function splitTopLevelMemberChain(expression: string): string[] {
  const segments: string[] = [];
  let cursor = 0;
  let start = 0;
  let depth = 0;
  let inString = false;

  while (cursor < expression.length) {
    const current = expression[cursor];
    const next = expression[cursor + 1];

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
    } else if (current === ")") {
      depth -= 1;
    } else if (current === "." && depth === 0) {
      segments.push(expression.slice(start, cursor).trim());
      start = cursor + 1;
    }

    cursor += 1;
  }

  segments.push(expression.slice(start).trim());
  return segments.filter(segment => segment.length > 0);
}

function stripOuterParentheses(expression: string): string {
  let current = expression;

  while (
    current.startsWith("(") &&
    current.endsWith(")") &&
    findMatchingParen(current, 0) === current.length - 1
  ) {
    current = current.slice(1, -1).trim();
  }

  return current;
}

function findMatchingParen(source: string, openParenOffset: number): number | undefined {
  let cursor = openParenOffset + 1;
  let depth = 1;
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

function splitCommaList(source: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let start = 0;
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
    } else if (current === ")") {
      depth -= 1;
    } else if (current === "," && depth === 0) {
      parts.push(source.slice(start, cursor).trim());
      start = cursor + 1;
    }

    cursor += 1;
  }

  parts.push(source.slice(start).trim());
  return parts.filter(part => part.length > 0);
}

function maskCommentsAndStrings(source: string): string {
  let output = "";
  let index = 0;
  let state: "code" | "lineComment" | "blockComment" | "string" = "code";

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "code" && current === "/" && next === "/") {
      output += "  ";
      index += 2;
      state = "lineComment";
      continue;
    }

    if (state === "code" && current === "/" && next === "*") {
      output += "  ";
      index += 2;
      state = "blockComment";
      continue;
    }

    if (state === "code" && current === "'") {
      output += " ";
      index += 1;
      state = "string";
      continue;
    }

    if (state === "lineComment") {
      output += current === "\n" ? "\n" : " ";
      index += 1;
      if (current === "\n") {
        state = "code";
      }
      continue;
    }

    if (state === "blockComment") {
      if (current === "*" && next === "/") {
        output += "  ";
        index += 2;
        state = "code";
      } else {
        output += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (state === "string") {
      if (current === "\\" && next) {
        output += "  ";
        index += 2;
      } else {
        output += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === "'") {
          state = "code";
        }
      }
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

function findMatchingBrace(source: string, openBraceOffset: number): number | undefined {
  let depth = 0;

  for (let index = openBraceOffset; index < source.length; index += 1) {
    const current = source[index];

    if (current === "{") {
      depth += 1;
    } else if (current === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function findEnclosingReturnType(
  source: string,
  offset: number,
  pattern: RegExp,
): string | undefined {
  const masked = maskCommentsAndStrings(source);
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  let returnType: string | undefined;

  while ((match = pattern.exec(masked)) !== null) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;

    if (openBrace >= offset) {
      continue;
    }

    const closeBrace = findMatchingBrace(masked, openBrace);
    if (closeBrace === undefined || offset < closeBrace) {
      returnType = toApexType(match[1]);
    }
  }

  return returnType;
}

function field(
  name: string,
  type: string,
  referenceTo: string[] = [],
): SObjectFieldTypeInfo {
  return { name, type, referenceTo };
}

function isLikelyDeclaration(
  source: string,
  matchIndex: number,
  typeName: string,
): boolean {
  const before = source.slice(Math.max(0, matchIndex - 24), matchIndex);
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
