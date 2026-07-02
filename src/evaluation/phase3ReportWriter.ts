import * as fs from 'fs';
import * as path from 'path';
import { EvalQuestionResult, EvalRunResult } from './types';

export function writePhase3Reports(run: EvalRunResult, outputDir: string): string[] {
    const dir = path.join(outputDir, 'phase3');
    fs.mkdirSync(dir, { recursive: true });
    const reports = [
        ['evidence_evaluation_harness_report.md', renderHarnessReport(run)],
        ['legacy_vs_evidence_comparison_report.md', renderComparisonReport(run)],
        ['planner_telemetry_report.md', renderPlannerReport(run)],
        ['provider_telemetry_report.md', renderProviderReport(run)],
        ['evidence_packet_report.md', renderPacketReport(run)],
        ['answergate_validation_report.md', renderAnswerGateReport(run)],
        ['contract_validation_report.md', renderContractReport(run)],
        ['architecture_regression_report.md', renderArchitectureReport(run)],
        ['evaluation_documentation.md', renderEvaluationDocumentation(run)]
    ] as const;
    const paths: string[] = [];
    for (const [name, body] of reports) {
        const filePath = path.join(dir, name);
        fs.writeFileSync(filePath, body, 'utf8');
        paths.push(filePath);
    }
    return paths;
}

function renderHarnessReport(run: EvalRunResult): string {
    return [
        '# Evidence Evaluation Harness Report',
        '',
        `- Mode: ${run.evaluationMode}`,
        `- Repository: ${run.repoPath}`,
        `- Dataset: ${run.questionSetName}`,
        `- Dataset version: ${run.datasetVersion ?? 'unknown'}`,
        `- Dataset target: ${run.targetRepoHint ?? 'none'}`,
        `- Questions: ${run.results.length}`,
        `- Overall score: ${percent(run.summary.overallScore)}`,
        `- Passed: ${run.summary.passed ? 'yes' : 'no'}`,
        '',
        'Canonical evidence mode executes QueryDispatcher, ExecutionPlanner, RetrievalOrchestrator, EvidenceProviders, EvidencePacketBuilder, EvidenceAnswerSynthesizer, and AnswerGate. Legacy mode remains available through `--mode legacy`; side-by-side comparison is available through `--mode compare`.'
    ].join('\n');
}

function renderComparisonReport(run: EvalRunResult): string {
    const lines = ['# Legacy vs Evidence Comparison Report', ''];
    if (run.evaluationMode !== 'compare') {
        lines.push('This run was not executed in compare mode. Run `npm run eval:mini -- --mode compare` for side-by-side legacy/canonical scores.');
        return lines.join('\n');
    }
    lines.push('| Question | Legacy grounding | Evidence grounding | Legacy telemetry | Evidence telemetry |');
    lines.push('|---|---:|---:|---|---|');
    for (const result of run.results) {
        lines.push(`| ${result.id} | ${formatScore(result.scores.grounding)} | ${formatScore(result.shadowScores?.grounding ?? null)} | ${result.telemetry ? 'yes' : 'no'} | ${result.shadowTelemetry ? 'yes' : 'no'} |`);
    }
    return lines.join('\n');
}

function renderPlannerReport(run: EvalRunResult): string {
    const lines = ['# Planner Telemetry Report', '', '| Question | Planner | Category | Strategy | Complexity | Retrieval | Providers | Confidence | Freshness | Verification |', '|---|---|---|---|---|---|---|---|---|---|'];
    for (const result of run.results) {
        const telemetry = evidenceTelemetry(run, result);
        const plan = telemetry?.executionPlan;
        lines.push(`| ${result.id} | ${plan?.metadata.planner ?? 'n/a'} | ${plan?.category ?? 'n/a'} | ${plan?.strategy.name ?? 'n/a'} | ${plan ? `${plan.complexity.classification}:${plan.complexity.score}` : 'n/a'} | ${plan?.retrievalPlan.strategy ?? 'n/a'} | ${plan?.retrievalPlan.providerIds.join(', ') ?? 'n/a'} | ${plan?.confidencePolicy.mode ?? 'n/a'} | ${plan?.freshnessPolicy.requireFreshEvidence ?? 'n/a'} | ${plan?.verificationPlan.requireAnswerGate ?? 'n/a'} |`);
    }
    return lines.join('\n');
}

function renderProviderReport(run: EvalRunResult): string {
    const lines = ['# Provider Telemetry Report', '', '| Question | Provider | Status | Items | Latency ms | Diagnostics |', '|---|---|---:|---:|---:|---|'];
    for (const result of run.results) {
        const telemetry = evidenceTelemetry(run, result);
        const providerResults = telemetry?.retrievalResult?.providerResults ?? [];
        if (providerResults.length === 0) {
            lines.push(`| ${result.id} | none | n/a | 0 | 0 | no provider telemetry |`);
        }
        for (const provider of providerResults) {
            lines.push(`| ${result.id} | ${provider.providerId} | ${provider.status} | ${provider.items.length} | ${Math.round(provider.metadata.latencyMs)} | ${provider.diagnostics.map(d => d.message).join('; ')} |`);
        }
    }
    return lines.join('\n');
}

function renderPacketReport(run: EvalRunResult): string {
    const lines = ['# EvidencePacket Report', '', '| Question | Items | Facts | By provider | By type | Coverage | Gaps |', '|---|---:|---:|---|---|---:|---|'];
    for (const result of run.results) {
        const telemetry = evidenceTelemetry(run, result);
        const packet = telemetry?.packet;
        lines.push(`| ${result.id} | ${packet?.items.length ?? 0} | ${packet?.facts.length ?? 0} | ${summarizeBy(packet?.items ?? [], 'providerId')} | ${summarizeBy(packet?.items ?? [], 'type')} | ${packet?.coverageScore ?? 0} | ${(packet?.gaps ?? []).join('; ') || 'none'} |`);
    }
    return lines.join('\n');
}

function renderAnswerGateReport(run: EvalRunResult): string {
    const lines = ['# AnswerGate Validation Report', '', '| Question | Verdict | Supported | Unsupported | Required gaps | Diagnostics |', '|---|---|---:|---:|---|---|'];
    for (const result of run.results) {
        const telemetry = evidenceTelemetry(run, result);
        const gate = telemetry?.answerGate;
        lines.push(`| ${result.id} | ${gate?.outcome ?? 'n/a'} | ${gate?.supported_claims.length ?? 0} | ${gate?.unsupported_claims.length ?? 0} | ${(gate?.required_gaps ?? []).join('; ') || 'none'} | ${(gate?.diagnostics ?? []).join('; ') || 'none'} |`);
    }
    return lines.join('\n');
}

function renderContractReport(run: EvalRunResult): string {
    const lines = ['# Contract Validation Report', ''];
    for (const result of run.results) {
        const validation = run.evaluationMode === 'compare'
            ? result.shadowContractValidation
            : result.contractValidation;
        lines.push(`## ${result.id}`);
        lines.push(`- Passed: ${validation?.passed ?? 'n/a'}`);
        for (const violation of validation?.violations ?? []) {
            lines.push(`- ${violation.component}: ${violation.message}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

function renderArchitectureReport(run: EvalRunResult): string {
    const lines = ['# Architecture Regression Report', '', `- Passed: ${run.architectureRegression.passed}`];
    for (const violation of run.architectureRegression.violations) {
        lines.push(`- ${violation.component}: ${violation.message}`);
    }
    return lines.join('\n');
}

function renderEvaluationDocumentation(run: EvalRunResult): string {
    return [
        '# Updated Evaluation Documentation',
        '',
        'Default evaluation mode is canonical evidence mode.',
        '',
        '- Canonical: `npm run eval:mini` or `npm run eval:mini -- --mode evidence`',
        '- Compatibility: `npm run eval:mini -- --mode legacy`',
        '- Side-by-side: `npm run eval:mini -- --mode compare`',
        '',
        'If `--repo` is omitted, the CLI resolves the selected golden question set `targetRepoHint`. This prevents mixed datasets from silently evaluating the wrong repository.',
        '',
        `Last documented run mode: ${run.evaluationMode}`,
        `Last documented dataset: ${run.questionSetName}`,
        `Last documented repository: ${run.repoPath}`
    ].join('\n');
}

function summarizeBy(items: any[], key: string): string {
    const counts = new Map<string, number>();
    for (const item of items) {
        const value = String(item[key] ?? 'unknown');
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
}


function evidenceTelemetry(run: EvalRunResult, result: EvalQuestionResult) {
    return run.evaluationMode === 'compare'
        ? result.shadowTelemetry
        : result.telemetry;
}
function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function formatScore(value: number | null): string {
    return value === null ? 'n/a' : String(value);
}
