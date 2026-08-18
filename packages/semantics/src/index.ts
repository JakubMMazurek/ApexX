import type { ListTypeInfo, SourcePosition, SourceRange } from "@apexx/ast";

const identifierPattern = /\b[A-Za-z][A-Za-z0-9_]*\b/g;
const listDeclarationPattern =
  /\bList\s*<\s*([A-Za-z][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z][A-Za-z0-9_]*)?)\s*>\s+([A-Za-z][A-Za-z0-9_]*)\b/g;
const listReturningMethodPattern =
  /\b(?:public|private|protected|global|static|final|virtual|abstract|override|webservice|testmethod|\s)*List\s*<\s*([A-Za-z][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z][A-Za-z0-9_]*)?)\s*>\s+[A-Za-z][A-Za-z0-9_]*\s*\([^;{}]*\)\s*\{/g;

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

export function extractListElementType(typeName: string): string | undefined {
  const match =
    /^\s*List\s*<\s*([A-Za-z][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z][A-Za-z0-9_]*)?)\s*>/i.exec(
      typeName,
    );

  return match ? normalizeType(match[1]) : undefined;
}

export function findEnclosingListReturnElementType(
  source: string,
  offset: number,
): string | undefined {
  const masked = maskCommentsAndStrings(source);
  let match: RegExpExecArray | null;
  let elementType: string | undefined;

  while ((match = listReturningMethodPattern.exec(masked)) !== null) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;

    if (openBrace >= offset) {
      continue;
    }

    const closeBrace = findMatchingBrace(masked, openBrace);
    if (closeBrace === undefined || offset < closeBrace) {
      elementType = normalizeType(match[1]);
    }
  }

  return elementType;
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
