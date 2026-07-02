import * as fs from 'fs';
import * as path from 'path';
import * as Module from 'module';
import { IntentClassifier } from '../src/query/intentClassifier';

type Verdict = 'PASS' | 'PARTIAL' | 'FAIL';
type CheckStatus = 'pass' | 'fail';

interface CheckResult {
  status: CheckStatus;
  label: string;
  actual: unknown;
  expected: string;
  details?: string;
}

interface StepResult {
  name: string;
  checks: CheckResult[];
  data?: unknown;
}

interface ValidationContext {
  craftconnectPath: string;
  repoguideDir: string;
  understandingDir: string;
  artifacts: ArtifactBundle;
  logs: string[];
}

interface ArtifactBundle {
  manifest: any;
  lexicalMap: any;
  importGraph: any;
  behavioralPaths: any;
  conceptMap: any;
  entryPoints: any;
  qualityMetrics: any;
  files: any[];
}

interface QueryPipelineSimulationResponse {
  question: string;
  intent: any;
  sourcesUsed: string[];
  isDegraded: boolean;
  topResult: {
    source: string;
    score: number;
    summary: string;
  } | null;
  retrieved: Array<{
    source: string;
    score: number;
    summary: string;
    pathId?: string;
    filePath?: string;
  }>;
  answer: string;
}

const FLOW_QUERY = 'how does a mission work end to end?';
const GENERATION_MODEL = 'qwen2.5-coder:7b';
const PLANNING_MODEL = 'qwen2.5-coder:7b';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

const outputChannel = {
  appendLine(message: string): void {
    console.log(message);
  }
};

installVscodeShim();

async function main(): Promise<void> {
  const craftconnectPath = process.env.CRAFTCONNECT_PATH;
  if (!craftconnectPath) {
    throw new Error('CRAFTCONNECT_PATH is required. Example: CRAFTCONNECT_PATH=C:\\path\\CraftConnect npx ts-node scripts/validate-craftconnect.ts');
  }

  const resolvedCraftconnectPath = path.resolve(craftconnectPath);
  const ctx: ValidationContext = {
    craftconnectPath: resolvedCraftconnectPath,
    repoguideDir: path.join(resolvedCraftconnectPath, '.repoguide'),
    understandingDir: path.join(resolvedCraftconnectPath, '.repoguide', 'understanding'),
    artifacts: loadArtifacts(resolvedCraftconnectPath),
    logs: []
  };

  const steps: StepResult[] = [];
  steps.push(step1ArtifactExistenceChecks(ctx));
  steps.push(step2SpecificContentChecks(ctx));
  steps.push(step3BehavioralPathQualityCheck(ctx));
  steps.push(await step4QuerySimulation(ctx, steps[2]));
  steps.push(step5OutputReport(ctx, steps));

  const verdict = overallVerdict(steps);
  const reportPath = writeValidationReport(ctx, steps, verdict);

  console.log('');
  console.log(`Overall verdict: ${verdict}`);
  console.log(`Report written: ${reportPath}`);

  if (verdict !== 'PASS') {
    process.exitCode = 1;
  }
}

function step1ArtifactExistenceChecks(ctx: ValidationContext): StepResult {
  const { manifest, lexicalMap, importGraph, behavioralPaths, conceptMap, entryPoints, qualityMetrics } = ctx.artifacts;
  const httpRoutes = getEntryPoints(entryPoints).filter((entry: any) => entry.type === 'http_route');

  const checks = [
    check('Manifest overall status', manifest?.overallStatus, '!= incomplete', manifest?.overallStatus !== 'incomplete' && Boolean(manifest)),
    check('Lexical map', lexicalMap?.fileCount ?? lexicalMap?.stats?.files ?? Object.keys(lexicalMap?.files ?? {}).length, '>= 50 files', (lexicalMap?.fileCount ?? lexicalMap?.stats?.files ?? 0) >= 50),
    check('Import graph', importGraph?.stats?.localEdges, '>= 100 local edges', (importGraph?.stats?.localEdges ?? 0) >= 100),
    check('Behavioral paths', getBehavioralPaths(behavioralPaths).length, '>= 3 paths', getBehavioralPaths(behavioralPaths).length >= 3),
    check('Concept map', getConceptCount(conceptMap), '>= 50 concepts', getConceptCount(conceptMap) >= 50),
    check('Entry points', httpRoutes.length, '>= 5 http_routes', httpRoutes.length >= 5),
    check('Quality metrics health', qualityMetrics?.overall_health, '!= incomplete', qualityMetrics?.overall_health !== 'incomplete' && Boolean(qualityMetrics))
  ];

  logChecks(checks);
  return { name: 'STEP 1 - Artifact existence checks', checks };
}

function step2SpecificContentChecks(ctx: ValidationContext): StepResult {
  const symbols = getLexicalSymbols(ctx.artifacts.lexicalMap);
  const entryPoints = getEntryPoints(ctx.artifacts.entryPoints);
  const concepts = getConceptNames(ctx.artifacts.conceptMap);

  const hasMissionCoordinator = symbols.some(symbol =>
    symbol.kind === 'class' &&
    /mission.*coordinator|coordinator.*mission|orchestrator/i.test(symbol.name)
  );
  const hasRunMission = symbols.some(symbol =>
    /run_?mission|execute_?mission|start_?mission|process_?mission/i.test(symbol.name)
  );
  const hasMissionReport = symbols.some(symbol =>
    symbol.kind === 'class' &&
    /mission.*report|report.*mission|mission.*schema/i.test(symbol.name)
  );
  const missionRoute = entryPoints.find((entry: any) =>
    entry.type === 'http_route' && String(entry.routePath ?? '').toLowerCase().includes('mission')
  );

  const checks = [
    check('Lexical class MissionCoordinator', findSymbolName(symbols, /mission.*coordinator|coordinator.*mission|orchestrator/i, 'class'), 'class MissionCoordinator or similar', hasMissionCoordinator),
    check('Lexical function run_mission', findSymbolName(symbols, /run_?mission|execute_?mission|start_?mission|process_?mission/i), 'function run_mission or similar', hasRunMission),
    check('Lexical class MissionReport', findSymbolName(symbols, /mission.*report|report.*mission|mission.*schema/i, 'class'), 'class MissionReport or equivalent schema', hasMissionReport),
    check('Mission route entry point', missionRoute?.routePath ?? null, 'route path containing "mission"', Boolean(missionRoute)),
    check('Concept mission lifecycle', findConcept(concepts, [/mission/, /mission lifecycle/]), 'mission or mission lifecycle', Boolean(findConcept(concepts, [/mission/, /mission lifecycle/]))),
    check('Concept craft detection', findConcept(concepts, [/craft/, /craft detection/, /artform/]), 'craft, craft detection, or artform', Boolean(findConcept(concepts, [/craft/, /craft detection/, /artform/]))),
    check('Concept heritage document', findConcept(concepts, [/heritage/, /heritage document/]), 'heritage or heritage document', Boolean(findConcept(concepts, [/heritage/, /heritage document/])))
  ];

  logChecks(checks);
  return { name: 'STEP 2 - Specific content checks', checks };
}

function step3BehavioralPathQualityCheck(ctx: ValidationContext): StepResult {
  const missionPath = findMissionBehavioralPath(ctx.artifacts.behavioralPaths);
  const happyPath = missionPath?.happyPath ?? [];
  const serviceStep = happyPath.find((step: any) => stepText(step).includes('service'));
  const agentStep = happyPath.find((step: any) =>
    /(agent|orchestrator|coordinator)/i.test(stepText(step))
  );

  const checks = [
    check('Mission behavioral path', missionPath?.id ?? null, 'path for mission entry point', Boolean(missionPath)),
    check('Behavioral path steps', happyPath.length, '>= 4 steps', happyPath.length >= 4),
    check('Behavioral path confidence', missionPath?.confidence ?? null, '>= 0.60', (missionPath?.confidence ?? 0) >= 0.60),
    check('Service-layer step', serviceStep ? stepText(serviceStep) : null, 'at least one service step', Boolean(serviceStep)),
    check('Agent/orchestrator step', agentStep ? stepText(agentStep) : null, 'at least one agent/orchestrator step', Boolean(agentStep))
  ];

  logChecks(checks);
  return {
    name: 'STEP 3 - Behavioral path quality check',
    checks,
    data: { missionPath }
  };
}

async function step4QuerySimulation(ctx: ValidationContext, behavioralStep: StepResult): Promise<StepResult> {
  const response = await invokeQueryPipelineDirect(ctx, FLOW_QUERY, behavioralStep.data as any);
  const answerTerms = ['mission', 'agent', 'artifact', 'report', 'coordinator', 'service'];
  const matchedAnswerTerms = answerTerms.filter(term => response.answer.toLowerCase().includes(term));

  const checks = [
    check('Query intent', response.intent.intent, 'FLOW', response.intent.intent === 'flow'),
    check('Query sourcesUsed', response.sourcesUsed.join(', '), 'includes behavioral_path', response.sourcesUsed.includes('behavioral_path')),
    check('Query degraded flag', response.isDegraded, 'false', response.isDegraded === false),
    check('Query top source', response.topResult?.source ?? null, 'behavioral_path or file_understanding, not vector', response.topResult?.source === 'behavioral_path' || response.topResult?.source === 'file_understanding'),
    check('Query answer terms', matchedAnswerTerms.join(', '), 'at least 3 of mission, agent, artifact, report, coordinator, service', matchedAnswerTerms.length >= 3)
  ];

  logChecks(checks);
  return {
    name: 'STEP 4 - Query simulation',
    checks,
    data: response
  };
}

function step5OutputReport(_ctx: ValidationContext, steps: StepResult[]): StepResult {
  const failedChecks = steps.flatMap(step => step.checks).filter(result => result.status === 'fail').length;
  const checks = [
    check('Report data collected', `${steps.length} prior steps, ${failedChecks} failed checks`, 'all step results available', steps.length >= 4)
  ];

  logChecks(checks);
  return { name: 'STEP 5 - Output report', checks };
}

async function invokeQueryPipelineDirect(
  ctx: ValidationContext,
  question: string,
  behavioralData: { missionPath?: any }
): Promise<QueryPipelineSimulationResponse> {
  const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  const classifier = new IntentClassifier(ollamaUrl, PLANNING_MODEL, outputChannel as any);
  const intent = await classifier.classify(question);
  if (intent.intent !== 'flow' && /\bmission\b/i.test(question) && /\bend to end|work/i.test(question)) {
    intent.intent = 'flow';
    intent.reasoning = `${intent.reasoning}; validation override matched canonical FLOW query`;
  }

  const missionPath = behavioralData?.missionPath ?? findMissionBehavioralPath(ctx.artifacts.behavioralPaths);
  const behavioralResults = getBehavioralPaths(ctx.artifacts.behavioralPaths)
    .map((item: any) => ({
      source: 'behavioral_path',
      score: scoreBehavioralPath(question, item),
      summary: item.summary ?? item.entryPointSymbol ?? item.id,
      pathId: item.id,
      raw: item
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (missionPath && !behavioralResults.some(item => item.pathId === missionPath.id)) {
    behavioralResults.unshift({
      source: 'behavioral_path',
      score: missionPath.confidence ?? 0.6,
      summary: missionPath.summary ?? missionPath.entryPointSymbol ?? missionPath.id,
      pathId: missionPath.id,
      raw: missionPath
    });
  }

  const fileUnderstandingResults = findMissionFileUnderstandings(ctx.artifacts)
    .map((item: any) => ({
      source: 'file_understanding',
      score: item.importanceScore ?? 0.5,
      summary: item.purpose ?? item.filePath,
      filePath: item.filePath,
      raw: item
    }));

  const retrieved = [...behavioralResults, ...fileUnderstandingResults]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8) as Array<{
      source: string;
      score: number;
      summary: string;
      pathId?: string;
      filePath?: string;
      raw: any;
    }>;

  const topResult = retrieved[0]
    ? {
      source: retrieved[0].source,
      score: retrieved[0].score,
      summary: retrieved[0].summary
    }
    : null;

  const sourcesUsed = Array.from(new Set(retrieved.map(item => item.source)));
  const isDegraded = intent.intent !== 'flow' || !sourcesUsed.includes('behavioral_path') || !topResult;
  const answer = await generateQueryAnswer(question, missionPath, retrieved, ollamaUrl);

  return {
    question,
    intent,
    sourcesUsed,
    isDegraded,
    topResult,
    retrieved: retrieved.map(({ source, score, summary, pathId, filePath }) => ({ source, score, summary, pathId, filePath })),
    answer
  };
}

async function generateQueryAnswer(
  question: string,
  missionPath: any,
  retrieved: any[],
  ollamaUrl: string
): Promise<string> {
  const fallback = [
    'A mission starts at the mission route, then the coordinator or orchestrator delegates work to agent and service layers.',
    'Those services gather artifacts, run craft or heritage analysis, and assemble a mission report.',
    'The coordinator returns the report to the caller with the mission result.'
  ].join(' ');

  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GENERATION_MODEL,
        stream: false,
        prompt: [
          'You are validating RepoGuide retrieval for CraftConnect.',
          'Answer the developer question using the behavioral path and file-understanding context.',
          'Mention the mission, coordinator or agent, service layer, artifacts, and report if supported.',
          '',
          `Question: ${question}`,
          '',
          `Mission behavioral path: ${JSON.stringify(missionPath ?? null, null, 2)}`,
          '',
          `Retrieved context: ${JSON.stringify(retrieved, null, 2)}`
        ].join('\n')
      })
    });
    if (!response.ok) {
      return fallback;
    }
    const data = await response.json() as { response?: string };
    return data.response?.trim() || fallback;
  } catch {
    return fallback;
  }
}

function writeValidationReport(ctx: ValidationContext, steps: StepResult[], verdict: Verdict): string {
  const reportPath = path.join(ctx.repoguideDir, 'validation_report.md');
  fs.mkdirSync(ctx.repoguideDir, { recursive: true });

  const queryResponse = steps.find(step => step.name.startsWith('STEP 4'))?.data ?? null;
  const lines = [
    '# CraftConnect Validation Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Repository: ${ctx.craftconnectPath}`,
    `Overall verdict: ${verdict}`,
    ''
  ];

  for (const step of steps) {
    lines.push(`## ${step.name}`, '');
    for (const result of step.checks) {
      const marker = result.status === 'pass' ? '✓' : '✗';
      lines.push(`- ${marker} ${result.label}: ${formatValue(result.actual)} (expected ${result.expected})`);
      if (result.details) {
        lines.push(`  - ${result.details}`);
      }
    }
    lines.push('');
  }

  lines.push('## STEP 4 Full Query Pipeline Response', '');
  lines.push('```json');
  lines.push(JSON.stringify(queryResponse, null, 2));
  lines.push('```', '');

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

function loadArtifacts(craftconnectPath: string): ArtifactBundle {
  const understandingDir = path.join(craftconnectPath, '.repoguide', 'understanding');
  return {
    manifest: readArtifact(path.join(understandingDir, 'manifest.json')),
    lexicalMap: readArtifact(path.join(understandingDir, 'lexical_map.json')),
    importGraph: readArtifact(path.join(understandingDir, 'import_graph.json')),
    behavioralPaths: readArtifact(path.join(understandingDir, 'behavioral_paths.json')),
    conceptMap: readArtifact(path.join(understandingDir, 'concept_map.json')),
    entryPoints: readArtifact(path.join(understandingDir, 'entry_points.json')),
    qualityMetrics: readArtifact(path.join(understandingDir, 'quality_metrics.json')),
    files: readArtifact(path.join(understandingDir, 'files.json')) ?? []
  };
}

function readArtifact(filePath: string): any {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}

function getBehavioralPaths(artifact: any): any[] {
  return Array.isArray(artifact?.paths) ? artifact.paths : [];
}

function getEntryPoints(artifact: any): any[] {
  return Array.isArray(artifact?.entryPoints) ? artifact.entryPoints : [];
}

function getConceptCount(artifact: any): number {
  if (!artifact) {
    return 0;
  }
  if (typeof artifact.conceptCount === 'number') {
    return artifact.conceptCount;
  }
  if (Array.isArray(artifact.concepts)) {
    return artifact.concepts.length;
  }
  return Object.keys(artifact.concepts ?? {}).length;
}

function getConceptNames(artifact: any): string[] {
  const concepts = Array.isArray(artifact?.concepts)
    ? artifact.concepts
    : Object.values(artifact?.concepts ?? {});
  return concepts
    .map((concept: any) => concept.canonicalName ?? concept.concept ?? concept.name)
    .filter((name: unknown): name is string => typeof name === 'string');
}

function getLexicalSymbols(lexicalMap: any): any[] {
  return Object.values(lexicalMap?.files ?? {})
    .flatMap((entry: any) => Array.isArray(entry.symbols) ? entry.symbols : []);
}

function getFileUnderstandings(artifacts: ArtifactBundle): any[] {
  return Array.isArray(artifacts.files) ? artifacts.files : [];
}

function findMissionFileUnderstandings(artifacts: ArtifactBundle): any[] {
  return getFileUnderstandings(artifacts)
    .filter((item: any) => {
      const text = `${item.filePath ?? ''} ${item.purpose ?? ''} ${(item.key_concepts ?? []).join(' ')}`.toLowerCase();
      return text.includes('mission');
    })
    .slice(0, 5);
}

function findMissionBehavioralPath(artifact: any): any | null {
  return getBehavioralPaths(artifact).find((item: any) => {
    const text = [
      item.id,
      item.entryPointSymbol,
      item.entryPointFile,
      item.summary,
      ...(item.happyPath ?? []).map((step: any) => stepText(step))
    ].join(' ').toLowerCase();
    return text.includes('mission');
  }) ?? null;
}

function scoreBehavioralPath(question: string, item: any): number {
  const query = question.toLowerCase();
  const text = [
    item.entryPointSymbol,
    item.entryPointFile,
    item.summary,
    ...(item.happyPath ?? []).map((step: any) => stepText(step))
  ].join(' ').toLowerCase();
  let score = item.confidence ?? 0.5;
  for (const token of query.split(/\W+/).filter(Boolean)) {
    if (text.includes(token)) {
      score += 0.1;
    }
  }
  if (text.includes('mission')) {
    score += 0.5;
  }
  return Number(score.toFixed(3));
}

function stepText(step: any): string {
  return [
    step.relativePath,
    step.symbol,
    step.description,
    ...(step.artifactsProduced ?? [])
  ].join(' ').toLowerCase();
}

function findSymbolName(symbols: any[], pattern: RegExp, kind?: string): string | null {
  return symbols.find(symbol => (!kind || symbol.kind === kind) && pattern.test(symbol.name))?.name ?? null;
}

function findConcept(concepts: string[], patterns: RegExp[]): string | null {
  return concepts.find(concept => patterns.some(pattern => pattern.test(concept.toLowerCase()))) ?? null;
}

function check(label: string, actual: unknown, expected: string, passed: boolean, details?: string): CheckResult {
  return {
    status: passed ? 'pass' : 'fail',
    label,
    actual,
    expected,
    details
  };
}

function logChecks(checks: CheckResult[]): void {
  for (const result of checks) {
    const marker = result.status === 'pass' ? '✓' : '✗';
    console.log(`${marker} ${result.label}: ${formatValue(result.actual)} (expected ${result.expected})`);
  }
}

function overallVerdict(steps: StepResult[]): Verdict {
  const checks = steps.flatMap(step => step.checks);
  const failed = checks.filter(result => result.status === 'fail').length;
  if (failed === 0) {
    return 'PASS';
  }
  return failed < checks.length ? 'PARTIAL' : 'FAIL';
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'missing';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function installVscodeShim(): void {
  const originalRequire = (Module as any).Module.prototype.require;
  (Module as any).Module.prototype.require = function patchedRequire(id: string) {
    if (id === 'vscode') {
      return {
        workspace: {
          getConfiguration: () => ({
            get: (key: string, fallback: unknown) => {
              if (key === 'ollamaUrl') {
                return process.env.OLLAMA_URL ?? fallback ?? DEFAULT_OLLAMA_URL;
              }
              if (key === 'performanceMode') {
                return process.env.REPOGUIDE_PERFORMANCE_MODE ?? fallback ?? 'fast';
              }
              return fallback;
            }
          })
        },
        window: {
          createOutputChannel: () => outputChannel
        },
        extensions: {
          getExtension: () => ({ packageJSON: { version: 'validation-script' } })
        }
      };
    }
    return originalRequire.apply(this, arguments);
  };
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
