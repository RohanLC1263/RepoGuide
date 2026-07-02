import { SemanticProvider, SemanticExtractionResult } from '../../semanticProviderContract';
import { DefaultProgramProvider } from './programProvider';
import { ProgramProvider } from './internalModels';
import { DeclarationVisitor } from './declarationVisitor';
import { RepositoryEntityAssembler } from './repositoryEntityAssembler';
import { RelationshipVisitor } from './relationshipVisitor';
import { SemanticAstWalker } from './semanticAstWalker';
import { ObservationAccumulator } from './resolution/observationAccumulator';
import { RelationshipDescriptorBuilder } from './resolution/relationshipDescriptorBuilder';
import { RepositoryRelationshipAssembler } from './repositoryRelationshipAssembler';
export class TypeScriptSemanticProvider implements SemanticProvider {
    public readonly name = 'typescript-semantic-provider';
    public readonly version = '1.1.0';
    
    private programProvider: ProgramProvider;

    constructor(programProvider?: ProgramProvider) {
        this.programProvider = programProvider || new DefaultProgramProvider();
    }

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult> {
        const startTime = Date.now();
        
        try {
            const handle = this.programProvider.getProgramHandle(filePath, content);
            
            const declarationVisitor = new DeclarationVisitor();
            const relationshipVisitor = new RelationshipVisitor();
            
            const walker = new SemanticAstWalker(declarationVisitor, relationshipVisitor);
            walker.walk(handle);

            const { results: declResults, diagnostics: declDiag, knownUnknowns: declKU } = declarationVisitor.getResults();
            const { observations, diagnostics: relDiag, knownUnknowns: relKU } = relationshipVisitor.getResults();

            const entityAssembler = new RepositoryEntityAssembler();
            const entities = declResults.map(r => entityAssembler.assemble(r));

            const accumulator = new ObservationAccumulator();
            for (const obs of observations) {
                const descriptor = RelationshipDescriptorBuilder.build(obs, handle);
                accumulator.accumulate(descriptor);
            }

            const relAssembler = new RepositoryRelationshipAssembler();
            const relationships = accumulator.getAggregates().map(agg => relAssembler.assemble(agg));

            const knownUnknowns = [...declKU, ...relKU];
            const diagnostics = [...declDiag, ...relDiag];

            return {
                status: 'SUCCESS',
                providerMetadata: {
                    providerName: this.name,
                    providerVersion: this.version,
                    extractionMethod: 'compiler',
                    extractionTimestampMs: Date.now()
                },
                entities,
                relationships,
                knownUnknowns,
                diagnostics,
                metrics: {
                    durationMs: Date.now() - startTime,
                    filesProcessed: 1,
                    entitiesExtracted: entities.length,
                    relationshipsExtracted: relationships.length,
                    unknownsFound: knownUnknowns.length
                }
            };
        } catch (err: any) {
            return {
                status: 'FAILED',
                providerMetadata: {
                    providerName: this.name,
                    providerVersion: this.version,
                    extractionMethod: 'compiler',
                    extractionTimestampMs: Date.now()
                },
                entities: [],
                relationships: [],
                knownUnknowns: [],
                diagnostics: [{
                    code: 'EXT-000',
                    severity: 'error',
                    message: `Provider catastrophically failed: ${err.message}`
                }],
                metrics: {
                    durationMs: Date.now() - startTime,
                    filesProcessed: 1,
                    entitiesExtracted: 0,
                    relationshipsExtracted: 0,
                    unknownsFound: 0
                }
            };
        }
    }
}
