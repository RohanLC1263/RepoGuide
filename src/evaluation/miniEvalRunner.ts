import * as fs from 'fs';
import * as path from 'path';
import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { ComprehensionJobRunner } from '../comprehension/comprehensionJobRunner';
import { SymbolIndex } from '../indexing/symbolIndex';
import { loadGoldenQuestionSet } from './goldenQuestionLoader';
import { loadFlowArtifacts } from './flowArtifactInspector';
import { QueryPipelineHarness } from './queryPipelineHarness';
import { scoreQuestion } from './scorers';
import { EvalMode, EvalQuestionResult, EvalRunOptions, EvalRunResult, ArtifactAvailability } from './types';
import { loadPreviousRun, summarizeResults, writeEvalReport } from './reportWriter';
import { UnderstandingHealthService } from '../comprehension/understandingHealthService';
import { validateArchitectureInvariants, validateEvidenceContracts } from './canonicalValidation';
import { writePhase3Reports } from './phase3ReportWriter';
import { Logger, RepositoryContext } from '../context/repositoryContext';
import { prepareRepository } from '../preparation/repositoryPreparation';
import {
    assertRepositoryReady,
    buildRepositoryReadinessReport,
    writeRepositoryReadinessReport
} from '../preparation/repositoryReadiness';

type OutputLogger = { appendLine(message: string): void };

class EvalStatusBar {
    setIndexing(): void {}
    setIndexingProgress(): void {}
    setReady(): void {}
    setError(): void {}
    setSynced(): void {}
}

export interface EvalRunArtifacts {
    result: EvalRunResult;
    jsonPath: string;
    markdownPath: string;
    latestPath: string;
}

export class MiniEvalRunner {
    constructor(private readonly outputChannel: OutputLogger = consoleOutput) {}

    async run(options: EvalRunOptions): Promise<EvalRunArtifacts> {
        const startedAt = new Date().toISOString();
        const workspaceRoot = path.resolve(options.repoPath);
        const repoguideDir = path.join(workspaceRoot, '.repoguide');
        this.outputChannel.appendLine(`[Eval] Target repo root: ${workspaceRoot}`);
        const understandingDir = path.join(repoguideDir, 'understanding');
        const outputDir = options.outputDir ?? path.join(repoguideDir, 'eval');
        fs.mkdirSync(outputDir, { recursive: true });

        const previous = loadPreviousRun(outputDir);
        const questionSet = loadGoldenQuestionSet(options.questionsPath);
        const mode: EvalMode = options.mode ?? 'evidence';
        this.outputChannel.appendLine(`[Eval] Mode: ${mode}`);

        if (options.prepare) {
            await this.prepareRepo(workspaceRoot, repoguideDir);
        } else if (options.useExistingArtifacts) {
            this.outputChannel.appendLine('[Eval] Using existing RepoGuide artifacts; comprehension will not be rebuilt.');
            const readinessReport = await buildRepositoryReadinessReport(workspaceRoot, repoguideDir);
            await writeRepositoryReadinessReport(readinessReport);
            assertRepositoryReady(readinessReport);
        } else {
            const readinessReport = await buildRepositoryReadinessReport(workspaceRoot, repoguideDir);
            await writeRepositoryReadinessReport(readinessReport);
            assertRepositoryReady(readinessReport);
        }

        const harness = new QueryPipelineHarness({
            workspaceRoot,
            repoguideDir,
            outputChannel: this.outputChannel,
            mode
        });
        await harness.init();

        const healthService = new UnderstandingHealthService(understandingDir, workspaceRoot);
        const healthReport = await healthService.evaluateHealth();

        const flowArtifacts = loadFlowArtifacts(understandingDir);
        const results: EvalQuestionResult[] = [];
        for (const question of questionSet.questions) {
            this.outputChannel.appendLine(`[Eval] Running ${question.id}: ${question.question}`);
            try {
                const harnessResult = await harness.runQuestion(question, options.shadowEval);
                const scored = scoreQuestion({
                    question,
                    output: harnessResult.output,
                    shadowOutput: harnessResult.shadowOutput,
                    flowArtifacts,
                    workspaceRoot
                });
                if (mode === 'evidence') {
                    scored.contractValidation = validateEvidenceContracts(harnessResult.output.telemetry);
                    if (!scored.contractValidation.passed) {
                        scored.notes.push(...scored.contractValidation.violations.map(v => `Contract violation in ${v.component}: ${v.message}`));
                    }
                }
                if (mode === 'compare' && harnessResult.shadowOutput) {
                    scored.shadowContractValidation = validateEvidenceContracts(harnessResult.shadowOutput.telemetry);
                    if (!scored.shadowContractValidation.passed) {
                        scored.shadowNotes = [
                            ...(scored.shadowNotes ?? []),
                            ...scored.shadowContractValidation.violations.map(v => `Contract violation in ${v.component}: ${v.message}`)
                        ];
                    }
                }
                results.push(scored);
            } catch (error) {
                results.push({
                    id: question.id,
                    type: question.type,
                    question: question.question,
                    expectedAnswer: question.expectedAnswer,
                    answer: '',
                    controlEvents: { navigationResults: [] },
                    capturedContext: {
                        retrievedChunkIds: [],
                        retrievedArtifacts: [],
                        topCitedFiles: [],
                        citedFiles: []
                    },
                    confidence: null,
                    scores: {
                        locationAccuracy: question.requiresLocations ? 0 : null,
                        grounding: 0,
                        honestUncertainty: question.type === 'uncertainty' ? 0 : null,
                        flow: question.type === 'flow' ? 0 : null,
                        provenanceAccuracy: 0,
                        stalenessHandling: 0
                    },
                    notes: ['Question failed while running through the query pipeline.'],
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        const architectureRegression = validateArchitectureInvariants(path.resolve(__dirname, '../..'));
        const summary = summarizeResults(results, options.threshold, previous);
        const contractFailure = results.some(result => result.contractValidation && !result.contractValidation.passed) ||
            results.some(result => result.shadowContractValidation && !result.shadowContractValidation.passed);
        if (!architectureRegression.passed || contractFailure) {
            summary.passed = false;
        }
        const completedAt = new Date().toISOString();
        const runId = completedAt;
        const result: EvalRunResult = {
            schemaVersion: '1.0',
            runId,
            startedAt,
            completedAt,
            repoPath: workspaceRoot,
            repoguideDir,
            questionsPath: path.resolve(options.questionsPath),
            questionSetName: questionSet.name,
            datasetVersion: questionSet.schemaVersion,
            targetRepoHint: questionSet.targetRepoHint,
            evaluationMode: mode,
            artifactAvailability: getArtifactAvailability(repoguideDir),
            healthReport,
            results,
            architectureRegression,
            summary,
            previousRun: previous
                ? {
                    runId: previous.runId,
                    overallScore: previous.summary.overallScore,
                    delta: summary.overallScore - previous.summary.overallScore
                }
                : undefined
        };

        const paths = writeEvalReport(result, outputDir);
        writePhase3Reports(result, outputDir);
        
        // Generate manual review pending file if needed
        const pendingManual = results.filter(r => r.scores.grounding === null || r.scores.provenanceAccuracy === null);
        if (pendingManual.length > 0) {
            const manualReviewPath = path.join(outputDir, 'manual_review_pending.md');
            const lines: string[] = [`# Manual Review Required (Run: ${runId})`, `Please score the following questions and use the CLI to commit the results.`, ``];
            for (const r of pendingManual) {
                lines.push(`## Question ID: ${r.id}`);
                lines.push(`**Question**: ${r.question}`);
                lines.push(`**Expected**: ${r.expectedAnswer}`);
                lines.push(`**Actual Output**: ${r.answer || '(empty)'}`);
                lines.push(`**Context Captured**: ${r.capturedContext.retrievedChunkIds.length} chunks, ${r.capturedContext.retrievedArtifacts.length} artifacts, ${r.capturedContext.topCitedFiles.length + r.capturedContext.citedFiles.length} files`);
                lines.push(`**Notes**: ${r.notes.join(' | ')}`);
                lines.push(``);
                if (r.scores.grounding === null) {
                    lines.push(`- [ ] Grounding Score (0, 1, or 2): ___`);
                } else {
                    lines.push(`- [x] Grounding Score: ${r.scores.grounding}`);
                }
                if (r.scores.provenanceAccuracy === null) {
                    lines.push(`- [ ] Provenance Accuracy Score (0, 1, or 2): ___`);
                } else {
                    lines.push(`- [x] Provenance Accuracy Score: ${r.scores.provenanceAccuracy}`);
                }
                lines.push(`---`);
            }
            fs.writeFileSync(manualReviewPath, lines.join('\n'), 'utf8');
            this.outputChannel.appendLine(`[Eval] Generated manual review template at ${manualReviewPath}`);
        }
        
        return { result, ...paths };
    }

    private async prepareRepo(workspaceRoot: string, repoguideDir: string): Promise<void> {
        this.outputChannel.appendLine('[Eval] Preparing repo: building index and comprehension artifacts.');
        const symbolIndex = new SymbolIndex();
        symbolIndex.setLogger(this.outputChannel as any);
        const comprehensionEngine = new ComprehensionEngine(this.outputChannel as any, repoguideDir);
        const runner = new ComprehensionJobRunner(comprehensionEngine, repoguideDir, this.outputChannel);
        await prepareRepository({
            workspaceRoot,
            repoguideDir,
            context: createEvalRepositoryContext(workspaceRoot, repoguideDir, this.outputChannel),
            statusBar: new EvalStatusBar() as any,
            symbolIndex,
            comprehensionEngine,
            comprehensionJobRunner: runner,
            runComprehension: true
        });
    }
}

function createEvalRepositoryContext(workspaceRoot: string, repoguideDir: string, outputChannel: OutputLogger): RepositoryContext {
    const logger: Logger = {
        appendLine: message => outputChannel.appendLine(message),
        debug: message => outputChannel.appendLine(message),
        info: message => outputChannel.appendLine(message),
        warn: message => outputChannel.appendLine(message),
        error: message => outputChannel.appendLine(message),
        stageStart: () => {},
        stageProgress: () => {},
        stageComplete: () => {},
        stageFailed: () => {},
        artifactWritten: artifact => outputChannel.appendLine(`[Eval] Artifact written: ${artifact.artifactName}`),
        queryLog: () => {},
        repairLog: () => {}
    };
    return {
        workspaceRoot,
        repoguideDataDir: repoguideDir,
        getConfig: <T>(_key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: filePath => path.relative(workspaceRoot, filePath),
        logger,
        notifyInfo: async message => outputChannel.appendLine(message),
        notifyWarning: async message => outputChannel.appendLine(message),
        notifyError: async message => outputChannel.appendLine(message)
    };
}

function getArtifactAvailability(repoguideDir: string): ArtifactAvailability {
    const understandingDir = path.join(repoguideDir, 'understanding');
    return {
        vectorIndex: fs.existsSync(path.join(repoguideDir, 'chunks.lance')) || fs.existsSync(path.join(repoguideDir, 'chunks')),
        symbols: fs.existsSync(path.join(repoguideDir, 'symbols.json')),
        manifest: fs.existsSync(path.join(understandingDir, 'manifest.json')),
        project: fs.existsSync(path.join(understandingDir, 'project.json')),
        files: fs.existsSync(path.join(understandingDir, 'files.json')),
        modules: fs.existsSync(path.join(understandingDir, 'modules.json')),
        conceptMap: fs.existsSync(path.join(understandingDir, 'concept_map.json')),
        callGraphV2: fs.existsSync(path.join(understandingDir, 'call_graph_v2.json')),
        behavioralPaths: fs.existsSync(path.join(understandingDir, 'behavioral_paths.json')),
        validationReport: fs.existsSync(path.join(understandingDir, 'validation_report.json'))
    };
}

const consoleOutput: OutputLogger = {
    appendLine(message: string): void {
        console.log(message);
    }
};
