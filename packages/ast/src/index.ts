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

export type ListMethodCallStatementKind = "return" | "assignment";
export type FilterLambdaStatementKind = ListMethodCallStatementKind;

export type ListMethodName = "filter";

export interface LambdaExpression {
  parameterName: string;
  body: string;
  range: SourceRange;
}

export interface ListMethodCallStep {
  methodName: ListMethodName;
  lambda: LambdaExpression;
  range: SourceRange;
}

export interface ListMethodCallExpression {
  kind: "listMethodCall";
  statementKind: ListMethodCallStatementKind;
  receiver: string;
  parameterName: string;
  predicate: string;
  steps: ListMethodCallStep[];
  originalText: string;
  indent: string;
  range: SourceRange;
  targetName?: string;
  targetType?: string;
  elementType?: string;
  resultTempName?: string;
  resultTempNames?: string[];
}

export type FilterLambdaExpression = ListMethodCallExpression;

export interface ApexXParseResult {
  source: string;
  fileName?: string;
  listMethodCalls: ListMethodCallExpression[];
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
  listMethodCalls: ListMethodCallExpression[];
  filters: FilterLambdaExpression[];
}
