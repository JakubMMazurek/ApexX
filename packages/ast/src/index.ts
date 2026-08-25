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
  /**
   * Stable identifier for diagnostics about constructs whose lowering hides the real
   * Apex type behind a generated class, so a reader has something to look up that
   * survives a reworded message. Carried as data rather than as a message prefix, so
   * an editor can show it, filter on it, and link it to its documentation.
   */
  code?: string;
}

export interface ListTypeInfo {
  collectionType: "List";
  elementType: string;
  variableName: string;
}

export type ListMethodCallStatementKind =
  | "return"
  | "assignment"
  | "expression"
  /** Nested inside a larger statement, e.g. `System.debug(list.filter(...))`. */
  | "embedded";
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
  /** Covers exactly `body`, so an offset inside it can be reported in the source. */
  bodyRange: SourceRange;
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
  /**
   * Set for an `embedded` call. A chain lowers to a loop, and a loop is a statement, so
   * the loop is emitted before the statement the chain sits in and the chain itself is
   * replaced by the name the loop leaves its result in. This records the statement to
   * rebuild and where within it the chain sits, as offsets into `statementText`.
   */
  embedded?: {
    /** The whole statement, without its leading indentation. */
    statementText: string;
    chainStart: number;
    chainEnd: number;
  };
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

/**
 * Which kind of Apex the pipeline is targeting.
 *
 * `class` produces a compilation unit: one top-level class per file, with shared
 * structural types collected into the `ApexXFuncs` and `ApexXTuples` registries.
 * `anonymous` produces an anonymous block for `sf apex run`, where a class the
 * block declares is an inner type. Inner types cannot themselves have inner
 * types, so a script carries flat declarations of the structural types it uses
 * and needs nothing deployed.
 */
export type ApexXUnitMode = "class" | "anonymous";

/**
 * Where an anonymous block's structural types come from.
 *
 * `inline` declares them in the block, so the script needs nothing deployed.
 * `deployed` names them as members of the `ApexXFuncs` and `ApexXTuples`
 * registries, which is required when the script passes a `Func` or a tuple to or
 * from a deployed ApexX class: the same signature has the same name either way,
 * but a flat name and a registry member are different Apex types. Ignored in
 * class mode, which always uses the registries.
 */
export type ApexXStructuralTypes = "inline" | "deployed";

export interface TranspileOptions {
  sourceFileName?: string;
  workspaceRoot?: string;
  /** Defaults to `class`. */
  mode?: ApexXUnitMode;
  /** Defaults to `inline`. */
  structuralTypes?: ApexXStructuralTypes;
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
