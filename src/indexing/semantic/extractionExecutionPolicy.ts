export enum ExtractionMode {
    LexicalOnly = 'LexicalOnly',
    SemanticOnly = 'SemanticOnly',
    ShadowMode = 'ShadowMode'
}

export interface ExecutionStrategy {
    executeLexical: boolean;
    executeSemantic: boolean;
    authoritativeResult: 'lexical' | 'semantic';
}

/**
 * ExtractionExecutionPolicy dictates the execution strategy for a given file.
 * It removes all migration strategy logic from the Coordinator and Dispatcher.
 */
export class ExtractionExecutionPolicy {
    private globalMode: ExtractionMode = ExtractionMode.ShadowMode;

    public setMode(mode: ExtractionMode): void {
        this.globalMode = mode;
    }

    public determineStrategy(filePath: string, semanticCanHandle: boolean): ExecutionStrategy {
        if (!semanticCanHandle) {
            return {
                executeLexical: true,
                executeSemantic: false,
                authoritativeResult: 'lexical'
            };
        }

        switch (this.globalMode) {
            case ExtractionMode.LexicalOnly:
                return {
                    executeLexical: true,
                    executeSemantic: false,
                    authoritativeResult: 'lexical'
                };
            case ExtractionMode.SemanticOnly:
                return {
                    executeLexical: false,
                    executeSemantic: true,
                    authoritativeResult: 'semantic'
                };
            case ExtractionMode.ShadowMode:
                return {
                    executeLexical: true,
                    executeSemantic: true,
                    authoritativeResult: 'lexical'
                };
            default:
                // Safe fallback
                return {
                    executeLexical: true,
                    executeSemantic: false,
                    authoritativeResult: 'lexical'
                };
        }
    }
}
