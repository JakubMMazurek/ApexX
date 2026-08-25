import fs from "node:fs";
import path from "node:path";

export interface SObjectFieldInfo {
  name: string;
  type: string;
  label?: string;
  custom?: boolean;
  referenceTo?: string[];
}

interface SObjectSchemaFile {
  name?: string;
  fields?: SObjectFieldInfo[];
}

const schemaCache = new Map<string, SObjectFieldInfo[] | undefined>();

const commonSObjectFields: SObjectFieldInfo[] = [
  field("Id", "id", "Record ID"),
  field("OwnerId", "reference", "Owner ID", ["User", "Group"]),
  field("CreatedDate", "datetime", "Created Date"),
  field("CreatedById", "reference", "Created By ID", ["User"]),
  field("LastModifiedDate", "datetime", "Last Modified Date"),
  field("LastModifiedById", "reference", "Last Modified By ID", ["User"]),
  field("SystemModstamp", "datetime", "System Modstamp"),
  field("IsDeleted", "boolean", "Deleted"),
];

const fallbackSObjects: Record<string, SObjectFieldInfo[]> = {
  account: [
    ...commonSObjectFields,
    field("Name", "string", "Account Name"),
    field("Rating", "picklist", "Account Rating"),
    field("Type", "picklist", "Account Type"),
    field("Industry", "picklist", "Industry"),
    field("Phone", "phone", "Account Phone"),
    field("Fax", "phone", "Account Fax"),
    field("Website", "url", "Website"),
    field("AccountNumber", "string", "Account Number"),
    field("AccountSource", "picklist", "Account Source"),
    field("AnnualRevenue", "currency", "Annual Revenue"),
    field("NumberOfEmployees", "int", "Employees"),
    field("ParentId", "reference", "Parent Account ID", ["Account"]),
    field("Description", "textarea", "Account Description"),
    field("Site", "string", "Account Site"),
    field("BillingStreet", "textarea", "Billing Street"),
    field("BillingCity", "string", "Billing City"),
    field("BillingState", "string", "Billing State/Province"),
    field("BillingPostalCode", "string", "Billing Zip/Postal Code"),
    field("BillingCountry", "string", "Billing Country"),
    field("ShippingStreet", "textarea", "Shipping Street"),
    field("ShippingCity", "string", "Shipping City"),
    field("ShippingState", "string", "Shipping State/Province"),
    field("ShippingPostalCode", "string", "Shipping Zip/Postal Code"),
    field("ShippingCountry", "string", "Shipping Country"),
    field("LastActivityDate", "date", "Last Activity"),
    field("LastViewedDate", "datetime", "Last Viewed Date"),
    field("LastReferencedDate", "datetime", "Last Referenced Date"),
    field("Contacts", "List<Contact>", "Contacts"),
  ],
  contact: [
    ...commonSObjectFields,
    field("AccountId", "reference", "Account ID", ["Account"]),
    field("FirstName", "string", "First Name"),
    field("LastName", "string", "Last Name"),
    field("Name", "string", "Name"),
    field("Email", "email", "Email"),
    field("Phone", "phone", "Phone"),
    field("Title", "string", "Title"),
  ],
};

/** Cached so identifier completion does not stat the schema directory per keystroke. */
let sObjectNameCache: { root: string | undefined; names: string[] } | undefined;

/**
 * SObjects this workspace knows about: whatever `.apexx/schema/sobjects` has been
 * refreshed with, plus the ones ApexX falls back to when nothing has been.
 */
export function knownSObjectNames(workspaceRoot: string | undefined): string[] {
  if (sObjectNameCache && sObjectNameCache.root === workspaceRoot) {
    return sObjectNameCache.names;
  }

  const names = new Set<string>();

  for (const name of Object.keys(fallbackSObjects)) {
    names.add(name.charAt(0).toUpperCase() + name.slice(1));
  }

  if (workspaceRoot) {
    const schemaDirectory = path.join(
      workspaceRoot,
      ".apexx",
      "schema",
      "sobjects",
    );

    try {
      for (const entry of fs.readdirSync(schemaDirectory)) {
        if (entry.toLowerCase().endsWith(".json")) {
          names.add(entry.slice(0, -".json".length));
        }
      }
    } catch {
      // No refreshed schema: the fallbacks stand on their own.
    }
  }

  const sorted = [...names].sort((left, right) => left.localeCompare(right));
  sObjectNameCache = { root: workspaceRoot, names: sorted };
  return sorted;
}

export function getSObjectFields(
  typeName: string,
  workspaceRoot: string | undefined,
): SObjectFieldInfo[] | undefined {
  const normalized = normalizeSObjectName(typeName);
  if (!normalized || isPrimitiveType(normalized)) {
    return undefined;
  }

  return mergeSObjectFields(
    fallbackSObjects[normalized.toLowerCase()] ?? [],
    readWorkspaceSchema(normalized, workspaceRoot) ?? [],
  );
}

function mergeSObjectFields(
  fallbackFields: SObjectFieldInfo[],
  workspaceFields: SObjectFieldInfo[],
): SObjectFieldInfo[] {
  const merged = new Map<string, SObjectFieldInfo>();

  for (const fieldInfo of fallbackFields) {
    merged.set(fieldInfo.name.toLowerCase(), fieldInfo);
  }

  for (const fieldInfo of workspaceFields) {
    merged.set(fieldInfo.name.toLowerCase(), fieldInfo);
  }

  return [...merged.values()];
}

function readWorkspaceSchema(
  typeName: string,
  workspaceRoot: string | undefined,
): SObjectFieldInfo[] | undefined {
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

  const fields = readSchemaFile(schemaPath);
  schemaCache.set(cacheKey, fields);
  return fields;
}

function readSchemaFile(schemaPath: string): SObjectFieldInfo[] | undefined {
  if (!fs.existsSync(schemaPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as SObjectSchemaFile;
    const fields = parsed.fields?.filter(isValidField) ?? [];
    return fields.length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}

function isValidField(fieldInfo: SObjectFieldInfo): boolean {
  return (
    typeof fieldInfo.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_]*(__c)?$/.test(fieldInfo.name) &&
    typeof fieldInfo.type === "string"
  );
}

function normalizeSObjectName(typeName: string): string | undefined {
  const normalized = typeName.trim().split(".").at(-1) ?? "";
  return /^[A-Za-z][A-Za-z0-9_]*(__c)?$/.test(normalized)
    ? normalized
    : undefined;
}

function isPrimitiveType(typeName: string): boolean {
  return /^(Boolean|Integer|Long|Decimal|Double|String|Id|Object|Date|Datetime|DateTime|Time)$/i.test(
    typeName,
  );
}

function field(
  name: string,
  type: string,
  label: string,
  referenceTo: string[] = [],
): SObjectFieldInfo {
  return { name, type, label, referenceTo };
}
