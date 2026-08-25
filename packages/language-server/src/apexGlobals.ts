import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
} from "vscode-languageserver/node.js";

/**
 * The Apex surface an editor is expected to know about without being told: the
 * global types and namespaces, the members of the primitives and collections, and
 * the keywords.
 *
 * The Salesforce Apex extension gets this from a shipped symbol table plus the
 * org index in `apex.db`. ApexX cannot read that database -- two writers corrupt
 * it -- so the everyday part of it is described here instead, and everything
 * org-specific still comes from the SObject schema under `.apexx/schema`.
 */

export interface ApexGlobalType {
  name: string;
  detail: string;
  /** A namespace is only ever a receiver, so it is never offered as a variable type. */
  namespace?: boolean;
}

function type(name: string, detail: string): ApexGlobalType {
  return { name, detail };
}

function namespace(name: string, detail: string): ApexGlobalType {
  return { name, detail, namespace: true };
}

/**
 * Ordered by how often each is written, because equal-prefix matches keep the
 * order they arrive in.
 */
export const apexGlobalTypes: ApexGlobalType[] = [
  namespace("System", "Apex System namespace: debug, assert, now, today, runAs"),
  type("String", "Apex primitive String"),
  type("Integer", "Apex primitive Integer (32-bit)"),
  type("Boolean", "Apex primitive Boolean"),
  type("Decimal", "Apex primitive Decimal"),
  type("Long", "Apex primitive Long (64-bit)"),
  type("Double", "Apex primitive Double"),
  type("Date", "Apex primitive Date"),
  type("Datetime", "Apex primitive Datetime"),
  type("Time", "Apex primitive Time"),
  type("Id", "Apex primitive Id"),
  type("Blob", "Apex primitive Blob"),
  type("Object", "Apex Object, the root of every type"),
  type("List", "Apex List<T>, an ordered collection"),
  type("Set", "Apex Set<T>, an unordered collection of unique values"),
  type("Map", "Apex Map<K, V>, a collection of key/value pairs"),
  type("SObject", "Apex SObject, the base type of every record"),
  type("Func", "ApexX Func<..., R>, a strongly typed function value"),
  namespace("Database", "Apex Database namespace: partial-success DML and query locators"),
  namespace("Math", "Apex Math namespace: abs, ceil, floor, max, min, random, round"),
  namespace("JSON", "Apex JSON namespace: serialize and deserialize"),
  namespace("Test", "Apex Test namespace: startTest, stopTest, setMock, loadData"),
  namespace("Limits", "Apex Limits namespace: governor limit counters"),
  namespace("UserInfo", "Apex UserInfo namespace: the running user"),
  namespace("Schema", "Apex Schema namespace: describe results and SObject metadata"),
  namespace("Trigger", "Apex trigger context: new, old, newMap, oldMap, isInsert"),
  namespace("ApexPages", "Apex ApexPages namespace: page messages and references"),
  namespace("Messaging", "Apex Messaging namespace: sending email"),
  namespace("EncodingUtil", "Apex EncodingUtil namespace: base64 and URL encoding"),
  namespace("Crypto", "Apex Crypto namespace: digests, HMACs and signatures"),
  namespace("Approval", "Apex Approval namespace: submitting and processing approvals"),
  namespace("EventBus", "Apex EventBus namespace: publishing platform events"),
  namespace("Cache", "Apex Cache namespace: org and session platform cache"),
  namespace("Auth", "Apex Auth namespace: session and authentication management"),
  namespace("Search", "Apex Search namespace: SOSL results"),
  namespace("Site", "Apex Site namespace: the current Experience Cloud site"),
  namespace("Network", "Apex Network namespace: Experience Cloud membership"),
  namespace("Flow", "Apex Flow namespace: Flow.Interview"),
  namespace("Reports", "Apex Reports namespace: running reports"),
  namespace("Metadata", "Apex Metadata namespace: metadata deployments"),
  type("Type", "Apex System.Type, a runtime type token"),
  type("Http", "Apex Http, sends an HttpRequest"),
  type("HttpRequest", "Apex HttpRequest"),
  type("HttpResponse", "Apex HttpResponse"),
  type("Pattern", "Apex Pattern, a compiled regular expression"),
  type("Matcher", "Apex Matcher, a Pattern applied to an input"),
  type("Exception", "Apex Exception, the base of every exception"),
  type("DmlException", "Apex DmlException, thrown by a failed DML statement"),
  type("QueryException", "Apex QueryException, thrown by a failed SOQL query"),
  type("CalloutException", "Apex CalloutException, thrown by a failed callout"),
  type("IllegalArgumentException", "Apex IllegalArgumentException"),
  type("NullPointerException", "Apex NullPointerException"),
  type("StringException", "Apex StringException"),
  type("SObjectField", "Apex Schema.SObjectField, a field token"),
  type("SObjectType", "Apex Schema.SObjectType, an SObject token"),
  type("Savepoint", "Apex Savepoint, returned by Database.setSavepoint()"),
  type("Iterator", "Apex Iterator<T>"),
  type("Iterable", "Apex Iterable<T>"),
  type("Comparable", "Apex Comparable, sorts a custom type in List.sort()"),
  type("Comparator", "Apex Comparator<T>"),
  type("Queueable", "Apex Queueable, runs asynchronously via System.enqueueJob()"),
  type("Batchable", "Apex Database.Batchable<T>"),
  type("Schedulable", "Apex Schedulable, runs on a schedule"),
  type("StaticResourceCalloutMock", "Apex StaticResourceCalloutMock"),
];

/** Statement and declaration keywords, so an identifier list reads like Apex's. */
const keywords = [
  "abstract",
  "break",
  "catch",
  "class",
  "continue",
  "delete",
  "do",
  "else",
  "enum",
  "extends",
  "final",
  "finally",
  "for",
  "get",
  "global",
  "if",
  "implements",
  "insert",
  "instanceof",
  "interface",
  "merge",
  "new",
  "null",
  "override",
  "private",
  "protected",
  "public",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "testmethod",
  "this",
  "throw",
  "transient",
  "try",
  "undelete",
  "update",
  "upsert",
  "virtual",
  "void",
  "webservice",
  "when",
  "while",
  "with sharing",
  "without sharing",
  "inherited sharing",
];

export function apexKeywordCompletions(): CompletionItem[] {
  return keywords.map(keyword => ({
    label: keyword,
    kind: CompletionItemKind.Keyword,
    detail: "Apex keyword",
  }));
}

function method(
  label: string,
  detail: string,
  insertText?: string,
): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Method,
    detail,
    insertText: insertText ?? `${label}()`,
    insertTextFormat: InsertTextFormat.Snippet,
  };
}

const integerMembers = (): CompletionItem[] => [
  method("format", "String format()"),
  method("intValue", "Integer intValue()"),
  method("longValue", "Long longValue()"),
  method("doubleValue", "Double doubleValue()"),
];

/** Long carries Integer's conversions and Decimal's arithmetic. */
const longMembers = (): CompletionItem[] => {
  const members = new Map<string, CompletionItem>();

  for (const member of [...integerMembers(), ...decimalMembers()]) {
    if (!members.has(member.label)) {
      members.set(member.label, member);
    }
  }

  return [...members.values()];
};

const decimalMembers = (): CompletionItem[] => [
  method("abs", "Decimal abs()"),
  method("divide", "Decimal divide(Decimal divisor, Integer scale)", "divide(${1:divisor}, ${2:scale})"),
  method("doubleValue", "Double doubleValue()"),
  method("format", "String format()"),
  method("intValue", "Integer intValue()"),
  method("longValue", "Long longValue()"),
  method("pow", "Double pow(Integer exponent)", "pow(${1:exponent})"),
  method("round", "Long round()"),
  method("scale", "Integer scale()"),
  method("setScale", "Decimal setScale(Integer scale)", "setScale(${1:scale})"),
  method("stripTrailingZeros", "Decimal stripTrailingZeros()"),
  method("toPlainString", "String toPlainString()"),
];

const booleanMembers = (): CompletionItem[] => [
  method("equals", "Boolean equals(Object other)", "equals(${1:other})"),
  method("hashCode", "Integer hashCode()"),
];

const idMembers = (): CompletionItem[] => [
  method("getSObjectType", "Schema.SObjectType getSObjectType()"),
  method("to15", "Id to15()"),
  method("addError", "void addError(String message)", "addError(${1:message})"),
];

const blobMembers = (): CompletionItem[] => [
  method("size", "Integer size()"),
  method("toString", "String toString()"),
];

const timeMembers = (): CompletionItem[] => [
  method("addHours", "Time addHours(Integer additionalHours)", "addHours(${1:hours})"),
  method("addMinutes", "Time addMinutes(Integer additionalMinutes)", "addMinutes(${1:minutes})"),
  method("addSeconds", "Time addSeconds(Integer additionalSeconds)", "addSeconds(${1:seconds})"),
  method("hour", "Integer hour()"),
  method("minute", "Integer minute()"),
  method("second", "Integer second()"),
  method("millisecond", "Integer millisecond()"),
];

const setMembers = (): CompletionItem[] => [
  method("add", "Boolean add(T element)", "add(${1:element})"),
  method("addAll", "Boolean addAll(List<T> fromList)", "addAll(${1:fromList})"),
  method("clear", "void clear()"),
  method("clone", "Set<T> clone()"),
  method("contains", "Boolean contains(T element)", "contains(${1:element})"),
  method("containsAll", "Boolean containsAll(List<T> listToCompare)", "containsAll(${1:listToCompare})"),
  method("isEmpty", "Boolean isEmpty()"),
  method("remove", "Boolean remove(T element)", "remove(${1:element})"),
  method("removeAll", "Boolean removeAll(List<T> listOfElementsToRemove)", "removeAll(${1:elements})"),
  method("retainAll", "Boolean retainAll(List<T> listOfElementsToRetain)", "retainAll(${1:elements})"),
  method("size", "Integer size()"),
];

const mapMembers = (): CompletionItem[] => [
  method("get", "V get(K key)", "get(${1:key})"),
  method("put", "V put(K key, V value)", "put(${1:key}, ${2:value})"),
  method("putAll", "void putAll(Map<K, V> fromMap)", "putAll(${1:fromMap})"),
  method("containsKey", "Boolean containsKey(K key)", "containsKey(${1:key})"),
  method("keySet", "Set<K> keySet()"),
  method("values", "List<V> values()"),
  method("remove", "V remove(K key)", "remove(${1:key})"),
  method("clear", "void clear()"),
  method("clone", "Map<K, V> clone()"),
  method("isEmpty", "Boolean isEmpty()"),
  method("size", "Integer size()"),
];

const exceptionMembers = (): CompletionItem[] => [
  method("getMessage", "String getMessage()"),
  method("getTypeName", "String getTypeName()"),
  method("getStackTraceString", "String getStackTraceString()"),
  method("getLineNumber", "Integer getLineNumber()"),
  method("getCause", "Exception getCause()"),
  method("setMessage", "void setMessage(String message)", "setMessage(${1:message})"),
  method("initCause", "void initCause(Exception cause)", "initCause(${1:cause})"),
  method("getDmlMessage", "String getDmlMessage(Integer index)", "getDmlMessage(${1:index})"),
  method("getNumDml", "Integer getNumDml()"),
];

const objectMembers = (): CompletionItem[] => [
  method("equals", "Boolean equals(Object other)", "equals(${1:other})"),
  method("hashCode", "Integer hashCode()"),
  method("toString", "String toString()"),
];

const sObjectBaseMembers = (): CompletionItem[] => [
  method("get", "Object get(String fieldName)", "get(${1:fieldName})"),
  method("put", "Object put(String fieldName, Object value)", "put(${1:fieldName}, ${2:value})"),
  method("getSObjectType", "Schema.SObjectType getSObjectType()"),
  method("addError", "void addError(String message)", "addError(${1:message})"),
  method("clone", "SObject clone()"),
  method("isSet", "Boolean isSet(String fieldName)", "isSet(${1:fieldName})"),
];

const httpRequestMembers = (): CompletionItem[] => [
  method("setEndpoint", "void setEndpoint(String endpoint)", "setEndpoint(${1:endpoint})"),
  method("setMethod", "void setMethod(String verb)", "setMethod(${1:'GET'})"),
  method("setBody", "void setBody(String body)", "setBody(${1:body})"),
  method("setHeader", "void setHeader(String key, String value)", "setHeader(${1:key}, ${2:value})"),
  method("setTimeout", "void setTimeout(Integer timeout)", "setTimeout(${1:timeout})"),
  method("getBody", "String getBody()"),
  method("getEndpoint", "String getEndpoint()"),
];

const httpResponseMembers = (): CompletionItem[] => [
  method("getBody", "String getBody()"),
  method("getStatusCode", "Integer getStatusCode()"),
  method("getStatus", "String getStatus()"),
  method("getHeader", "String getHeader(String key)", "getHeader(${1:key})"),
  method("getHeaderKeys", "List<String> getHeaderKeys()"),
];

/**
 * Instance members of an Apex built-in type, or `undefined` when the type is not
 * one -- which is how the caller knows to keep looking.
 */
export function builtInInstanceMembers(
  normalizedType: string,
): CompletionItem[] | undefined {
  const lowered = normalizedType.trim().toLowerCase();

  if (/^map\s*<.+>$/.test(lowered)) {
    return mapMembers();
  }

  if (/^set\s*<.+>$/.test(lowered)) {
    return setMembers();
  }

  switch (lowered) {
    case "integer":
      return integerMembers();
    case "long":
      return longMembers();
    case "decimal":
    case "double":
      return decimalMembers();
    case "boolean":
      return booleanMembers();
    case "id":
      return idMembers();
    case "blob":
      return blobMembers();
    case "time":
      return timeMembers();
    case "object":
      return objectMembers();
    case "sobject":
      return sObjectBaseMembers();
    case "httprequest":
      return httpRequestMembers();
    case "httpresponse":
      return httpResponseMembers();
    case "http":
      return [method("send", "HttpResponse send(HttpRequest request)", "send(${1:request})")];
    case "exception":
    case "dmlexception":
    case "queryexception":
    case "calloutexception":
    case "illegalargumentexception":
    case "nullpointerexception":
    case "stringexception":
      return exceptionMembers();
    default:
      return undefined;
  }
}

/** Members every SObject carries, on top of the fields the schema describes. */
export function sObjectBuiltInMembers(): CompletionItem[] {
  return sObjectBaseMembers();
}

/** Members of a caught exception, for `catch (Exception e) { e. }`. */
export function exceptionInstanceMembers(): CompletionItem[] {
  return exceptionMembers();
}
