import {
  applySplices,
  identityMap,
  type PositionMap,
} from "./sourceMap.js";
import type { ApexXDiagnostic, GeneratedApexSupportClass } from "@apexx/ast";
import {
  collectIdentifiers,
  createRange,
  findAvailableName,
  isApexIdentifier,
} from "@apexx/semantics";
import {
  normalizeSharedType,
  sharedTypeMemberName,
  sharedTupleTypeName,
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
  /** Maps offsets in `output` back to the source this stage received. */
  map: PositionMap;
}

export function lowerApexXTuples(source: string): TupleLoweringResult {
  const diagnostics: ApexXDiagnostic[] = [];
  const transformations: Transformation[] = [];
  const carriers = new Map<string, TupleCarrier>();
  const usedNames = collectIdentifiers(source);
  const methods: TupleMethod[] = [];
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
        "APXX2401: A tuple must contain at least two elements.",
      ));
      continue;
    }

    if (parsedTypes.some(type => !isSupportedTupleType(type))) {
      diagnostics.push(tupleDiagnostic(
        source,
        tupleStart,
        tupleStart + tupleText.length,
        "APXX2402: Every tuple element must declare a valid Apex type.",
      ));
      continue;
    }

    if (hasAuraEnabledAnnotation(source, methodMatch.index ?? 0)) {
      diagnostics.push(tupleDiagnostic(
        source,
        tupleStart,
        tupleStart + tupleText.length,
        "APXX2403: Tuple return types cannot currently cross an @AuraEnabled boundary. Destructure the tuple inside Apex and return a Salesforce DTO or Map.",
      ));
      continue;
    }

    if (parsedTypes.length > 7) {
      diagnostics.push({
        severity: "warning",
        source: "apexx-semantics",
        message: `APXX2404: This tuple contains ${parsedTypes.length} elements. Consider a named domain type if the values represent a durable concept.`,
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
        "APXX2405: Unable to locate the body of this tuple-returning method.",
      ));
      continue;
    }

    const carrier = getOrCreateCarrier(parsedTypes, carriers, usedNames);
    methods.push({ bodyStart, bodyEnd, carrier });
    transformations.push({
      start: tupleStart,
      end: tupleStart + tupleText.length,
      replacement: carrier.name,
    });
  }

  for (const method of methods) {
    collectTupleReturns(source, method, transformations, diagnostics);
  }

  const mapTupleVariables = collectMapTupleTypes(
    source,
    transformations,
    diagnostics,
    carriers,
    usedNames,
  );
  collectMapTupleValues(
    source,
    mapTupleVariables,
    transformations,
    diagnostics,
  );

  collectTupleDestructuring(
    source,
    transformations,
    diagnostics,
    carriers,
    usedNames,
  );

  if (carriers.size === 0) {
    return {
      output: source,
      diagnostics,
      tupleCount: 0,
      supportClasses: [],
      map: identityMap(source.length),
    };
  }

  const { output, map } = applyTransformations(source, transformations);

  return {
    output,
    diagnostics,
    tupleCount: carriers.size,
    supportClasses: [renderTupleSupportRegistry([...carriers.values()])],
    map,
  };
}

function collectMapTupleTypes(
  source: string,
  transformations: Transformation[],
  diagnostics: ApexXDiagnostic[],
  carriers: Map<string, TupleCarrier>,
  usedNames: Set<string>,
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
        "APXX2410: A Map tuple value must contain at least two valid Apex types.",
      ));
      continue;
    }

    const carrier = getOrCreateCarrier(types, carriers, usedNames);
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
          `APXX2411: Map tuple value expects ${variable.carrier.types.length} values, but received ${values.length}.`,
        ));
        continue;
      }

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

function collectTupleReturns(
  source: string,
  method: TupleMethod,
  transformations: Transformation[],
  diagnostics: ApexXDiagnostic[],
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
        `APXX2406: Tuple return expects ${method.carrier.types.length} values, but received ${values.length}.`,
      ));
      continue;
    }

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
        "APXX2407: Tuple destructuring requires at least two typed variable declarations.",
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
        "APXX2408: Tuple destructuring variable names must be unique.",
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
        "APXX2409: Tuple destructuring must end with a semicolon.",
      ));
      continue;
    }

    const types = elements.map(element => element.type);
    const carrier = getOrCreateCarrier(types, carriers, usedNames);
    const temporaryName = findAvailableName("apexxTuple", usedNames);
    const expression = source.slice(expressionStart, semicolon).trim();
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
): TupleCarrier {
  const normalizedTypes = types.map(normalizeSharedType);
  const signature = normalizedTypes.join("|").toLowerCase();
  const existing = carriers.get(signature);
  if (existing) {
    return existing;
  }

  const carrier = {
    name: sharedTupleTypeName(normalizedTypes),
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
      source: renderTupleMember(carrier),
    })),
  );
}

function renderTupleMember(carrier: TupleCarrier): string {
  const memberName = sharedTypeMemberName(carrier.name);
  const fields = carrier.types.map(
    (type, index) => `        public ${toSharedApexType(type)} item${index};`,
  );
  const parameters = carrier.types.map(
    (type, index) => `${toSharedApexType(type)} item${index}`,
  ).join(", ");
  const assignments = carrier.types.map(
    (_type, index) => `            this.item${index} = item${index};`,
  );

  return [
    `    public class ${memberName} {`,
    ...fields,
    "",
    `        public ${memberName}(${parameters}) {`,
    ...assignments,
    "        }",
    "    }",
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
  message: string,
): ApexXDiagnostic {
  return {
    severity: "error",
    source: "apexx-semantics",
    message,
    range: createRange(source, start, end),
  };
}
