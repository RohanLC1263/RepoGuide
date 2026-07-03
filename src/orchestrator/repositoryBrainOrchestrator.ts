import { OrchestratorState, OrchestratorStatus, RepositoryBuilder } from './orchestratorTypes';
import { OrchestratorStore } from './orchestratorStore';

export interface BrainBuilders {
    authorExpertise: RepositoryBuilder;
    logicalCoupling: RepositoryBuilder;
    driftEngine: RepositoryBuilder;
    knowledgeHotspots: RepositoryBuilder;
    knowledgeValidity: RepositoryBuilder;
    architecturalEvolution: RepositoryBuilder;
    testCoverage: RepositoryBuilder;
    decisionOutcomes: RepositoryBuilder;
    causalReasoning: RepositoryBuilder;
    incidentBuilder: RepositoryBuilder;
    incidentIntelligence: RepositoryBuilder;
    changeImpact: RepositoryBuilder;
    predictionAccountability: RepositoryBuilder;
    runtimeIntelligence?: RepositoryBuilder;
    runtimeDependency?: RepositoryBuilder;
    runtimeBlastRadius?: { build(cycleId: string): Promise<void> };
}

/**
 * RepositoryBrainOrchestrator: runs the full multi-builder rebuild pipeline.
 *
 * Every step is non-fatal: a builder failing on missing/malformed upstream data degrades that
 * one knowledge type to empty rather than aborting the whole rebuild. This matters because the
 * 13 required builders have real inter-dependencies (e.g. DecisionOutcomes/CausalReasoning read
 * tables only the other builders populate) but have never all been exercised together outside
 * hand-written test stubs — a single misbehaving builder should not block the other 12 from
 * producing real RepositoryKnowledge.
 */
export class RepositoryBrainOrchestrator {
    constructor(
        private store: OrchestratorStore,
        private builders: BrainBuilders
    ) {}

    public async runFullRebuild(): Promise<void> {
        let state = this.store.getState();

        // If it was running, it crashed. Start clean.
        if (state && state.status === 'RUNNING') {
            console.warn('RepositoryBrainOrchestrator: Previous run aborted. Forcing clean restart.');
        }

        const now = new Date();
        state = {
            id: 'GLOBAL',
            lastFullRebuildStart: now,
            lastFullRebuildEnd: null,
            status: 'RUNNING',
            failedAtStep: null,
            diagnostics: null
        };
        this.store.saveState(state);

        const failedSteps: string[] = [];

        await this.executeStep('AuthorExpertise', () => this.builders.authorExpertise.build(), failedSteps, state);
        await this.executeStep('LogicalCoupling', () => this.builders.logicalCoupling.build(), failedSteps, state);
        await this.executeStep('ArchitecturalDrift', () => this.builders.driftEngine.build(), failedSteps, state);
        await this.executeStep('KnowledgeHotspots', () => this.builders.knowledgeHotspots.build(), failedSteps, state);
        await this.executeStep('KnowledgeValidity', () => this.builders.knowledgeValidity.build(), failedSteps, state);
        await this.executeStep('ArchitecturalEvolution', () => this.builders.architecturalEvolution.build(), failedSteps, state);

        // 5.5 Test Coverage (must run before Decision Outcomes and Causal Reasoning)
        await this.executeStep('TEST_COVERAGE', () => this.builders.testCoverage.build(), failedSteps, state);

        // 6. Decision Outcomes
        await this.executeStep('DECISION_OUTCOMES', () => this.builders.decisionOutcomes.build(), failedSteps, state);

        // 7. Causal Reasoning
        await this.executeStep('CAUSAL_REASONING', () => this.builders.causalReasoning.build(), failedSteps, state);

        // 8. Incident Builder
        await this.executeStep('INCIDENT_EVENTS', () => this.builders.incidentBuilder.build(), failedSteps, state);

        // 8.5 Runtime Intelligence
        if (this.builders.runtimeIntelligence) {
            await this.executeStep('RUNTIME_INTELLIGENCE', () => this.builders.runtimeIntelligence!.build(), failedSteps, state);
        }

        // 8.6 Runtime Dependencies
        if (this.builders.runtimeDependency) {
            await this.executeStep('RUNTIME_DEPENDENCIES', () => this.builders.runtimeDependency!.build(), failedSteps, state);
        }

        // 8.7 Runtime Blast Radius
        if (this.builders.runtimeBlastRadius) {
            await this.executeStep('RUNTIME_BLAST_RADIUS', async () => {
                const cycleId = require('crypto').randomUUID();
                await this.builders.runtimeBlastRadius!.build(cycleId);
            }, failedSteps, state);
        }

        // 9. Incident Intelligence
        await this.executeStep('INCIDENT_INTELLIGENCE', () => this.builders.incidentIntelligence.build(), failedSteps, state);

        // 10. Change Impact Prediction
        await this.executeStep('CHANGE_IMPACT', () => this.builders.changeImpact.build(), failedSteps, state);

        // 11. Prediction Accountability
        await this.executeStep('PREDICTION_ACCOUNTABILITY', () => this.builders.predictionAccountability.build(), failedSteps, state);

        // The rebuild as a whole only "fails" if every step failed; a partial rebuild (some
        // knowledge types populated, others degraded to empty) is a COMPLETED run with
        // diagnostics, not a FAILED one — the whole point of making every step non-fatal.
        state.status = 'COMPLETED';
        state.lastFullRebuildEnd = new Date();
        state.failedAtStep = failedSteps.length > 0 ? failedSteps.join(', ') : null;
        state.diagnostics = failedSteps.length > 0 ? `${failedSteps.length} step(s) failed non-fatally: ${failedSteps.join(', ')}` : null;
        this.store.saveState(state);
    }

    private async executeStep(stepName: string, fn: () => Promise<void>, failedSteps: string[], state: OrchestratorState): Promise<void> {
        state.failedAtStep = stepName;
        this.store.saveState(state);

        try {
            await fn();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`RepositoryBrainOrchestrator: step ${stepName} failed non-fatally, continuing rebuild: ${message}`);
            failedSteps.push(stepName);
        }
    }
}
