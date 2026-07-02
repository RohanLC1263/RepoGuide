import * as fs from 'fs';
import * as path from 'path';
import {
    EvalQuestionResult,
    EvalRunResult,
    EvalRunSummary,
    EvalScores
} from './types';

export function summarizeResults(
    results: EvalQuestionResult[],
    threshold: number,
    previousRun: EvalRunResult | null
): EvalRunSummary {
    const byType: EvalRunSummary['byType'] = {};
    for (const result of results) {
        const bucket = byType[result.type] ?? {
            count: 0,
            avgLocationAccuracy: null,
            avgGrounding: null,
            avgHonestUncertainty: null,
            avgFlow: null,
            avgProvenanceAccuracy: null,
            avgStalenessHandling: null,
            composite: 0
        };
        bucket.count += 1;
        byType[result.type] = bucket;
    }

    for (const [type, bucket] of Object.entries(byType)) {
        const typeResults = results.filter(result => result.type === type);
        bucket.avgLocationAccuracy = avgNullable(typeResults.map(result => result.scores.locationAccuracy));
        bucket.avgGrounding = avgNullable(typeResults.map(result => result.scores.grounding === null ? null : result.scores.grounding / 2));
        bucket.avgHonestUncertainty = avgNullable(typeResults.map(result => result.scores.honestUncertainty));
        bucket.avgFlow = avgNullable(typeResults.map(result => result.scores.flow === null ? null : result.scores.flow / 2));
        bucket.avgProvenanceAccuracy = avgNullable(typeResults.map(result => result.scores.provenanceAccuracy === null ? null : result.scores.provenanceAccuracy / 2));
        bucket.avgStalenessHandling = avgNullable(typeResults.map(result => result.scores.stalenessHandling));
        bucket.composite = avg(typeResults.map(result => compositeScore(result.scores)));

        if (typeResults.some(r => r.shadowScores)) {
            bucket.avgShadowLocationAccuracy = avgNullable(typeResults.map(result => result.shadowScores?.locationAccuracy ?? null));
            bucket.avgShadowGrounding = avgNullable(typeResults.map(result => result.shadowScores?.grounding === null || result.shadowScores?.grounding === undefined ? null : result.shadowScores.grounding / 2));
            bucket.avgShadowHonestUncertainty = avgNullable(typeResults.map(result => result.shadowScores?.honestUncertainty ?? null));
            bucket.avgShadowFlow = avgNullable(typeResults.map(result => result.shadowScores?.flow === null || result.shadowScores?.flow === undefined ? null : result.shadowScores.flow / 2));
            bucket.avgShadowProvenanceAccuracy = avgNullable(typeResults.map(result => result.shadowScores?.provenanceAccuracy === null || result.shadowScores?.provenanceAccuracy === undefined ? null : result.shadowScores.provenanceAccuracy / 2));
            bucket.avgShadowStalenessHandling = avgNullable(typeResults.map(result => result.shadowScores?.stalenessHandling ?? null));
            bucket.shadowComposite = avgNullable(typeResults.map(result => result.shadowScores ? compositeScore(result.shadowScores) : null)) ?? undefined;
        }
    }

    const overallScore = avg(results.map(result => compositeScore(result.scores)));
    const weakQuestionTypes = Object.entries(byType)
        .filter(([, bucket]) => bucket.composite <= 0.25)
        .map(([type, bucket]) => ({
            type,
            composite: bucket.composite,
            likelyCause: likelyCauseForType(type)
        }));

    const regressions: EvalRunSummary['regressions'] = [];
    if (previousRun) {
        // Compare overall average
        if (overallScore < previousRun.summary.overallScore) {
            regressions.push({ dimension: 'Overall Score', previousScore: previousRun.summary.overallScore, currentScore: overallScore });
        }
        
        // Compare per-type composites
        for (const [type, bucket] of Object.entries(byType)) {
            const prevBucket = previousRun.summary.byType[type];
            if (prevBucket && bucket.composite < prevBucket.composite) {
                regressions.push({ dimension: `Composite (${type})`, previousScore: prevBucket.composite, currentScore: bucket.composite });
            }
        }
        
        // Let's compute global averages per dimension to compare
        const getGlobalAvg = (run: EvalRunResult, extractor: (s: EvalScores) => number | null) => avgNullable(run.results.map(r => extractor(r.scores)));
        const dims = [
            { name: 'Location Accuracy', ext: (s: EvalScores) => s.locationAccuracy },
            { name: 'Grounding', ext: (s: EvalScores) => s.grounding === null ? null : s.grounding / 2 },
            { name: 'Honest Uncertainty', ext: (s: EvalScores) => s.honestUncertainty },
            { name: 'Flow', ext: (s: EvalScores) => s.flow === null ? null : s.flow / 2 },
            { name: 'Provenance', ext: (s: EvalScores) => s.provenanceAccuracy === null ? null : s.provenanceAccuracy / 2 },
            { name: 'Staleness', ext: (s: EvalScores) => s.stalenessHandling }
        ];
        
        for (const dim of dims) {
            const currentAvg = avgNullable(results.map(r => dim.ext(r.scores)));
            const prevAvg = getGlobalAvg(previousRun, dim.ext);
            if (currentAvg !== null && prevAvg !== null && currentAvg < prevAvg) {
                regressions.push({ dimension: dim.name, previousScore: prevAvg, currentScore: currentAvg });
            }
        }
    }

    return {
        totalQuestions: results.length,
        threshold,
        overallScore,
        passed: overallScore >= threshold,
        byType,
        weakQuestionTypes,
        regressions
    };
}

export function writeEvalReport(run: EvalRunResult, outputDir: string): { jsonPath: string; markdownPath: string; latestPath: string } {
    const runsDir = path.join(outputDir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const safeRunId = run.runId.replace(/[:.]/g, '-');
    const jsonPath = path.join(runsDir, `${safeRunId}.json`);
    const markdownPath = path.join(runsDir, `${safeRunId}.md`);
    const latestPath = path.join(outputDir, 'latest.json');

    fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2), 'utf8');
    fs.writeFileSync(markdownPath, renderMarkdown(run), 'utf8');
    fs.writeFileSync(latestPath, JSON.stringify(run, null, 2), 'utf8');

    return { jsonPath, markdownPath, latestPath };
}

export function loadPreviousRun(outputDir: string): EvalRunResult | null {
    const latestPath = path.join(outputDir, 'latest.json');
    if (!fs.existsSync(latestPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(latestPath, 'utf8')) as EvalRunResult;
    } catch {
        return null;
    }
}

function renderMarkdown(run: EvalRunResult): string {
    const lines: string[] = [];
    lines.push(`# RepoGuide Mini Evaluation: ${run.questionSetName}`);
    lines.push('');
    lines.push(`- Run: ${run.runId}`);
    lines.push(`- Repo: ${run.repoPath}`);
    lines.push(`- Overall: ${percent(run.summary.overallScore)} (${run.summary.passed ? 'PASS' : 'FAIL'}, threshold ${percent(run.summary.threshold)})`);
    if (run.previousRun) {
        lines.push(`- Previous delta: ${formatDelta(run.previousRun.delta)}`);
    }
    lines.push('');
    lines.push('## Contract Validation');
    const contractFailures = run.results.flatMap(result => {
        const validation = result.contractValidation;
        return validation?.violations.map(v => ({ id: result.id, ...v })) ?? [];
    });
    if (contractFailures.length === 0) {
        lines.push('- Runtime evidence contracts: PASS');
    } else {
        lines.push('- Runtime evidence contracts: FAIL');
        for (const failure of contractFailures) {
            lines.push('- ' + failure.id + ': ' + failure.component + ' - ' + failure.message);
        }
    }
    lines.push('');
    lines.push('## Architecture Regression');
    lines.push('- Invariants: ' + (run.architectureRegression.passed ? 'PASS' : 'FAIL'));
    for (const violation of run.architectureRegression.violations) {
        lines.push('- ' + violation.component + ': ' + violation.message);
    }
    lines.push('');
    lines.push('## Artifact Availability');
    for (const [name, available] of Object.entries(run.artifactAvailability)) {
        lines.push(`- ${name}: ${available ? 'present' : 'missing'}`);
    }
    lines.push('');
    lines.push('## Aggregate By Type');
    const isShadow = Object.values(run.summary.byType).some(b => b.shadowComposite !== undefined);
    if (isShadow) {
        lines.push('| Type | Count | Comp(Main/Shd) | Loc(Main/Shd) | Grnd(Main/Shd) | Unc(Main/Shd) | Flow(Main/Shd) | Prov(Main/Shd) | Stale(Main/Shd) |');
        lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
        for (const [type, bucket] of Object.entries(run.summary.byType)) {
            lines.push(`| ${type} | ${bucket.count} | ${percent(bucket.composite)} / ${bucket.shadowComposite !== undefined ? percent(bucket.shadowComposite) : '-'} | ${formatMaybe(bucket.avgLocationAccuracy)} / ${formatMaybe(bucket.avgShadowLocationAccuracy ?? null)} | ${formatMaybe(bucket.avgGrounding)} / ${formatMaybe(bucket.avgShadowGrounding ?? null)} | ${formatMaybe(bucket.avgHonestUncertainty)} / ${formatMaybe(bucket.avgShadowHonestUncertainty ?? null)} | ${formatMaybe(bucket.avgFlow)} / ${formatMaybe(bucket.avgShadowFlow ?? null)} | ${formatMaybe(bucket.avgProvenanceAccuracy)} / ${formatMaybe(bucket.avgShadowProvenanceAccuracy ?? null)} | ${formatMaybe(bucket.avgStalenessHandling)} / ${formatMaybe(bucket.avgShadowStalenessHandling ?? null)} |`);
        }
    } else {
        lines.push('| Type | Count | Composite | Location | Grounding | Uncertainty | Flow | Provenance | Staleness |');
        lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
        for (const [type, bucket] of Object.entries(run.summary.byType)) {
            lines.push(`| ${type} | ${bucket.count} | ${percent(bucket.composite)} | ${formatMaybe(bucket.avgLocationAccuracy)} | ${formatMaybe(bucket.avgGrounding)} | ${formatMaybe(bucket.avgHonestUncertainty)} | ${formatMaybe(bucket.avgFlow)} | ${formatMaybe(bucket.avgProvenanceAccuracy)} | ${formatMaybe(bucket.avgStalenessHandling)} |`);
        }
    }
    lines.push('');

    if (run.summary.regressions.length > 0) {
        lines.push('## 🚨 Regressions Detected');
        for (const reg of run.summary.regressions) {
            lines.push(`- **${reg.dimension}**: regressed from ${percent(reg.previousScore)} to ${percent(reg.currentScore)}`);
        }
        lines.push('');
    }

    // V1 Criteria Check
    const extAvg = (extractor: (s: EvalScores) => number | null) => avgNullable(run.results.map(r => extractor(r.scores)));
    const locAvg = extAvg(s => s.locationAccuracy);
    const grndAvg = extAvg(s => s.grounding === null ? null : s.grounding / 2);
    const flowAvg = extAvg(s => s.flow === null ? null : s.flow / 2);
    const uncAvg = extAvg(s => s.honestUncertainty);
    const provAvg = extAvg(s => s.provenanceAccuracy === null ? null : s.provenanceAccuracy / 2);
    
    const criteria = {
        loc: locAvg !== null && locAvg > 0.80,
        grnd: grndAvg !== null && grndAvg > 0.75, // > 1.5/2
        flow: flowAvg !== null && flowAvg > 0.75, // > 1.5/2
        unc: uncAvg !== null && uncAvg > 0.90,
        prov: provAvg !== null && provAvg > 0.75, // > 1.5/2
        noRegressions: run.summary.regressions.length === 0
    };
    const v1Passed = Object.values(criteria).every(v => v);
    
    lines.push('## V1 Completion Criteria');
    lines.push(`- Location accuracy > 80%: ${criteria.loc ? '✅' : '❌'} (${formatMaybe(locAvg)})`);
    lines.push(`- Answer grounding > 1.5/2: ${criteria.grnd ? '✅' : '❌'} (${formatMaybe(grndAvg)})`);
    lines.push(`- Flow correctness > 1.5/2: ${criteria.flow ? '✅' : '❌'} (${formatMaybe(flowAvg)})`);
    lines.push(`- Honest uncertainty > 90%: ${criteria.unc ? '✅' : '❌'} (${formatMaybe(uncAvg)})`);
    lines.push(`- Provenance accuracy > 1.5/2: ${criteria.prov ? '✅' : '❌'} (${formatMaybe(provAvg)})`);
    lines.push(`- No regressions: ${criteria.noRegressions ? '✅' : '❌'}`);
    if (v1Passed) {
        lines.push('');
        lines.push('**✅ Core Understanding v1 criteria met.**');
    }
    lines.push('');

    if (run.summary.weakQuestionTypes.length > 0) {
        lines.push('## Weak Areas');
        for (const weak of run.summary.weakQuestionTypes) {
            lines.push(`- ${weak.type}: ${percent(weak.composite)}. Likely cause: ${weak.likelyCause}`);
        }
        lines.push('');
    }

    lines.push('## Per Question');
    for (const result of run.results) {
        lines.push(`### ${result.id} (${result.type})`);
        lines.push('');
        lines.push(`Question: ${result.question}`);
        lines.push('');
        lines.push(`Scores: location=${formatScore(result.scores.locationAccuracy)}, grounding=${result.scores.grounding}/2, uncertainty=${formatScore(result.scores.honestUncertainty)}, flow=${formatFlow(result.scores.flow)}`);
        if (result.notes.length > 0) {
            lines.push('');
            lines.push('Notes:');
            for (const note of result.notes) {
                lines.push(`- ${note}`);
            }
        }
        if (result.telemetry) {
            const plan = result.telemetry.executionPlan;
            const retrieval = result.telemetry.retrievalResult;
            lines.push('');
            lines.push('Telemetry:');
            lines.push('- Planner: ' + (plan?.metadata.planner ?? 'n/a') + '; category=' + (plan?.category ?? 'n/a') + '; strategy=' + (plan?.strategy.name ?? 'n/a') + '; retrieval=' + (plan?.retrievalPlan.strategy ?? 'n/a'));
            lines.push('- Providers invoked: ' + (retrieval?.metadata.providersInvoked.join(', ') || 'none'));
            lines.push('- Providers skipped: ' + (retrieval?.metadata.providersSkipped.join(', ') || 'none'));
            lines.push('- Evidence items: ' + (result.telemetry.packet?.items.length ?? 0) + '; facts=' + (result.telemetry.packet?.facts.length ?? 0) + '; coverage=' + (result.telemetry.packet?.coverageScore ?? 0));
            lines.push('- AnswerGate: ' + (result.telemetry.answerGate?.outcome ?? 'n/a') + '; unsupported=' + (result.telemetry.answerGate?.unsupported_claims.length ?? 0));
            lines.push('- Latency ms: total=' + Math.round(result.telemetry.timings.totalMs ?? 0) + ', planning=' + Math.round(result.telemetry.timings.planningMs ?? 0) + ', retrieval=' + Math.round(result.telemetry.timings.retrievalMs ?? 0) + ', packet=' + Math.round(result.telemetry.timings.packetMs ?? 0) + ', synthesis=' + Math.round(result.telemetry.timings.synthesisMs ?? 0) + ', gate=' + Math.round(result.telemetry.timings.answerGateMs ?? 0));
        }
        if (result.error) {
            lines.push('');
            lines.push(`Error: ${result.error}`);
        }
        lines.push('');
        lines.push('Expected:');
        lines.push('');
        lines.push(result.expectedAnswer);
        lines.push('');
        lines.push('Actual:');
        lines.push('');
        lines.push(result.answer || '(empty answer)');
        lines.push('');
    }
    return lines.join('\n');
}


function evidenceTelemetry(run: EvalRunResult, result: EvalQuestionResult) {
    return result.telemetry;
}
function compositeScore(scores: EvalScores): number {
    const values: number[] = [];
    if (scores.grounding !== null) values.push(scores.grounding / 2);
    if (scores.locationAccuracy !== null) values.push(scores.locationAccuracy);
    if (scores.honestUncertainty !== null) values.push(scores.honestUncertainty);
    if (scores.flow !== null) values.push(scores.flow / 2);
    if (scores.provenanceAccuracy !== null) values.push(scores.provenanceAccuracy / 2);
    if (scores.stalenessHandling !== null) values.push(scores.stalenessHandling);
    
    return avg(values);
}

function avg(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function avgNullable(values: Array<number | null>): number | null {
    const concrete = values.filter((value): value is number => value !== null);
    return concrete.length > 0 ? avg(concrete) : null;
}

function likelyCauseForType(type: string): string {
    switch (type) {
        case 'flow':
            return 'Flow extractor, call graph, or behavioral path artifacts are missing/incomplete.';
        case 'location':
            return 'Symbol/navigation retrieval did not surface expected files.';
        case 'uncertainty':
            return 'The answer did not admit missing evidence clearly enough.';
        default:
            return 'Retrieved evidence was missing, weak, or not reflected in the answer.';
    }
}

function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function formatMaybe(value: number | null): string {
    return value === null ? 'n/a' : percent(value);
}

function formatScore(value: 0 | 1 | null): string {
    return value === null ? 'n/a' : String(value);
}

function formatFlow(value: 0 | 1 | 2 | null): string {
    return value === null ? 'n/a' : `${value}/2`;
}

function formatDelta(value: number): string {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${percent(value)}`;
}
