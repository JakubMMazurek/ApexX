import { createHash } from "node:crypto";

export const FUNC_REGISTRY_CLASS = "ApexXFuncs";
export const TUPLE_REGISTRY_CLASS = "ApexXTuples";

/**
 * How a structural type is named where it is used.
 *
 * `registry` qualifies it with the registry class that a class-mode build deploys.
 * `flat` leaves the member name bare, for an anonymous block that declares the
 * type inline: a block-level class is an inner type, and Apex rejects an inner
 * type that has inner types of its own.
 */
export type SharedTypeNaming = "registry" | "flat";

export function sharedFuncTypeName(
  parameterTypes: string[],
  returnType: string,
  naming: SharedTypeNaming = "registry",
): string {
  const member = sharedFuncMemberName(parameterTypes, returnType);
  return naming === "flat" ? member : `${FUNC_REGISTRY_CLASS}.${member}`;
}

export function sharedFuncMemberName(
  parameterTypes: string[],
  returnType: string,
): string {
  return `ApexXFunc_${signatureHash([
    "func",
    ...parameterTypes.map(normalizeSharedType),
    "returns",
    normalizeSharedType(returnType),
  ])}`;
}

export function sharedTupleTypeName(
  types: string[],
  naming: SharedTypeNaming = "registry",
): string {
  const member = sharedTupleMemberName(types);
  return naming === "flat" ? member : `${TUPLE_REGISTRY_CLASS}.${member}`;
}

export function sharedTupleMemberName(types: string[]): string {
  return `ApexXTuple_${signatureHash([
    "tuple",
    ...types.map(normalizeSharedType),
  ])}`;
}

export function sharedTypeMemberName(qualifiedName: string): string {
  return qualifiedName.split(".").at(-1) ?? qualifiedName;
}

export function toSharedApexType(
  typeName: string,
  naming: SharedTypeNaming = "registry",
): string {
  const normalized = normalizeSharedType(typeName);
  const funcMatch = /^Func<(.+)>$/i.exec(normalized);

  if (!funcMatch) {
    return normalized;
  }

  const arguments_ = splitCommaList(funcMatch[1]);
  return sharedFuncTypeName(
    arguments_.slice(0, -1),
    arguments_.at(-1) ?? "Object",
    naming,
  );
}

export function normalizeSharedType(typeName: string): string {
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

function signatureHash(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("|").toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

function splitCommaList(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "<") {
      angleDepth += 1;
    } else if (source[index] === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (source[index] === "," && angleDepth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(source.slice(start).trim());
  return parts.filter(part => part.length > 0);
}
