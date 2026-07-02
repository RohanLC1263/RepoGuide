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

        try {
            await this.executeStep('AuthorExpertise', () => this.builders.authorExpertise.build());
            await this.executeStep('LogicalCoupling', () => this.builders.logicalCoupling.build());
            await this.executeStep('ArchitecturalDrift', () => this.builders.driftEngine.build());
            await this.executeStep('KnowledgeHotspots', () => this.builders.knowledgeHotspots.build());
            await this.executeStep('KnowledgeValidity', () => this.builders.knowledgeValidity.build());
            await this.executeStep('ArchitecturalEvolution', () => this.builders.architecturalEvolution.build());

            // 5.5 Test Coverage (must run before Decision Outcomes and Causal Reasoning)
            await this.executeStep('TEST_COVERAGE', () => this.builders.testCoverage.build());

            // 6. Decision Outcomes
            await this.executeStep('DECISION_OUTCOMES', () => this.builders.decisionOutcomes.build());

            // 7. Causal Reasoning
            await this.executeStep('CAUSAL_REASONING', () => this.builders.causalReasoning.build());

            // 8. Incident Builder
            await this.executeStep('INCIDENT_EVENTS', () => this.builders.incidentBuilder.build());

            // 8.5 Runtime Intelligence
            if (this.builders.runtimeIntelligence) {
                await this.executeStep('RUNTIME_INTELLIGENCE', () => this.builders.runtimeIntelligence!.build());
            }

            // 8.6 Runtime Dependencies
            if (this.builders.runtimeDependency) {
                await this.executeStep('RUNTIME_DEPENDENCIES', async () => {
                    try {
                        await this.builders.runtimeDependency!.build();
                    } catch (e) {
                        console.warn('RepositoryBrainOrchestrator: Runtime Dependency Discovery failed, continuing orchestrator execution:', e);
                    }
                });
            }

            // 8.7 Runtime Blast Radius
            if (this.builders.runtimeBlastRadius) {
                await this.executeStep('RUNTIME_BLAST_RADIUS', async () => {
                    try {
                        const cycleId = require('crypto').randomUUID();
                        await this.builders.runtimeBlastRadius!.build(cycleId);
                    } catch (e) {
                        console.warn('RepositoryBrainOrchestrator: Runtime Blast Radius Engine failed, continuing orchestrator execution:', e);
                    }
                });
            }

            // 9. Incident Intelligence
            await this.executeStep('INCIDENT_INTELLIGENCE', () => this.builders.incidentIntelligence.build());

            // 10. Change Impact Prediction
            await this.executeStep('CHANGE_IMPACT', () => this.builders.changeImpact.build());

            // 11. Prediction Accountability
            await this.executeStep('PREDICTION_ACCOUNTABILITY', async () => {
                try {
                    await this.builders.predictionAccountability.build();
                } catch (e) {
                    console.error('Accountability Layer encountered non-fatal error:', e);
                }
            });

            state.status = 'COMPLETED';
            state.lastFullRebuildEnd = new Date();
            this.store.saveState(state);
        } catch (error: any) {
            state.status = 'FAILED';
            state.diagnostics = error.message || error.toString();
            this.store.saveState(state);
            throw error;
        }
    }

    private async executeStep(stepName: string, fn: () => Promise<void>): Promise<void> {
        const state = this.store.getState();
        if (state) {
            state.failedAtStep = stepName;
            this.store.saveState(state);
        }

        try {
            await fn();
        } catch (error) {
            throw error;
        }
    }
}
