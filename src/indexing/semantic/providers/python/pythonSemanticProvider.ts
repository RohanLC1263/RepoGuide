import * as path from 'path';
import Parser = require('node-tree-sitter');
import { SemanticProvider, SemanticExtractionResult } from '../../semanticProviderContract';
import { getTreeSitterLanguage } from '../../../languageDetector';
import { parseSourceSafely } from '../../../treeSitterParse';
import { PythonProgramHandle, IdentityDescriptor } from './internalModels';
import { PythonModulePathResolver } from './resolution/moduleResolver';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { PythonNameResolver } from './resolution/nameResolver';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { SemanticAstWalker } from './semanticAstWalker';
import { RepositoryEntityAssembler } from './repositoryEntityAssembler';
import { ObservationAccumulator } from '../shared/observationAccumulator';
import { RepositoryRelationshipAssembler } from '../shared/repositoryRelationshipAssembler';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';

/**
 * Python has no embeddable equivalent of TypeScript's type checker, so this
 * provider's tier is honestly bounded relative to TypeScriptSemanticProvider:
 * structural facts (DECLARES/IMPORTS/EXTENDS) at high confidence, same-file
 * CALLS/INSTANTIATES heuristics, and no REFERENCES at all (see
 * docs/engineering-log/PYTHON_SEMANTIC_PROVIDER_REPORT.md for the full disclosure).
 */
export class PythonSemanticProvider implements SemanticProvider {
    public readonly name = 'python-semantic-provider';
    public readonly version = '1.0.0';

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.py');
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult> {
        const startTime = Date.now();
        const workspaceRoot = typeof projectContextToken === 'string' ? projectContextToken : path.dirname(filePath);

        try {
            const language = getTreeSitterLanguage('python');
            if (!language) {
                throw new Error('tree-sitter-python grammar is not available');
            }
            const parser = new Parser();
            parser.setLanguage(language);
            const tree = parseSourceSafely(parser, content);
            if (!tree) {
                throw new Error('tree-sitter-python failed to parse this file');
            }

            const { modulePath, isAuthoritative } = PythonModulePathResolver.resolveModulePath(filePath, workspaceRoot);
            const handle: PythonProgramHandle = {
                tree,
                sourceText: content,
                filePath,
                workspaceRoot,
                modulePath,
                modulePathIsAuthoritative: isAuthoritative
            };

            const moduleDescriptor: IdentityDescriptor = IdentityDescriptorBuilder.build(null, modulePath, 'module', handle);
            const nameResolver = new PythonNameResolver(handle.tree.rootNode);

            const declarationVisitor = new DeclarationVisitor();
            const relationshipVisitor = new RelationshipVisitor();
            const walker = new SemanticAstWalker(declarationVisitor, relationshipVisitor);
            walker.walk(handle, nameResolver, moduleDescriptor);

            const { results: declResults, diagnostics: declDiag, knownUnknowns: declKU } = declarationVisitor.getResults();
            const { descriptors, diagnostics: relDiag, knownUnknowns: relKU } = relationshipVisitor.getResults();

            const entityAssembler = new RepositoryEntityAssembler();
            const entities = declResults.map(r => entityAssembler.assemble(r));
            entities.push(entityAssembler.assemble({
                node: null,
                entityKind: 'module',
                name: modulePath || path.basename(filePath),
                filePath,
                startLine: 1,
                endLine: handle.tree.rootNode.endPosition.row + 1,
                modifiers: [],
                visibility: 'public',
                canonicalIdentity: CanonicalIdentityFactory.create(moduleDescriptor)
            }));

            // Structural relationships (DECLARES/IMPORTS/EXTENDS) are AST-certain;
            // CALLS/INSTANTIATES are name-resolution heuristics -- ObservationAccumulator
            // takes one evidence type per instance, so each tier gets its own.
            const astAccumulator = new ObservationAccumulator('ast');
            const heuristicAccumulator = new ObservationAccumulator('heuristic');
            for (const descriptor of descriptors) {
                if (descriptor.relationshipKind === 'CALLS' || descriptor.relationshipKind === 'INSTANTIATES') {
                    heuristicAccumulator.accumulate(descriptor);
                } else {
                    astAccumulator.accumulate(descriptor);
                }
            }

            const relAssembler = new RepositoryRelationshipAssembler();
            const relationships = [
                ...astAccumulator.getAggregates().map(agg => relAssembler.assemble(agg)),
                ...heuristicAccumulator.getAggregates().map(agg => relAssembler.assemble(agg))
            ];

            const knownUnknowns = [...declKU, ...relKU];
            const diagnostics = [...declDiag, ...relDiag];

            return {
                status: 'SUCCESS',
                providerMetadata: {
                    providerName: this.name,
                    providerVersion: this.version,
                    extractionMethod: 'ast',
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
                    extractionMethod: 'ast',
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
