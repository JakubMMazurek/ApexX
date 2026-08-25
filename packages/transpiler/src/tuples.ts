import {
  applySplices,
  identityMap,
  type PositionMap,
} from "./sourceMap.js";
import type { ApexXDiagnostic, GeneratedApexSupportClass } from "@apexx/ast";
import {
  collectDeclaredVariables,
  collectIdentifiers,
  createRange,
  findAvailableName,
  inferExpressionType,
  isApexIdentifier,
  isCompatibleApexType,
} from "@apexx/semantics";
import {
  normalizeSharedType,
  sharedTypeMemberName,
  sharedTupleTypeName,
  type SharedTypeNaming,
  TUPLE_REGISTRY_CLASS,
  toSharedApexType,
} from "./sharedTypes.js";
import { renderStructuralRegistry } from "./structuralRegistry.js";

interface Transformation {
  start: number;
  end: number;
  replacement: string;
}

interface TupleCarrier {
  name: string;
  types: string[];
}

interface TupleMethod {
  bodyStart: number;
  bodyEnd: number;
  carrier: TupleCarrier;
}

/** A tuple-returning method in this file, keyed by name for destructuring checks. */
interface TupleReturningMethod {
  name: string;
  types: string[];
}

interface TupleElementDeclaration {
  type: string;
  name: string;
}

interface MapTupleVariable {
  name: string;
  carrier: TupleCarrier;
}

export interface TupleLoweringResult {
  output: string;
  diagnostics: ApexXDiagnostic[];
  tupleCount: number;
  supportClasses: GeneratedApexSupportClass[];
  /**
   * Carrier declarations to place in the unit itself, for `flat` naming. Class
   * mode leaves this empty and deploys `supportClasses` instead.
   */
  inlineDeclarations: string[];
  /** Maps offsets in `output` back to the source this stage received. */
  map: PositionMap;
}

export function lowerApexXTuples(
  source: string,
  options: { naming?: SharedTypeNaming } = {},
): TupleLoweringResult {
  const naming: SharedTypeNaming = options.naming ?? "registry";
  const diagnostics: ApexXDiagnostic[] = [];
  const transformations: Transformation[] = [];
  const carriers = new Map<string, TupleCarrier>();
  const usedNames = collectIdentifiers(source);
  const methods: TupleMethod[] = [];
  const tupleReturningMethods: TupleReturningMethod[] = [];
  const variables = collectDeclaredVariables(source);
  const methodPattern =
    /^([ \t]*)((?:(?:public|private|protected|global|static|final|virtual|abstract|override|webservice|testmethod)\s+)+)(\([^()\r\n]+\))\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/gim;
  let methodMatch: RegExpExecArray | null;

  while ((methodMatch = methodPattern.exec(source)) !== null) {
    const tupleText = methodMatch[3];
    const tupleStart = (methodMatch.index ?? 0) + methodMatch[0].indexOf(tupleText);
    const parsedTypes = parseTupleReturnTypes(tupleText.slice(1, -1));

    if (parsedTypes.length < 2) {
      diagnostics.push(tupleDiagnostic(
        source,
        tupleStart,
        tupleStart + tupleText.length,
        "APXX2401",
        "A tuple must contain at least two elements.",
      ));
      continue;
    }

    if (parsedTypes.some(type => !isSupportedTupleType(type))) {
      diagnostics.push(tupleDiagnostic(
        source,
        tupleStart,
        tupleStart + tupleText.length,
        "APXX2402",
        "Every tuple element must declare a valid Apex type.",
      ));
      continue;
    }

    if (hasAuraEnabledAnnotation(source, methodMatch.index ?? 0)) {
      diagnostics.push(tupleDiagnostic(
        source,
        tupleStart,
        tupleStart + tupleText.length,
        "APXX2403",
        "Tuple return types cannot currently cross an @AuraEnabled boundary. Destructure the tuple inside Apex and return a Salesforce DTO or Map.",
      ));
      continue;
    }

    if (parsedTypes.length > 7) {
      diagnostics.push({
        severity: "warning",
        source: "apexx-semantics",
        code: "APXX2404",
        message: `This tuple contains ${parsedTypes.length} elements. Consider a named domain type if the values represent a durable concept.`,
        range: createRange(source, tupleStart, tupleStart + tupleText.length),
      });
    }

    const parameterOpen = (methodMatch.index ?? 0) + methodMatch[0].length - 1;
    const parameterClose = findMatchingDelimiter(source, parameterOpen, "(", ")");
    const bodyStart = parameterClose === undefined
      ? undefined
      : skipWhitespace(source, parameterClose + 1);
    const bodyEnd = bodyStart === undefined || source[bodyStart] !== "{"
      ? undefined
      : findMatchingDelimiter(source, bodyStart, "{", "}");

    if (bodyStart === undefined || bodyEnd === undefined) {
      diagnostics.push(tupleDiagnostic(
        source,
        tupleStart,
        tupleStart + tupleText.length,
        "APXX2405",
        "Unable to locate the body of this tuple-returning method.",
      ));
      continue;
    }

    const carrier = getOrCreateCarrier(parsedTypes, carriers, usedNames, naming);
    methods.push({ bodyStart, bodyEnd, carrier });
    tupleReturningMethods.push({ name: methodMatch[4], types: parsedTypes });
    transformations.push({
      start: tupleStart,
      end: tupleStart + tupleText.length,
      replacement: carrier.name,
    });
  }

  for (const method of methods) {
    collectTupleReturns(source, method, transformations, diagnostics, variables);
  }

  const mapTupleVariables = collectMapTupleTypes(
    source,
    transformations,
    diagnostics,
    carriers,
    usedNames,
    naming,
  );
  collectMapTupleValues(
    source,
    mapTupleVariables,
    transformations,
    diagnostics,
    variables,
  );

  // Before destructuring, so a Func that returns a tuple is registered as a
  // tuple-returning callable and `(A a, B b) = f(x)` resolves through it.
  collectFuncTupleTypes(
    source,
    transformations,
    diagnostics,
    carriers,
    usedNames,
    naming,
    tupleReturningMethods,
    variables,
  );

  collectTupleDestructuring(
    source,
    transformations,
    diagnostics,
    carriers,
    usedNames,
    naming,
    tupleReturningMethods,
  );

  if (carriers.size === 0) {
    return {
      output: source,
      diagnostics,
      tupleCount: 0,
      supportClasses: [],
      inlineDeclarations: [],
      map: identityMap(source.length),
    };
  }

  const { output, map } = applyTransformations(source, transformations);
  const carrierList = [...carriers.values()];

  return {
    output,
    diagnostics,
    tupleCount: carriers.size,
    supportClasses: naming === "flat"
      ? []
      : [renderTupleSupportRegistry(carrierList)],
    inlineDeclarations: naming === "flat"
      ? carrierList.map(carrier => renderTupleMember(carrier, "", naming))
      : [],
    map,
  };
}

/**
 * A tuple used as a `Func` type argument, in either position.
 *
 * The structural-type systems used to compose one way only: a tuple could hold a
 * `Func`, but a `Func` could not carry a tuple, because nothing resolved the tuple
 * to its generated carrier inside a type argument. Lowering then emitted an
 * interface whose `invoke` returned `(Integer, Integer)`, which is not an Apex
 * type. Rewriting the argument to the carrier here means the Func machinery that
 * runs later needs no knowledge of tuples at all.
 */
function collectFuncTupleTypes(
  source: string,
  transformations: Transformation[],
  diagnostics: ApexXDiagnostic[],
  carriers: Map<string, TupleCarrier>,
  usedNames: Set<string>,
  naming: SharedTypeNaming,
  tupleReturningMethods: TupleReturningMethod[],
  variables: Map<string, string>,
): void {
  const masked = maskCommentsAndStrings(source);

  for (const match of masked.matchAll(/\bFunc\s*</g)) {
    const openAngle = (match.index ?? 0) + match[0].length - 1;
    const closeAngle = findMatchingDelimiter(masked, openAngle, "<", ">");

    if (closeAngle === undefined) {
      continue;
    }

    const argumentRanges = splitCommaRanges(masked, openAngle + 1, closeAngle);
    let returnTypes: string[] | undefined;
    let returnCarrier: TupleCarrier | undefined;

    for (const [index, range] of argumentRanges.entries()) {
      const text = source.slice(range.start, range.end);
      const trimmed = text.trim();

      if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
        continue;
      }

      const tupleStart = range.start + text.indexOf("(");
      const tupleEnd = tupleStart + trimmed.length;
      const types = parseTupleReturnTypes(trimmed.slice(1, -1));

      if (types.length < 2 || types.some(type => !isSupportedTupleType(type))) {
        diagnostics.push(tupleDiagnostic(
          source,
          tupleStart,
          tupleEnd,
          "APXX2411",
          "A tuple in a Func type argument must contain at least two valid Apex types.",
        ));
        continue;
      }

      const carrier = getOrCreateCarrier(types, carriers, usedNames, naming);
      transformations.push({
        start: tupleStart,
        end: tupleEnd,
        replacement: carrier.name,
      });

      if (index === argumentRanges.length - 1) {
        returnTypes = types;
        returnCarrier = carrier;
      }
    }

    if (returnCarrier === undefined || returnTypes === undefined) {
      continue;
    }

    // `Func<..., (A, B)> name = ...` -- the variable becomes a tuple-returning
    // callable, and its lambda body has to build the carrier rather than a tuple.
    const declaration = /^\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*/.exec(
      masked.slice(closeAngle + 1),
    );

    if (!declaration) {
      continue;
    }

    tupleReturningMethods.push({
      name: declaration[1],
      types: returnTypes,
    });

    const arrowSearchFrom = closeAngle + 1 + declaration[0].length;
    const arrow = masked.indexOf("=>", arrowSearchFrom);
    const statementEnd = findStatementSemicolon(source, arrowSearchFrom);

    if (arrow === -1 || statementEnd === undefined || arrow > statementEnd) {
      continue;
    }

    const bodyStart = skipWhitespace(source, arrow + 2);

    if (source[bodyStart] === "{") {
      // A block body: `return (a, b);` is the shape collectTupleReturns handles.
      const bodyEnd = findMatchingDelimiter(source, bodyStart, "{", "}");

      if (bodyEnd !== undefined) {
        collectTupleReturns(
          source,
          { bodyStart, bodyEnd, carrier: returnCarrier },
          transformations,
          diagnostics,
          variables,
        );
      }
      continue;
    }

    if (source[bodyStart] !== "(") {
      continue;
    }

    // An expression body. A single parenthesised expression is not a tuple, so the
    // element count is what separates `(a, b)` from `(a * b)`.
    const bodyEnd = findMatchingDelimiter(source, bodyStart, "(", ")");

    if (bodyEnd === undefined) {
      continue;
    }

    const elements = splitCommaRanges(masked, bodyStart + 1, bodyEnd);

    if (elements.length !== returnTypes.length) {
      if (elements.length > 1) {
        diagnostics.push(tupleDiagnostic(
          source,
          bodyStart,
          bodyEnd + 1,
          "APXX2412",
          `This lambda returns ${elements.length} value(s), but its Func declares a tuple of ${returnTypes.length}.`,
        ));
      }
      continue;
    }

    const values = elements
      .map(element => source.slice(element.start, element.end).trim())
      .join(", ");
    transformations.push({
      start: bodyStart,
      end: bodyEnd + 1,
      replacement: `new ${returnCarrier.name}(${values})`,
    });
  }
}

function collectMapTupleTypes(
  source: string,
  transformations: Transformation[],
  diagnostics: ApexXDiagnostic[],
  carriers: Map<string, TupleCarrier>,
  usedNames: Set<string>,
  naming: SharedTypeNaming,
): MapTupleVariable[] {
  const variables: MapTupleVariable[] = [];
  const masked = maskCommentsAndStrings(source);
  const pattern = /\bMap\s*<\s*([^,<>()]+?)\s*,\s*(\(([^()\r\n]+)\))\s*>/g;

  for (const match of masked.matchAll(pattern)) {
    const tupleText = match[2];
    const tupleStart = (match.index ?? 0) + match[0].indexOf(tupleText);
    const types = parseTupleReturnTypes(source.slice(
      tupleStart + 1,
      tupleStart + tupleText.length - 1,
    ));

    if (types.length < 2 || types.some(type => !isSupportedTupleType(type))) {
      diagnostics.push(tupleDiagnostic(
        source,
        tupleStart,
        tupleStart + tupleText.length,
        "APXX2410",
        "A Map tuple value must contain at least two valid Apex types.",
      ));
      continue;
    }

    const carrier = getOrCreateCarrier(types, carriers, usedNames, naming);
    if (!transformations.some(item =>
      item.start === tupleStart && item.end === tupleStart + tupleText.length
    )) {
      transformations.push({
        start: tupleStart,
        end: tupleStart + tupleText.length,
        replacement: carrier.name,
      });
    }

    const suffix = masked.slice((match.index ?? 0) + match[0].length);
    const variableMatch = /^\s+([A-Za-z][A-Za-z0-9_]*)\s*(?:=|;)/.exec(suffix);
    if (variableMatch) {
      variables.push({ name: variableMatch[1], carrier });
    }
  }

  return variables;
}

function collectMapTupleValues(
  source: string,
  variables: MapTupleVariable[],
  transformations: Transformation[],
  diagnostics: ApexXDiagnostic[],
  declaredVariables: Map<string, string>,
): void {
  const masked = maskCommentsAndStrings(source);
  const uniqueVariables = new Map(variables.map(variable => [variable.name, variable]));

  for (const variable of uniqueVariables.values()) {
    const pattern = new RegExp(`\\b${variable.name}\\s*\\.\\s*put\\s*\\(`, "g");
    for (const match of masked.matchAll(pattern)) {
      const openParen = (match.index ?? 0) + match[0].lastIndexOf("(");
      const closeParen = findMatchingDelimiter(source, openParen, "(", ")");
      if (closeParen === undefined) {
        continue;
      }

      const arguments_ = splitCommaRanges(source, openParen + 1, closeParen);
      if (arguments_.length !== 2) {
        continue;
      }

      const value = source.slice(arguments_[1].start, arguments_[1].end).trim();
      if (!value.startsWith("(") || !value.endsWith(")")) {
        continue;
      }

      const values = splitCommaList(value.slice(1, -1));
      if (values.length !== variable.carrier.types.length) {
        diagnostics.push(tupleDiagnostic(
          source,
          arguments_[1].start,
          arguments_[1].end,
          "APXX2411",
        `Map tuple value expects ${variable.carrier.types.length} values, but received ${values.length}.`,
        ));
        continue;
      }

      const valueOpen = source.indexOf("(", arguments_[1].start);
      checkTupleElementTypes(
        source,
        variable.carrier.types,
        splitCommaRanges(
          source,
          valueOpen + 1,
          arguments_[1].start + source
            .slice(arguments_[1].start, arguments_[1].end)
            .lastIndexOf(")"),
        ),
        declaredVariables,
        diagnostics,
      );

      const leadingWhitespace = source
        .slice(arguments_[1].start, arguments_[1].end)
        .match(/^\s*/)?.[0] ?? "";
      transformations.push({
        start: arguments_[1].start,
        end: arguments_[1].end,
        replacement: `${leadingWhitespace}new ${variable.carrier.name}(${values.join(", ")})`,
      });
    }
  }
}

/**
 * Checks the values of a tuple literal against the types the tuple contract declares.
 *
 * A mismatch would otherwise reach the platform compiler as a complaint about the
 * generated carrier class, which names none of the types the author wrote. Values whose
 * type cannot be inferred are skipped rather than guessed at.
 */
function checkTupleElementTypes(
  source: string,
  expectedTypes: string[],
  valueRanges: Array<{ start: number; end: number }>,
  variables: Map<string, string>,
  diagnostics: ApexXDiagnostic[],
): void {
  valueRanges.forEach((range, index) => {
    const expected = expectedTypes[index];

    if (!expected) {
      return;
    }

    const value = source.slice(range.start, range.end).trim();
    const actual = inferExpressionType(value, { variables });

    if (!actual || isCompatibleApexType(expected, actual)) {
      return;
    }

    diagnostics.push(tupleDiagnostic(
      source,
      range.start,
      range.end,
      "APXX2412",
        `Tuple element ${index + 1} expects ${toApexType(expected)}, but received ${actual}.`,
    ));
  });
}

function collectTupleReturns(
  source: string,
  method: TupleMethod,
  transformations: Transformation[],
  diagnostics: ApexXDiagnostic[],
  variables: Map<string, string>,
): void {
  const body = source.slice(method.bodyStart + 1, method.bodyEnd);
  const maskedBody = maskCommentsAndStrings(body);
  const returnPattern = /\breturn\s*\(/g;

  for (const match of maskedBody.matchAll(returnPattern)) {
    const returnStart = method.bodyStart + 1 + (match.index ?? 0);
    const openParen = returnStart + match[0].lastIndexOf("(");
    const closeParen = findMatchingDelimiter(source, openParen, "(", ")");

    if (closeParen === undefined || skipWhitespace(source, closeParen + 1) >= source.length) {
      continue;
    }

    const semicolon = skipWhitespace(source, closeParen + 1);
    if (source[semicolon] !== ";") {
      continue;
    }

    const values = splitCommaList(source.slice(openParen + 1, closeParen));
    if (values.length !== method.carrier.types.length) {
      diagnostics.push(tupleDiagnostic(
        source,
        returnStart,
        semicolon + 1,
        "APXX2406",
        `Tuple return expects ${method.carrier.types.length} values, but received ${values.length}.`,
      ));
      continue;
    }

    checkTupleElementTypes(
      source,
      method.carrier.types,
      splitCommaRanges(source, openParen + 1, closeParen),
      variables,
      diagnostics,
    );

    transformations.push({
      start: returnStart,
      end: semicolon + 1,
      replacement: `return new ${method.carrier.name}(${values.join(", ")});`,
    });
  }
}

function collectTupleDestructuring(
  source: string,
  transformations: Transformation[],
  diagnostics: ApexXDiagnostic[],
  carriers: Map<string, TupleCarrier>,
  usedNames: Set<string>,
  naming: SharedTypeNaming,
  tupleReturningMethods: TupleReturningMethod[],
): void {
  const masked = maskCommentsAndStrings(source);
  const pattern = /^([ \t]*)\(([^()]+?)\)\s*=(?!>)\s*/gm;

  for (const match of masked.matchAll(pattern)) {
    const start = match.index ?? 0;
    const declarations = splitCommaList(source.slice(
      start + match[0].indexOf("(") + 1,
      start + match[0].lastIndexOf(")"),
    )).map(parseTupleElementDeclaration);

    if (
      declarations.length < 2 ||
      declarations.some(declaration => declaration === undefined)
    ) {
      diagnostics.push(tupleDiagnostic(
        source,
        start,
        start + match[0].length,
        "APXX2407",
        "Tuple destructuring requires at least two typed variable declarations.",
      ));
      continue;
    }

    const elements = declarations as TupleElementDeclaration[];
    const normalizedNames = elements
      .filter(element => element.name !== "_")
      .map(element => element.name.toLowerCase());
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      diagnostics.push(tupleDiagnostic(
        source,
        start,
        start + match[0].length,
        "APXX2408",
        "Tuple destructuring variable names must be unique.",
      ));
      continue;
    }

    const expressionStart = start + match[0].length;
    const semicolon = findStatementSemicolon(source, expressionStart);
    if (semicolon === undefined) {
      diagnostics.push(tupleDiagnostic(
        source,
        start,
        start + match[0].length,
        "APXX2409",
        "Tuple destructuring must end with a semicolon.",
      ));
      continue;
    }

    const types = elements.map(element => element.type);
    const expression = source.slice(expressionStart, semicolon).trim();
    const returned = resolveTupleReturningCall(expression, tupleReturningMethods);

    // The bindings define the carrier the lowering assigns into, so a shape that does
    // not match the callee's tuple produces two unrelated generated classes and an
    // Apex error naming neither of the types written here.
    if (returned && returned.types.length !== types.length) {
      diagnostics.push(tupleDiagnostic(
        source,
        start + match[0].indexOf("("),
        start + match[0].lastIndexOf(")") + 1,
        "APXX2413",
        `${returned.name}(...) returns ${returned.types.length} values, but this destructuring declares ${types.length}.`,
      ));
      continue;
    }

    if (returned) {
      const declarationRanges = splitCommaRanges(
        source,
        start + match[0].indexOf("(") + 1,
        start + match[0].lastIndexOf(")"),
      );

      let mismatched = false;
      declarationRanges.forEach((range, index) => {
        const expected = returned.types[index];
        const actual = types[index];

        if (!expected || !actual || isCompatibleApexType(actual, expected)) {
          return;
        }

        mismatched = true;
        diagnostics.push(tupleDiagnostic(
          source,
          range.start,
          range.end,
          "APXX2414",
        `${returned.name}(...) returns ${toApexType(expected)} here, which does not fit ${toApexType(actual)}.`,
        ));
      });

      if (mismatched) {
        continue;
      }
    }

    const carrier = getOrCreateCarrier(types, carriers, usedNames, naming);
    const temporaryName = findAvailableName("apexxTuple", usedNames);
    const replacement = [
      `${match[1]}${carrier.name} ${temporaryName} = ${expression};`,
      ...elements.flatMap((element, index) =>
        element.name === "_"
          ? []
          : [`${match[1]}${element.type} ${element.name} = ${temporaryName}.item${index};`],
      ),
    ].join("\n");

    transformations.push({
      start,
      end: semicolon + 1,
      replacement,
    });
  }
}

/**
 * Resolves the right-hand side of a destructuring to a tuple-returning method in this
 * file, by bare name or through a type qualifier. Ambiguous or unresolvable
 * expressions return undefined, which leaves the destructuring unchecked: a
 * cross-file call cannot be verified from here.
 */
function resolveTupleReturningCall(
  expression: string,
  tupleReturningMethods: TupleReturningMethod[],
): TupleReturningMethod | undefined {
  const call = /^(?:[A-Za-z][A-Za-z0-9_.]*\s*\.\s*)?([A-Za-z][A-Za-z0-9_]*)\s*\(/.exec(
    expression,
  );

  if (!call) {
    return undefined;
  }

  const matches = tupleReturningMethods.filter(
    method => method.name.toLowerCase() === call[1].toLowerCase(),
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function parseTupleReturnTypes(source: string): string[] {
  return splitCommaList(source).map(part => {
    const possibleNamedElement = /^(.*\S)\s+([A-Za-z][A-Za-z0-9_]*)$/.exec(part);
    return toApexType(possibleNamedElement?.[1] ?? part);
  });
}

function parseTupleElementDeclaration(source: string): TupleElementDeclaration | undefined {
  const match = /^(.*\S)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(source.trim());
  if (!match || (match[2] !== "_" && !isApexIdentifier(match[2]))) {
    return undefined;
  }

  const type = toApexType(match[1]);
  return isSupportedTupleType(type) ? { type, name: match[2] } : undefined;
}

function getOrCreateCarrier(
  types: string[],
  carriers: Map<string, TupleCarrier>,
  usedNames: Set<string>,
  naming: SharedTypeNaming,
): TupleCarrier {
  const normalizedTypes = types.map(normalizeSharedType);
  const signature = normalizedTypes.join("|").toLowerCase();
  const existing = carriers.get(signature);
  if (existing) {
    return existing;
  }

  const carrier = {
    name: sharedTupleTypeName(normalizedTypes, naming),
    types: normalizedTypes,
  };
  carriers.set(signature, carrier);
  return carrier;
}

function renderTupleSupportRegistry(
  carriers: TupleCarrier[],
): GeneratedApexSupportClass {
  return renderStructuralRegistry(
    TUPLE_REGISTRY_CLASS,
    carriers.map(carrier => ({
      name: sharedTypeMemberName(carrier.name),
      source: renderTupleMember(carrier, "    ", "registry"),
    })),
  );
}

/** `indent` is the declaration's own indent: a registry member is nested, an
 * inline declaration in an anonymous block sits at the top level. */
function renderTupleMember(
  carrier: TupleCarrier,
  indent: string,
  naming: SharedTypeNaming,
): string {
  const memberName = sharedTypeMemberName(carrier.name);
  const inner = `${indent}    `;
  const body = `${indent}        `;
  const fields = carrier.types.map(
    (type, index) => `${inner}public ${toSharedApexType(type, naming)} item${index};`,
  );
  const parameters = carrier.types.map(
    (type, index) => `${toSharedApexType(type, naming)} item${index}`,
  ).join(", ");
  const assignments = carrier.types.map(
    (_type, index) => `${body}this.item${index} = item${index};`,
  );

  return [
    `${indent}public class ${memberName} {`,
    ...fields,
    "",
    `${inner}public ${memberName}(${parameters}) {`,
    ...assignments,
    `${inner}}`,
    `${indent}}`,
  ].join("\n");
}

function applyTransformations(
  source: string,
  transformations: Transformation[],
): { output: string; map: PositionMap } {
  return applySplices(source, transformations);
}

function splitCommaList(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (inString) {
      if (current === "\\" && next) {
        cursor += 1;
      } else if (current === "'") {
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
    } else if (current === "[") {
      bracketDepth += 1;
    } else if (current === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (
      current === "," &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      parts.push(source.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }

  parts.push(source.slice(start).trim());
  return parts.filter(part => part.length > 0);
}

function splitCommaRanges(
  source: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let itemStart = start;
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;

  for (let cursor = start; cursor < end; cursor += 1) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (inString) {
      if (current === "\\" && next) {
        cursor += 1;
      } else if (current === "'") {
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
    } else if (current === "[") {
      bracketDepth += 1;
    } else if (current === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (
      current === "," &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      ranges.push({ start: itemStart, end: cursor });
      itemStart = cursor + 1;
    }
  }

  ranges.push({ start: itemStart, end });
  return ranges;
}

function findMatchingDelimiter(
  source: string,
  openOffset: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 0;
  let state: "code" | "lineComment" | "blockComment" | "string" = "code";

  for (let cursor = openOffset; cursor < source.length; cursor += 1) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (state === "code" && current === "/" && next === "/") {
      state = "lineComment";
      cursor += 1;
      continue;
    }
    if (state === "code" && current === "/" && next === "*") {
      state = "blockComment";
      cursor += 1;
      continue;
    }
    if (state === "code" && current === "'") {
      state = "string";
      continue;
    }
    if (state === "lineComment") {
      if (current === "\n") {
        state = "code";
      }
      continue;
    }
    if (state === "blockComment") {
      if (current === "*" && next === "/") {
        state = "code";
        cursor += 1;
      }
      continue;
    }
    if (state === "string") {
      if (current === "\\" && next) {
        cursor += 1;
      } else if (current === "'") {
        state = "code";
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
  }

  return undefined;
}

function findStatementSemicolon(source: string, start: number): number | undefined {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;

  for (let cursor = start; cursor < source.length; cursor += 1) {
    const current = source[cursor];
    const next = source[cursor + 1];

    if (inString) {
      if (current === "\\" && next) {
        cursor += 1;
      } else if (current === "'") {
        inString = false;
      }
      continue;
    }

    if (current === "'") {
      inString = true;
    } else if (current === "(") {
      parenDepth += 1;
    } else if (current === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (current === "{") {
      braceDepth += 1;
    } else if (current === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (current === "[") {
      bracketDepth += 1;
    } else if (current === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (
      current === ";" &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      return cursor;
    }
  }

  return undefined;
}

function maskCommentsAndStrings(source: string): string {
  const chars = source.split("");
  let state: "code" | "lineComment" | "blockComment" | "string" = "code";

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];

    if (state === "code" && current === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      state = "lineComment";
      index += 1;
    } else if (state === "code" && current === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      state = "blockComment";
      index += 1;
    } else if (state === "code" && current === "'") {
      chars[index] = " ";
      state = "string";
    } else if (state === "lineComment") {
      if (current === "\n") {
        state = "code";
      } else {
        chars[index] = " ";
      }
    } else if (state === "blockComment") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "code";
        index += 1;
      } else if (current !== "\n" && current !== "\r") {
        chars[index] = " ";
      }
    } else if (state === "string") {
      if (current === "\\" && next) {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
      } else if (current === "'") {
        chars[index] = " ";
        state = "code";
      } else if (current !== "\n" && current !== "\r") {
        chars[index] = " ";
      }
    }
  }

  return chars.join("");
}

function hasAuraEnabledAnnotation(source: string, methodStart: number): boolean {
  const prefix = source.slice(0, methodStart);
  const lines = prefix.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    if (!line.startsWith("@")) {
      return false;
    }
    if (/^@AuraEnabled\b/i.test(line)) {
      return true;
    }
  }

  return false;
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function isSupportedTupleType(type: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.]*(?:<.+>)?$/.test(type);
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

function tupleDiagnostic(
  source: string,
  start: number,
  end: number,
  code: string,
  message: string,
): ApexXDiagnostic {
  return {
    severity: "error",
    source: "apexx-semantics",
    code,
    message,
    range: createRange(source, start, end),
  };
}
