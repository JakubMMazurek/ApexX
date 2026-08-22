import { createHash } from "node:crypto";

export const FUNC_REGISTRY_CLASS = "ApexXFuncs";
export const TUPLE_REGISTRY_CLASS = "ApexXTuples";

export function sharedFuncTypeName(
  parameterTypes: string[],
  returnType: string,
): string {
  return `${FUNC_REGISTRY_CLASS}.${sharedFuncMemberName(parameterTypes, returnType)}`;
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

export function sharedTupleTypeName(types: string[]): string {
  return `${TUPLE_REGISTRY_CLASS}.${sharedTupleMemberName(types)}`;
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

export function toSharedApexType(typeName: string): string {
  const normalized = normalizeSharedType(typeName);
  const funcMatch = /^Func<(.+)>$/i.exec(normalized);

  if (!funcMatch) {
    return normalized;
  }

  const arguments_ = splitCommaList(funcMatch[1]);
  return sharedFuncTypeName(arguments_.slice(0, -1), arguments_.at(-1) ?? "Object");
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
