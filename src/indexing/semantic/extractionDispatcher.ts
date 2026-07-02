import { SemanticProvider, SemanticExtractionEngine, SemanticExtractionResult } from './semanticProviderContract';

/**
 * ExtractionDispatcher is strictly responsible for routing files to the correct SemanticProvider.
 * It makes no decisions about execution strategy (e.g. Shadow Mode, Lexical vs Semantic).
 */
export class ExtractionDispatcher implements SemanticExtractionEngine {
    private providers: SemanticProvider[] = [];

    public registerProvider(provider: SemanticProvider): void {
        this.providers.push(provider);
    }

    public canHandle(filePath: string): boolean {
        return this.providers.some(p => p.canHandle(filePath));
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult | null> {
        for (const provider of this.providers) {
            if (provider.canHandle(filePath)) {
                return await provider.extract(filePath, content, projectContextToken);
            }
        }
        return null;
    }
}
