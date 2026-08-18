export type ApexXDiagnosticSeverity = "error" | "warning" | "info";

export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface ApexXDiagnostic {
  severity: ApexXDiagnosticSeverity;
  message: string;
  range?: SourceRange;
  source?: string;
}

export interface ListTypeInfo {
  collectionType: "List";
  elementType: string;
  variableName: string;
}

export type FilterLambdaStatementKind = "return" | "assignment";

export interface FilterLambdaExpression {
  kind: "filter";
  statementKind: FilterLambdaStatementKind;
  receiver: string;
  parameterName: string;
  predicate: string;
  originalText: string;
  indent: string;
  range: SourceRange;
  targetName?: string;
  targetType?: string;
  elementType?: string;
  resultTempName?: string;
}

export interface ApexXParseResult {
  source: string;
  fileName?: string;
  filters: FilterLambdaExpression[];
  diagnostics: ApexXDiagnostic[];
}

export interface TranspileOptions {
  sourceFileName?: string;
}

export interface TranspileResult {
  source: string;
  output: string;
  diagnostics: ApexXDiagnostic[];
  filters: FilterLambdaExpression[];
}

