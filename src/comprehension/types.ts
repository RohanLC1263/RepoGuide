export type ContextQuality =
  | 'FULL_CODE_WITH_GRAPH'
  | 'PARTIAL_CODE_WITH_GRAPH'
  | 'FULL_CODE_ONLY'
  | 'PARTIAL_CODE_ONLY'
  | 'METADATA_ONLY'
  | 'NONE';

export type ConfidenceFieldType =
  | 'purpose'
  | 'domainRole'
  | 'callsInto'
  | 'errorPaths'
  | 'keyDecisions'
  | 'implicitContracts'
  | 'locationPrecision'
  | 'synonymQuality'
  | 'pathCompleteness'
  | 'summaryAccuracy';

export interface SourceLocation {
    filePath: string;
    startLine: number;
    endLine: number;
    symbolName?: string;
}

export interface ImportReference {
    source: string;
    importedNames: string[];
    resolvedPath?: string | null;
}

export interface ExportReference {
    name: string;
    kind: string;
    line: number;
}

export interface FunctionCall {
    callee: string;
    line: number;
    resolvedFilePath?: string | null;
    resolvedSymbol?: string | null;
    fullExpression?: string;
}

export interface FunctionSignature {
    name: string;
    kind: 'function' | 'method' | 'constructor';
    startLine: number;
    endLine: number;
    docstring?: string | null;
    calls: FunctionCall[];
    isExported?: boolean;
    bodyPreview?: string;
}

export interface ClassSignature {
    name: string;
    startLine: number;
    endLine: number;
    docstring?: string | null;
    extendsName?: string | null;
    methods: FunctionSignature[];
}

export interface FileStructure {
    filePath: string;
    language: string;
    imports: ImportReference[];
    exports: ExportReference[];
    classes: ClassSignature[];
    functions: FunctionSignature[];
    docstrings: string[];
    topLevelCalls: FunctionCall[];
    analyzedAt: string;
    hash: string;
}

export type LexicalSymbolKind = 'function' | 'class' | 'method' | 'constructor' | 'export';

export interface LexicalComment {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  kind: 'line' | 'block' | 'docstring';
}

export interface LexicalSymbol {
  id: string;
  name: string;
  kind: LexicalSymbolKind;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  containerName?: string;
  isExported: boolean;
  docstring?: string | null;
  leadingComments: LexicalComment[];
  confidence: 1.0;
}

export interface LexicalFileEntry {
  filePath: string;
  language: string;
  hash: string;
  updatedAt?: string;
  symbols: LexicalSymbol[];
  comments: LexicalComment[];
  docstrings: string[];
}

export interface LexicalMap {
  version: string;
  builtAt: string;
  projectRoot: string;
  fileCount?: number;
  files: Record<string, LexicalFileEntry>;
  symbolsByName: Record<string, string[]>;
  stats: {
    files: number;
    symbols: number;
    functions: number;
    classes: number;
    methods: number;
    exports: number;
    comments: number;
  };
  confidence: 1.0;
}

export interface CallGraphNode {
    id: string;
    filePath: string;
    outbound: string[];
    inbound: string[];
    callCount: number;
    entryPointDistance: number;
    importance: number;
}

export interface CallGraphEdge {
    from: string;
    to: string;
    callCount: number;
    via: string[];
}

export interface CallGraph {
    nodes: Record<string, CallGraphNode>;
    edges: CallGraphEdge[];
    generatedAt: string;
}

export interface FunctionNode {
  id: string;
  filePath: string;
  functionName: string;
  className?: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isEntryPoint: boolean;
  docstring?: string;
  bodyPreview?: string;
  outboundCalls: string[];
  inboundCalls: string[];
  callCount: number;
  importance: number;
}

export interface FunctionEdge {
  from: string;
  to: string;
  callLine: number;
  callExpression: string;
  isResolved: boolean;
}

export interface FunctionCallGraph {
  version: string;
  generatedAt: string;
  projectRoot: string;
  nodes: Record<string, FunctionNode>;
  edges: FunctionEdge[];
  entryPoints: string[];
  unresolvedCalls: FunctionCall[];
}

export interface CallChain {
  entryPoint: FunctionNode;
  nodes: FunctionNode[];
  edges: FunctionEdge[];
  depth: number;
  maxDepthReached: boolean;
}

export interface FlowContextBlock {
  filePath: string;
  functionName: string;
  startLine: number;
  endLine: number;
  bodyPreview: string;
  callsNext: string;
  depth: number;
}

export interface FlowContext {
  question: string;
  matchedEntryPoint: string;
  chain: CallChain;
  contextBlocks: FlowContextBlock[];
}

export type IntentType = 'location' | 'explanation' | 'flow' | 'architecture' | 'debugging' | 'orientation';

export interface ClassifiedIntent {
  intent: IntentType;
  confidence: number;
  concepts: string[];
  primaryEntity: string;
  entityConfidence: number;
  reasoning: string;
  classifiedBy: 'model' | 'heuristic';
  classifiedAt: string;
}

export interface NavigationTarget {
  filePath: string;
  startLine: number;
  endLine: number;
  confidence: number;
  source: 'symbol_index' | 'concept_map' | 'vector_search' | 'cache';
  symbolName?: string;
  reason: string;
}

export interface NavigationResult {
  targets: NavigationTarget[];
  primaryTarget: NavigationTarget | null;
  intent: IntentType;
  queryId: string;
}

export type RetrievalSource =
  | 'vector_search'
  | 'symbol_index'
  | 'concept_map'
  | 'flow_traversal'
  | 'module_understanding'
  | 'file_understanding';

export interface RetrievalStrategy {
  intent: IntentType;
  primarySources: RetrievalSource[];
  secondarySources: RetrievalSource[];
  maxChunks: number;
  scoreBoosts: Record<RetrievalSource, number>;
  skipVectorSearch: boolean;
  flowTraversalEnabled: boolean;
  conceptMapEnabled: boolean;
  symbolIndexEnabled: boolean;
  moduleUnderstandingEnabled: boolean;
  navigationFastPath: boolean;
  navigationConfidenceThreshold: number;
}

export interface ArchitectureContext {
  relevantModules: ModuleUnderstanding[];
  projectPurpose: string;
  architectureType: string;
  dataFlow: string;
  techStack: Record<string, string | string[]>;
}

export interface PassResult {
  pass: 1 | 2 | 3;
  content: string;
  tokenCount: number;
  durationMs: number;
  model: string;
}

export interface Gap {
  description: string;
  searchTerms: string[];
  targetFile?: string;
  gapType: 'location' | 'flow' | 'explanation' | 'context';
}

export interface GapAnalysis {
  hasGaps: boolean;
  gaps: Gap[];
  confidence: number;
  analysisBy: 'model' | 'markers';
}

export interface MultiPassResult {
  finalAnswer: string;
  passes: PassResult[];
  gapAnalysis: GapAnalysis | null;
  gapContextAdded: boolean;
  totalDurationMs: number;
  passCount: 1 | 2 | 3;
}

export type FileDomainRole =
  | 'orchestrator'
  | 'agent'
  | 'router'
  | 'schema'
  | 'service'
  | 'utility'
  | 'config'
  | 'test'
  | 'unknown';

export interface FileUnderstanding {
  schemaVersion?: string;
  filePath: string;
  language: string;
  purpose: string;
  domainRole?: FileDomainRole;
  exports: string[];
  whatEachExportDoes?: Record<string, string>;
  inputs?: string[];
  outputs?: string[];
  callsInto?: Record<string, string>;
  unresolvedCalls?: string[];
  errorPaths?: string[];
  fallbackPaths?: string[];
  keyDecisions?: string[];
  implicitContracts?: string[];
  confidence?: {
    purpose: number;
    domainRole: number;
    callsInto: number;
    errorPaths: number;
    keyDecisions: number;
    implicitContracts: number;
  };
  imports_from: string[];
  called_by: string[];
  calls_into: Record<string, string> | string[];
  key_concepts: string[];
  entry_points: string[];
  data_flow: string;
  complexity: 'low' | 'medium' | 'high';
  importance: 'peripheral' | 'supporting' | 'core';
  importanceScore: number;
  what_each_export_does?: Record<string, string>;
  error_paths?: string[];
  key_decisions?: string[];
  generatedAt: string;
  hash: string;
}

export type ModuleArchitecturalRole = 'core' | 'infrastructure' | 'interface' | 'utility' | 'test';

export interface ModuleExternalDependency {
  module: string;
  why: string;
}

export interface ModuleUnderstanding {
  /** Path to the directory (absolute). */
  modulePath: string;
  /** Relative path from project root — used as the map key in module_understanding.json. */
  moduleRelativePath: string;
  /** Absolute paths of all direct source files in this module. */
  filePaths: string[];
  /** LLM-generated one-sentence purpose. */
  modulePurpose: string;
  /** LLM-generated responsibilities list. */
  responsibilities: string[];
  /** Exported symbols and what they do. */
  publicInterface: Record<string, string>;
  /** Other modules imported by files within this module. */
  internalDependencies: string[];
  /** External module dependencies with reason. */
  externalDependencies: ModuleExternalDependency[];
  /** End-to-end data flow description. */
  dataFlow: string;
  /** Described error boundaries / failure modes. */
  errorBoundaries: string[];
  /** Key developer search terms. */
  keyConcepts: string[];
  /** Architectural role of this module. */
  architecturalRole: ModuleArchitecturalRole;
  /** LLM-reported confidence (used for display only — overridden by ConfidenceCalculator). */
  confidence: {
    summaryAccuracy: number;
  };
  generatedAt: string;
}

export interface ProjectUnderstanding {
  project: string;
  purpose: string;
  what_it_does?: string;
  architecture_type: string;
  entry_points: string[];
  data_flow: string;
  data_journey?: string;
  key_concepts: string[];
  tech_stack: Record<string, string | string[]>;
  modules: Record<string, string>;
  concept_map: Record<string, string[]>;
  component_roster?: Record<string, string>;
  domain_vocabulary?: Record<string, string>;
  critical_paths?: string[];
  failure_modes?: string[];
  architectural_decisions?: string[];
  generatedAt: string;
}

export interface RawConceptMapping {
  concept: string;
  filePath: string;
  symbolNames: string[];
  symbolKind: 'function' | 'class' | 'method' | 'export';
  startLine: number;
  endLine: number;
  fileImportanceScore: number;
  isExported: boolean;
  isEntryPoint: boolean;
}

export interface CodeLocation {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string;
  symbolKind: string;
  relevanceScore: number;
  excerpt: string;
}

export interface ConceptEntry {
  concept: string;
  synonyms: string[];
  locations: CodeLocation[];
  strength: number;
  relatedConcepts: string[];
  confidence?: {
    locationPrecision: number;
    synonymQuality: number;
  };
}

export interface SynonymGroup {
  canonical: string;
  synonyms: string[];
  partialMatches: string[];
}

export interface ConceptMap {
  version: string;
  builtAt: string;
  projectRoot: string;
  concepts: ConceptEntry[];
  synonymGroups: SynonymGroup[];
}

export interface ConceptSearchResult {
  location: CodeLocation;
  matchedConcept: string;
  matchScore: number;
  matchType: 'exact' | 'synonym' | 'partial' | 'related';
}

export interface IncrementalUpdateResult {
    filePath: string;
    structureChanged: boolean;
    fileUnderstandingUpdated: boolean;
    moduleUnderstandingUpdated: boolean;
    affectedFiles: string[];
    affectedModules: string[];
}

export interface ImportEdge {
    from: string;
    to: string;
    type: 'local' | 'external' | 'dynamic';
    importedNames: string[];
    isWildcard: boolean;
    lineNumber: number;
}

export interface ImportGraph {
    schemaVersion: string;
    builtAt: string;
    nodes: Record<string, { language: string; isEntryPoint: boolean; isExternal: boolean }>;
    edges: ImportEdge[];
    externalPackages: string[];
    unresolvedImports: Array<{ from: string; importString: string; reason: string }>;
    stats: {
        totalEdges: number;
        localEdges: number;
        externalEdges: number;
        unresolvedCount: number;
    };
}

export interface BehavioralPathHappyStep {
  step: number;
  symbol: string;
  relativePath: string;
  description: string;
  artifactsProduced: string[];
}

export interface BehavioralPathBranch {
  condition: string;
  atSymbol: string;
  truePath: string;
  falsePath: string;
}

export interface BehavioralPathError {
  triggerCondition: string;
  handledAt: string;
  outcome: string;
}

export interface BehavioralPathFallback {
  triggerCondition: string;
  fallback: string;
}

export interface BehavioralPathAsyncBoundary {
  symbol: string;
  description: string;
}

export interface BehavioralPath {
  id: string;
  entryPointId: string;
  entryPointSymbol: string;
  entryPointFile: string;
  summary: string;
  happyPath: BehavioralPathHappyStep[];
  branches: BehavioralPathBranch[];
  errorPaths: BehavioralPathError[];
  fallbackPaths: BehavioralPathFallback[];
  dataInputs: string[];
  dataOutputs: string[];
  asyncBoundaries: BehavioralPathAsyncBoundary[];
  confidence: number;
  callTreeDepth: number;
  nodesVisited: number;
}

export interface BehavioralPathIndex {
  schemaVersion: string;
  builtAt: string;
  paths: BehavioralPath[];
}
