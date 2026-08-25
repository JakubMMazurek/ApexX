import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
} from "vscode-languageserver/node.js";

/**
 * Completion inside a SOQL query literal.
 *
 * A query is its own little language: `Name` after `SELECT` is a field, the same word
 * after `FROM` is an object, and `:total` is a reference back into Apex scope. None of
 * that is visible to the expression logic outside the brackets, so the caret's clause
 * is worked out here and answered from the sObject schema.
 */

export interface SoqlContext {
  /** Offset of the `[` that opens the query. */
  queryStart: number;
  /** The object named by `FROM`, when one has been typed. */
  sObject?: string;
  /** Which clause the caret sits in. */
  clause: SoqlClause;
  /** True when the caret follows `:`, so a bound Apex expression is expected. */
  binding: boolean;
  /** The relationship path already typed before the caret, e.g. `Account` in `Account.`. */
  relationship?: string;
}

export type SoqlClause =
  | "select"
  | "from"
  | "where"
  | "orderBy"
  | "groupBy"
  | "having"
  | "limit"
  | "start";

const CLAUSE_KEYWORDS: { pattern: RegExp; clause: SoqlClause }[] = [
  { pattern: /\bselect\b/gi, clause: "select" },
  { pattern: /\bfrom\b/gi, clause: "from" },
  { pattern: /\bwhere\b/gi, clause: "where" },
  { pattern: /\border\s+by\b/gi, clause: "orderBy" },
  { pattern: /\bgroup\s+by\b/gi, clause: "groupBy" },
  { pattern: /\bhaving\b/gi, clause: "having" },
  { pattern: /\b(?:limit|offset)\b/gi, clause: "limit" },
];

/**
 * The query the caret is inside, or `undefined` when it is not inside one.
 *
 * Nesting is counted rather than searched for, so a semi-join subquery reports its own
 * brackets rather than the outer query's.
 */
export function findSoqlContext(
  source: string,
  offset: number,
): SoqlContext | undefined {
  const queryStart = findOpenBracket(source, offset);

  if (queryStart === undefined) {
    return undefined;
  }

  // `[` after a value indexes it: `rows[0]`, `byId[key]`. A query is only ever opened
  // where a value is expected, so what precedes the bracket settles which one it is --
  // and it settles it while the query is still empty, which SELECT alone cannot.
  const preceding = source.slice(0, queryStart).replace(/\s+$/, "").at(-1);
  if (preceding && /[A-Za-z0-9_)\]']/.test(preceding)) {
    return undefined;
  }

  const text = source.slice(queryStart + 1, offset);

  // A query always starts with SELECT, so anything that has begun with something else
  // is left alone.
  if (!/^\s*(?:select\b|s?e?l?e?c?t?\s*$)/i.test(text)) {
    return undefined;
  }

  const beforeCaret = text.slice(text.lastIndexOf("\n") + 1);
  const binding = /:\s*[A-Za-z0-9_.]*$/.test(beforeCaret);
  const relationship = /(?:^|[\s,(])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\.[A-Za-z0-9_]*$/.exec(
    beforeCaret,
  )?.[1];

  return {
    queryStart,
    sObject: findFromObject(source, queryStart),
    clause: clauseAt(text),
    binding,
    relationship,
  };
}

/** Offset of the innermost `[` still open at `offset`, ignoring strings. */
function findOpenBracket(source: string, offset: number): number | undefined {
  let depth = 0;
  let index = offset - 1;

  while (index >= 0) {
    const character = source[index];

    if (character === "'") {
      // Step over the string this quote closes, so brackets inside it do not count.
      index = skipStringBackwards(source, index);
      continue;
    }

    if (character === "]") {
      depth += 1;
    } else if (character === "[") {
      if (depth === 0) {
        return index;
      }

      depth -= 1;
    } else if (character === ";" || character === "}" || character === "{") {
      // A statement boundary: no query can span it.
      return undefined;
    }

    index -= 1;
  }

  return undefined;
}

function skipStringBackwards(source: string, quoteIndex: number): number {
  let index = quoteIndex - 1;

  while (index >= 0) {
    if (source[index] === "'" && source[index - 1] !== "\\") {
      return index - 1;
    }

    index -= 1;
  }

  return -1;
}

/**
 * The object a query selects from, read from the whole query rather than the part
 * before the caret, so editing the field list still knows which object it is editing.
 */
function findFromObject(source: string, queryStart: number): string | undefined {
  const end = findCloseBracket(source, queryStart);
  const query = source.slice(queryStart + 1, end);
  return /\bfrom\s+([A-Za-z][A-Za-z0-9_]*(?:__c)?)/i.exec(query)?.[1];
}

function findCloseBracket(source: string, queryStart: number): number {
  let depth = 0;

  for (let index = queryStart; index < source.length; index += 1) {
    const character = source[index];

    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    } else if (character === ";") {
      return index;
    }
  }

  return source.length;
}

/** The clause the caret is in: whichever clause keyword appears last before it. */
function clauseAt(textBeforeCaret: string): SoqlClause {
  let clause: SoqlClause = "start";
  let lastIndex = -1;

  for (const { pattern, clause: candidate } of CLAUSE_KEYWORDS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(textBeforeCaret)) !== null) {
      if (match.index > lastIndex) {
        lastIndex = match.index;
        clause = candidate;
      }
    }
  }

  return clause;
}

export interface SoqlCompletionSources {
  /** Every sObject the workspace knows about. */
  sObjectNames: () => string[];
  /** Fields of an sObject, or an empty list when it is not known. */
  fieldsOf: (sObject: string) => { label: string; detail: string }[];
  /** Apex values in scope, for a bind variable after `:`. */
  boundValues: () => CompletionItem[];
}

const FUNCTIONS = [
  ["COUNT", "COUNT()"],
  ["COUNT_DISTINCT", "COUNT_DISTINCT(${1:field})"],
  ["SUM", "SUM(${1:field})"],
  ["AVG", "AVG(${1:field})"],
  ["MIN", "MIN(${1:field})"],
  ["MAX", "MAX(${1:field})"],
  ["TOLABEL", "TOLABEL(${1:field})"],
  ["FORMAT", "FORMAT(${1:field})"],
  ["CALENDAR_MONTH", "CALENDAR_MONTH(${1:field})"],
  ["CALENDAR_YEAR", "CALENDAR_YEAR(${1:field})"],
];

const DATE_LITERALS = [
  "TODAY",
  "YESTERDAY",
  "TOMORROW",
  "THIS_WEEK",
  "LAST_WEEK",
  "NEXT_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
  "NEXT_MONTH",
  "THIS_QUARTER",
  "LAST_QUARTER",
  "THIS_YEAR",
  "LAST_YEAR",
  "LAST_N_DAYS:n",
  "NEXT_N_DAYS:n",
];

/** What can be written at the caret inside a query. */
export function soqlCompletions(
  context: SoqlContext,
  sources: SoqlCompletionSources,
): CompletionItem[] {
  // `:value` binds an Apex expression, so scope comes back into play.
  if (context.binding) {
    return sources.boundValues();
  }

  if (context.clause === "from") {
    return sources
      .sObjectNames()
      .map(name => item(name, CompletionItemKind.Struct, `Salesforce SObject ${name}`));
  }

  if (context.clause === "limit") {
    return [];
  }

  if (context.clause === "start") {
    return [keyword("SELECT", "SELECT ${1:Id} FROM ${2:Account}")];
  }

  // A dotted path is a relationship, whose fields come from the object it points at.
  const owner = context.relationship
    ? relationshipObject(context.relationship, context.sObject, sources)
    : context.sObject;

  const fields = owner ? sources.fieldsOf(owner) : [];
  const items = fields.map(field =>
    item(field.label, CompletionItemKind.Field, field.detail),
  );

  if (context.relationship) {
    return items;
  }

  switch (context.clause) {
    case "select":
      return [
        ...items,
        ...FUNCTIONS.map(([label, insertText]) => keyword(label, insertText)),
        keyword("FROM", "FROM ${1:Account}"),
        keyword("TYPEOF"),
      ];
    case "where":
    case "having":
      return [
        ...items,
        ...DATE_LITERALS.map(label => keyword(label)),
        keyword("AND"),
        keyword("OR"),
        keyword("NOT"),
        keyword("IN"),
        keyword("LIKE"),
        keyword("INCLUDES"),
        keyword("EXCLUDES"),
        keyword("NULL"),
        keyword("ORDER BY", "ORDER BY ${1:Name}"),
        keyword("LIMIT", "LIMIT ${1:100}"),
        keyword("WITH SECURITY_ENFORCED"),
        keyword("FOR UPDATE"),
      ];
    case "orderBy":
      return [
        ...items,
        keyword("ASC"),
        keyword("DESC"),
        keyword("NULLS FIRST"),
        keyword("NULLS LAST"),
        keyword("LIMIT", "LIMIT ${1:100}"),
      ];
    case "groupBy":
      return [...items, keyword("HAVING"), keyword("ROLLUP"), keyword("CUBE")];
    default:
      return items;
  }
}

/**
 * The object a relationship path points at.
 *
 * `Account.Name` on a Contact resolves through the `Account` lookup; a child path such
 * as `Contacts` on an Account resolves through the field's declared list type. Anything
 * the schema cannot name resolves to nothing rather than to a guess.
 */
function relationshipObject(
  path: string,
  root: string | undefined,
  sources: SoqlCompletionSources,
): string | undefined {
  let current = root;

  for (const step of path.split(".")) {
    if (!current) {
      return undefined;
    }

    const fields = sources.fieldsOf(current);
    const direct = fields.find(
      field => field.label.toLowerCase() === step.toLowerCase(),
    );
    // A lookup is written `AccountId` but traversed as `Account`, so the id field is
    // what a bare relationship name has to be matched against.
    const viaId = fields.find(
      field => field.label.toLowerCase() === `${step.toLowerCase()}id`,
    );
    const detail = (direct ?? viaId)?.detail ?? "";
    const referenced =
      /\((?:Id )?([A-Za-z][A-Za-z0-9_]*(?:__c)?)(?: \|[^)]*)?\)/.exec(detail)?.[1] ??
      /List<([A-Za-z][A-Za-z0-9_]*(?:__c)?)>/.exec(detail)?.[1];

    current = referenced;
  }

  return current;
}

function item(
  label: string,
  kind: CompletionItemKind,
  detail: string,
): CompletionItem {
  return { label, kind, detail, sortText: `0_${label}` };
}

function keyword(label: string, insertText?: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Keyword,
    detail: "SOQL",
    ...(insertText
      ? { insertText, insertTextFormat: InsertTextFormat.Snippet }
      : {}),
    sortText: `1_${label}`,
  };
}
