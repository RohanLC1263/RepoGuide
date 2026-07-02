import * as moduleObj from 'module';
import * as path from 'path';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined })
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) })
        }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') return shim;
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();
import { craftConnectGoldenCases } from './craftConnectGolden';
import { secondRepoGoldenCases } from './secondRepoGolden';
import { scoreEvidencePacket, scoreAnswerGate } from './evidenceScorers';
import { EvidenceReportWriter } from './evidenceReportWriter';
import { EvidenceEvalReport, EvidenceGateResults } from './evidenceGoldenTypes';
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { buildEvidencePlan } from '../query/evidencePlanner';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';
import { walkFiles } from '../indexing/fileWalker';
import { extractLogicalUnitsFromFile } from '../indexing/logicalUnitExtractor';
import { extractFacts } from '../indexing/factExtractor';
import { EvidenceAnswerSynthesizer } from '../query/evidenceAnswerSynthesizer';
import { AnswerGate } from '../query/answerGate';
import { ProgramGraphStore } from '../store/programGraphStore';
import { MentorOrchestrator } from '../mentor/mentorOrchestrator';
import { queryTypeToCapability } from '../query/capabilityMapper';
import { Logger, RepositoryContext } from '../context/repositoryContext';

export async function runEval() {
    const args = process.argv.slice(2);
    const reuseIndex = args.includes('--reuse-index');
    
    // Choose mode
    const repoArgIndex = args.findIndex(a => a.startsWith('--repo=') || a === '--repo');
    const repoPath = repoArgIndex !== -1
        ? (args[repoArgIndex].startsWith('--repo=') ? args[repoArgIndex].slice(7) : args[repoArgIndex + 1])
        : process.env.REPO_PATH ?? '';
    if (!repoPath) { console.error('Error: --repo <path> is required.'); process.exit(1); }
    const suiteArg = args.find(a => a.startsWith('--suite=') || a === '--suite');
    const suite = suiteArg
        ? (suiteArg.startsWith('--suite=') ? suiteArg.slice(8) : args[args.indexOf(suiteArg) + 1])
        : 'craftconnect';
    const goldenCases = suite === 'secondrepo' ? secondRepoGoldenCases : craftConnectGoldenCases;
    const repoName = require('path').basename(repoPath);
    
    console.log(`Starting Evidence Evaluation for ${repoName}...`);
    
    const dbDir = path.join(repoPath, '.repoguide');
    const unitStore = new LogicalUnitStore(dbDir);
    const factStore = new FactStore(dbDir);
    const bm25Store = new Bm25Store(dbDir);
    const lanceStore = new LanceStore(dbDir);
    const programGraphStore = new ProgramGraphStore();

    await unitStore.init(repoPath);
    await factStore.init(repoPath);
    await bm25Store.init();
    await lanceStore.init();

    if (!reuseIndex) {
        console.log(`Building full index for ${repoPath}...`);
        await unitStore.clearAll();
        await factStore.clearAll();
        await bm25Store.clearAll();
        
        const filePaths = await walkFiles(repoPath);
        console.log(`Found ${filePaths.length} files to index.`);
        let unitsExtracted = 0;
        let factsExtracted = 0;
        
        for (const fp of filePaths) {
            try {
                const units = await extractLogicalUnitsFromFile(fp, repoPath);
                if (units.length > 0) {
                    await unitStore.upsertUnits(units);
                    const chunks = units.map(u => ({
                        id: u.id,
                        filePath: u.filePath,
                        text: u.content,
                        language: 'unknown',
                        startLine: u.startLine,
                        endLine: u.endLine,
                        vector: [],
                        hash: u.id
                    }));
                    if (chunks.length > 0) {
                        await bm25Store.insertChunks(chunks);
                    }
                    unitsExtracted += units.length;
                    
                    const fileFacts: import('../indexing/factTypes').FactRecord[] = [];
                    for (const unit of units) {
                        const facts = extractFacts(unit);
                        fileFacts.push(...facts);
                    }
                    if (fileFacts.length > 0) {
                        await factStore.upsertFacts(fileFacts);
                        factsExtracted += fileFacts.length;
                    }
                }
            } catch (e) {
                console.error(`Failed to index ${fp}:`, e);
            }
        }
        console.log(`Index build complete: ${unitsExtracted} units, ${factsExtracted} facts.`);
        
        console.log(`Building program graph...`);
        await programGraphStore.build(unitStore, factStore, repoPath);
        const stats = programGraphStore.getStats();
        console.log(`Program graph built: ${stats?.nodeCount || 0} nodes, ${stats?.edgeCount || 0} edges.`);
    } else {
        console.log(`Reusing existing index...`);
        await programGraphStore.load(repoPath);
        const stats = programGraphStore.getStats();
        console.log(`Program graph loaded: ${stats?.nodeCount || 0} nodes, ${stats?.edgeCount || 0} edges.`);
    }

    const luBm25Store = new LogicalUnitBm25Store(dbDir);
    await luBm25Store.init();
    if (!reuseIndex) {
        await luBm25Store.clearAll();
        const allUnits = await unitStore.getAll();
        await luBm25Store.indexUnits(allUnits);
    }

    const builder = new EvidencePacketBuilder({
        unitStore, factStore, bm25Store: luBm25Store, programGraphStore
    });
    const mockLogger: Logger = {
        appendLine: console.log,
        debug: console.log,
        info: console.log,
        warn: console.log,
        error: console.error,
        stageStart: () => {},
        stageProgress: () => {},
        stageComplete: () => {},
        stageFailed: () => {},
        artifactWritten: () => {},
        queryLog: () => {},
        repairLog: () => {}
    };

    const mockContext: RepositoryContext = {
        workspaceRoot: repoPath,
        repoguideDataDir: dbDir,
        getConfig: <T>(key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: (p: string) => path.relative(repoPath, p),
        logger: mockLogger,
        notifyInfo: async () => {},
        notifyWarning: async () => {},
        notifyError: async () => {}
    };

    const synthesizer = new EvidenceAnswerSynthesizer(mockContext);
    const answerGate = new AnswerGate();
    const mentorOrchestrator = new MentorOrchestrator();

    const results: EvidenceGateResults[] = [];
    let passedGate1 = 0;
    let passedGate2 = 0;
    let failedLeaks = 0;
    let passedAnswerGate = 0;
    
    let sumPrecision = 0;
    let sumRecall = 0;
    let sumCoverage = 0;
    let sumConstantExp = 0;
    let sumUnsupportedClaim = 0;
    let sumNumericAccuracy = 0;

    let totalMentorTests = 0;
    let totalRoutingTests = 0;
    let passedMentorRouting = 0;
    let passedMentorRecommendation = 0;
    let totalNoMentorTests = 0;
    let passedNoMentor = 0;

    for (const testCase of goldenCases) {
        console.log(`Evaluating case: ${testCase.id} - ${testCase.description}`);
        const plan = buildEvidencePlan(testCase.query);
        const packet = await builder.buildPacket(testCase.query, plan);
        
        let result = scoreEvidencePacket(testCase, packet);
        
        const answer = await synthesizer.synthesize(packet, 'qwen2.5-coder:7b'); // Mock model parameter
        const gateResult = answerGate.verify(answer, packet);
        
        result = scoreAnswerGate(gateResult, result, testCase);
        
        if (testCase.expectedMentorResult) {
            result.mentorEvaluated = true;
            
            const expected = testCase.expectedMentorResult;
            result.expectedCapability = expected.expectedCapability;
            
            const detectedCap = queryTypeToCapability(packet.plan.queryType);
            const actualCapability: string = detectedCap;
            result.actualCapability = actualCapability;
            
            let mentorContext = null;
            if (actualCapability !== 'None') {
                mentorContext = mentorOrchestrator.run(packet, gateResult);
            }
            
            result.expectedRecommendationType = expected.expectedRecommendationType;
            result.actualRecommendationType = mentorContext?.recommendation?.type;
            
            if (expected.expectedCapability === 'None') {
                totalNoMentorTests++;
                if (actualCapability !== 'None') {
                    result.mentorPass = false;
                    result.mentorFailureType = 'routing';
                    result.mentorFailureReason = `Unexpected mentor: got ${actualCapability}`;
                } else {
                    passedNoMentor++;
                }
            } else {
                totalMentorTests++;
                totalRoutingTests++;
                
                // Layer 1: Routing Validation
                if (actualCapability === 'None') {
                    result.mentorPass = false;
                    result.mentorFailureType = 'routing';
                    result.mentorFailureReason = `Missing mentor: expected ${expected.expectedCapability}, got None`;
                } else if (actualCapability !== expected.expectedCapability) {
                    result.mentorPass = false;
                    result.mentorFailureType = 'routing';
                    result.mentorFailureReason = `Wrong mentor: expected ${expected.expectedCapability}, got ${actualCapability}`;
                } else {
                    passedMentorRouting++;
                    
                    // Layer 2: Recommendation Validation
                    if (!mentorContext) {
                        result.mentorPass = false;
                        result.mentorFailureType = 'recommendation';
                        result.mentorFailureReason = `Failed to generate recommendation for ${actualCapability}`;
                    } else {
                        let recFail = false;
                        if (expected.expectedRecommendationType && mentorContext.recommendation.type !== expected.expectedRecommendationType) {
                            result.mentorFailureReason = `Wrong recommendation type: expected ${expected.expectedRecommendationType}, got ${mentorContext.recommendation.type}`;
                            recFail = true;
                        }
                    
                        if (!recFail && expected.requiredFields) {
                        for (const field of expected.requiredFields) {
                            const val = (mentorContext.recommendation as any)[field];
                            if (val === undefined || (Array.isArray(val) && val.length === 0)) {
                                result.mentorFailureReason = `Missing or empty required field: ${field}`;
                                recFail = true;
                                break;
                            }
                        }
                    }
                    
                    if (!recFail && expected.requiredReasoningKeywords) {
                        const reasoningStr = mentorContext.reasoningFactors.join(' ').toLowerCase();
                        for (const kw of expected.requiredReasoningKeywords) {
                            if (!reasoningStr.includes(kw.toLowerCase())) {
                                result.mentorFailureReason = `Missing reasoning keyword: ${kw}`;
                                recFail = true;
                                break;
                            }
                        }
                    }
                    
                    if (recFail) {
                        result.mentorPass = false;
                        result.mentorFailureType = 'recommendation';
                    } else {
                        passedMentorRecommendation++;
                    }
                } // closes else (!mentorContext)
            } // closes else (Layer 1)
        } // closes else (expectedCapability === 'None')
        
        if (!result.mentorPass) {
                console.log(`  ❌ Mentor Eval Failed (${result.mentorFailureType}): ${result.mentorFailureReason}`);
                result.diagnostics.push(`Mentor Eval Failed (${result.mentorFailureType}): ${result.mentorFailureReason}`);
            }
        }
        
        results.push(result);

        if (result.gate1SpanPassed) passedGate1++;
        if (result.gate2FactPassed) passedGate2++;
        if (result.testLeak) failedLeaks++;
        if (result.answerGatePass) passedAnswerGate++;
        
        sumPrecision += result.evidencePrecisionAtK;
        sumRecall += result.evidenceRecallAtK;
        sumCoverage += result.requiredEvidenceCoverage;
        sumConstantExp += result.constantExpansionFired ? 1 : 0;
        sumUnsupportedClaim += result.unsupportedClaimRate;
        sumNumericAccuracy += result.numericAccuracy;
        
        for (const d of result.diagnostics) {
            console.log(`  [Diagnostic] ${d}`);
        }
    }

    const total = goldenCases.length;
    const gate1Score = passedGate1 / total;
    const gate2Score = passedGate2 / total;
    const leakRate = failedLeaks / total;
    const answerGatePassRate = passedAnswerGate / total;

    const report: EvidenceEvalReport = {
        timestamp: new Date().toISOString(),
        gate1Score,
        gate2Score,
        testLeakRate: leakRate,
        answerGatePassRate,
        avgPrecisionAtK: sumPrecision / total,
        avgRecallAtK: sumRecall / total,
        avgRequiredCoverage: sumCoverage / total,
        constantExpansionRate: sumConstantExp / total,
        avgUnsupportedClaimRate: sumUnsupportedClaim / total,
        avgNumericAccuracy: sumNumericAccuracy / total,
        totalCases: total,
        results,
        totalMentorTests,
        totalRoutingTests,
        mentorRoutingPassRate: totalRoutingTests > 0 ? passedMentorRouting / totalRoutingTests : 0,
        mentorRecommendationPassRate: totalRoutingTests > 0 ? passedMentorRecommendation / totalRoutingTests : 0, // Simplified to base on routing tests
        totalNoMentorTests,
        noMentorPassRate: totalNoMentorTests > 0 ? passedNoMentor / totalNoMentorTests : 0
    };

    const writer = new EvidenceReportWriter(path.join(process.cwd(), 'reports', 'evidence_eval'));
    await writer.writeReport(report);

    let exitCode = 0;
    if (gate1Score < 0.8) {
        console.error(`❌ Gate 1 Score (${(gate1Score*100).toFixed(1)}%) is below required 80%`);
        exitCode = 1;
    }
    if (gate2Score < 0.7) {
        console.error(`❌ Gate 2 Score (${(gate2Score*100).toFixed(1)}%) is below required 70%`);
        exitCode = 1;
    }
    if (leakRate > 0) {
        console.error(`❌ Test Leak Rate (${(leakRate*100).toFixed(1)}%) is above required 0%`);
        exitCode = 1;
    }
    if (answerGatePassRate < 0.8) {
        console.error(`❌ Answer Gate Pass Rate (${(answerGatePassRate*100).toFixed(1)}%) is below required 80%`);
        // We might not want to fail the CI just yet for answer gate until prompt is perfected, but let's be strict for the harness
        exitCode = 1;
    }

    if (exitCode === 0) {
        console.log(`✅ All evaluation gates passed!`);
    }

    // Export a flag or just exit
    if (require.main === module) {
        process.exit(exitCode);
    }
    
    return report;
}

runEval().catch(err => {
    console.error('Eval failed unexpectedly:', err);
    process.exit(1);
});
