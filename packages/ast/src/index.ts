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

export type ListMethodCallStatementKind = "return" | "assignment" | "expression";
export type FilterLambdaStatementKind = ListMethodCallStatementKind;

export type ListMethodName =
  | "filter"
  | "map"
  | "flatMap"
  | "any"
  | "all"
  | "count"
  | "find";
export type ListMethodResultKind = "list" | "scalar";

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

export interface CapturedVariable {
  name: string;
  type: string;
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
  resultElementType?: string;
  resultType?: string;
  resultKind?: ListMethodResultKind;
  stepInputTypes?: string[];
  stepResultTypes?: string[];
  stepResultKinds?: ListMethodResultKind[];
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
  isReassignment?: boolean;
  captures?: CapturedVariable[];
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
  workspaceRoot?: string;
}

/**
 * Exact offset mapping between authored ApexX and the generated Apex. `undefined`
 * means the offset has no counterpart, which is a real answer: generated support
 * code has no authored origin, and lowered syntax has no generated equivalent.
 */
export interface ApexXPositionMap {
  toSource(outputOffset: number): number | undefined;
  toOutput(sourceOffset: number): number | undefined;
  /** True when the offset lands in text copied through unchanged by every stage. */
  isVerbatim(outputOffset: number): boolean;
}

export interface TranspileResult {
  source: string;
  output: string;
  /** Maps offsets in `output` to offsets in `source`, and back. */
  sourceMap: ApexXPositionMap;
  /** Generated type name to the ApexX type it stands for, e.g. `Func<Account, Boolean>`. */
  generatedTypeNames: Map<string, string>;
  supportClasses: GeneratedApexSupportClass[];
  diagnostics: ApexXDiagnostic[];
  listMethodCalls: ListMethodCallExpression[];
  funcLambdaAssignments: FuncLambdaAssignment[];
  funcInvocations: FuncInvocation[];
  filters: FilterLambdaExpression[];
}

export interface GeneratedApexSupportClass {
  className: string;
  source: string;
}
