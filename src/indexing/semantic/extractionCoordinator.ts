import { SemanticExtractionEngine } from './semanticProviderContract';
import { ExtractionExecutionPolicy } from './extractionExecutionPolicy';
import { LogicalUnit } from '../logicalUnitTypes';

/**
 * ExtractionCoordinator orchestrates execution of the extraction pipelines.
 * It enforces the ExtractionExecutionPolicy but makes no strategy decisions itself.
 */
export class ExtractionCoordinator {
    constructor(
        private policy: ExtractionExecutionPolicy,
        private dispatcher: SemanticExtractionEngine,
        private legacyExtractor: (filePath: string, workspaceRoot: string) => Promise<LogicalUnit[]>
    ) {}

    public async extractFile(filePath: string, content: string, workspaceRoot: string): Promise<LogicalUnit[]> {
        const canHandleSemantic = this.dispatcher.canHandle(filePath);
        const strategy = this.policy.determineStrategy(filePath, canHandleSemantic);

        let legacyResult: LogicalUnit[] = [];

        // Shadow Mode: Execute semantic provider for testing/metrics, but ignore results for now
        if (strategy.executeSemantic) {
            try {
                // In CP3A, this returns empty results from the stub provider.
                // It does not affect the authoritative index.
                const semanticResult = await this.dispatcher.extract(filePath, content);
                if (semanticResult) {
                    // We could log duration here: console.log(`Semantic extraction took ${semanticResult.metrics.durationMs}ms`);
                }
            } catch (e) {
                console.error(`Semantic Extraction failed in shadow mode for ${filePath}:`, e);
            }
        }

        // Execute legacy Tree-sitter pipeline if policy dictates
        if (strategy.executeLexical) {
            legacyResult = await this.legacyExtractor(filePath, workspaceRoot);
        }

        // Enforce authoritative result
        if (strategy.authoritativeResult === 'semantic') {
            throw new Error("SemanticOnly mode is not yet supported in ExtractionCoordinator.");
        }

        return legacyResult;
    }
}
