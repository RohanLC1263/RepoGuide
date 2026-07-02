import * as fs from 'fs';
import * as path from 'path';
import { EvidenceItem } from '../query/evidencePacket';
import { EvidenceQueryTelemetrySnapshot } from '../query/evidenceQueryTelemetry';

export interface ValidationViolation {
    component: string;
    message: string;
}

export interface ValidationReport {
    passed: boolean;
    violations: ValidationViolation[];
}

export function validateEvidenceContracts(telemetry: EvidenceQueryTelemetrySnapshot | undefined): ValidationReport {
    const violations: ValidationViolation[] = [];
    if (!telemetry) {
        violations.push({ component: 'QueryDispatcher', message: 'Evidence telemetry was not produced.' });
        return { passed: false, violations };
    }

    if (!telemetry.executionPlan) {
        violations.push({ component: 'ExecutionPlanner', message: 'No ExecutionPlan was recorded.' });
    } else {
        const plan = telemetry.executionPlan;
        if (!plan.planId || !plan.requestId || !plan.query || !plan.category) {
            violations.push({ component: 'ExecutionPlanner', message: 'ExecutionPlan is missing required identity/category fields.' });
        }
        if (!plan.retrievalPlan || !Array.isArray(plan.retrievalPlan.providerIds)) {
            violations.push({ component: 'ExecutionPlanner', message: 'ExecutionPlan is missing a valid RetrievalPlan provider list.' });
        }
        if (!plan.verificationPlan?.requireAnswerGate) {
            violations.push({ component: 'ExecutionPlanner', message: 'ExecutionPlan does not require AnswerGate.' });
        }
    }

    if (!telemetry.retrievalResult) {
        violations.push({ component: 'RetrievalOrchestrator', message: 'No RetrievalOrchestrationResult was recorded.' });
    } else {
        for (const result of telemetry.retrievalResult.providerResults) {
            if (!result.providerId || !result.status || !Array.isArray(result.items) || !result.metadata) {
                violations.push({ component: result.providerId || 'EvidenceProvider', message: 'Provider returned an invalid EvidenceProviderResponse shape.' });
            }
            for (const item of result.items) {
                validateNormalizedEvidenceItem(item, result.providerId, violations);
            }
        }
    }

    if (!telemetry.packet) {
        violations.push({ component: 'EvidencePacketBuilder', message: 'No EvidencePacket was recorded.' });
    }

    if (telemetry.synthesizedAnswer === undefined) {
        violations.push({ component: 'EvidenceAnswerSynthesizer', message: 'No synthesized answer was recorded.' });
    }

    if (!telemetry.answerGate) {
        violations.push({ component: 'AnswerGate', message: 'No AnswerGate result was recorded.' });
    }

    return { passed: violations.length === 0, violations };
}

export function validateArchitectureInvariants(workspaceRoot: string): ValidationReport {
    const violations: ValidationViolation[] = [];
    const read = (relativePath: string) => fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');

    const queryDispatcher = read('src/query/queryDispatcher.ts');
    const planner = read('src/query/executionPlanner.ts');
    const orchestrator = read('src/query/retrievalOrchestrator.ts');
    const packetBuilder = read('src/query/evidencePacketBuilder.ts');
    const synthesizer = read('src/query/evidenceAnswerSynthesizer.ts');
    const mcpServer = read('src/mcp/mcpServer.ts');

    if (!queryDispatcher.includes('runEvidenceQuery') || !queryDispatcher.includes('this.executionPlanner.plan') || !queryDispatcher.includes('this.retrievalOrchestrator.execute')) {
        violations.push({ component: 'QueryDispatcher', message: 'QueryDispatcher no longer owns the canonical evidence orchestration path.' });
    }
    if (/\.search\(|\.retrieve\(|buildPacket\(|synthesize\(/.test(planner)) {
        violations.push({ component: 'ExecutionPlanner', message: 'ExecutionPlanner appears to perform retrieval or synthesis.' });
    }
    if (/synthesize\(|AnswerGate|buildPacket\(/.test(orchestrator)) {
        violations.push({ component: 'RetrievalOrchestrator', message: 'RetrievalOrchestrator appears to perform packet building, synthesis, or answer validation.' });
    }
    if (/RepositoryBrainProvider|FactStoreProvider|LogicalUnitStoreProvider|ProgramGraphProvider|SymbolIndexProvider|HybridRetrievalProvider/.test(packetBuilder)) {
        violations.push({ component: 'EvidencePacketBuilder', message: 'EvidencePacketBuilder contains provider-specific branching.' });
    }
    if (!/synthesize\(packet: EvidencePacket/.test(synthesizer) || /RetrievalOrchestrator|EvidenceProvider|ExecutionPlanner/.test(synthesizer)) {
        violations.push({ component: 'EvidenceAnswerSynthesizer', message: 'EvidenceAnswerSynthesizer does not consume only EvidencePacket or imports upstream retrieval components.' });
    }
    if (!queryDispatcher.includes('this.answerGate.verify(answer, packet)')) {
        violations.push({ component: 'AnswerGate', message: 'AnswerGate is not mandatory in QueryDispatcher evidence mode.' });
    }
    if (!mcpServer.includes('new RetrievalOrchestrator') || !mcpServer.includes('new ExecutionPlanner') || !mcpServer.includes('new QueryDispatcher')) {
        violations.push({ component: 'MCP', message: 'MCP does not appear to use the canonical planner/orchestrator/dispatcher architecture.' });
    }

    return { passed: violations.length === 0, violations };
}

function validateNormalizedEvidenceItem(item: EvidenceItem, providerId: string, violations: ValidationViolation[]): void {
    const candidate = item as any;
    if (candidate.providerId !== providerId) {
        violations.push({ component: providerId, message: `Evidence item ${item.id} is missing the expected provider id.` });
    }
    if (!candidate.evidenceType) {
        violations.push({ component: providerId, message: `Evidence item ${item.id} is missing evidenceType.` });
    }
    if (!candidate.provenance?.providerId) {
        violations.push({ component: providerId, message: `Evidence item ${item.id} is missing provenance.` });
    }
    if (!candidate.canonicalSource?.file) {
        violations.push({ component: providerId, message: `Evidence item ${item.id} is missing a canonical source reference.` });
    }
    if (!candidate.freshness) {
        violations.push({ component: providerId, message: `Evidence item ${item.id} is missing freshness.` });
    }
}
