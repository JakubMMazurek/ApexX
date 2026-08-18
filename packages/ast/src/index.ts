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
  parameters: LambdaParameter[];
  body: string;
  range: SourceRange;
}

export interface LambdaParameter {
  name: string;
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

export interface FuncLambdaAssignment {
  kind: "funcLambdaAssignment";
  indent: string;
  sourceFuncType: string;
  parameterTypes: string[];
  returnType: string;
  variableName: string;
  lambda: LambdaExpression;
  originalText: string;
  range: SourceRange;
  interfaceName?: string;
  implementationName?: string;
}

export interface FuncInvocation {
  kind: "funcInvocation";
  variableName: string;
  argumentsText: string;
  originalText: string;
  range: SourceRange;
}

export interface ApexXParseResult {
  source: string;
  fileName?: string;
  listMethodCalls: ListMethodCallExpression[];
  funcLambdaAssignments: FuncLambdaAssignment[];
  funcInvocations: FuncInvocation[];
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
  funcLambdaAssignments: FuncLambdaAssignment[];
  funcInvocations: FuncInvocation[];
  filters: FilterLambdaExpression[];
}
