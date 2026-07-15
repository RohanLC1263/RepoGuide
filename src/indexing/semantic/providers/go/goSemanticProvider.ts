import * as path from 'path';
import Parser = require('node-tree-sitter');
import { SemanticProvider, SemanticExtractionResult } from '../../semanticProviderContract';
import { getTreeSitterLanguage } from '../../../languageDetector';
import { parseSourceSafely } from '../../../treeSitterParse';
import { GoProgramHandle, IdentityDescriptor } from './internalModels';
import { GoModuleResolver } from './resolution/moduleResolver';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { GoNameResolver } from './resolution/nameResolver';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { SemanticAstWalker } from './semanticAstWalker';
import { RepositoryEntityAssembler } from './repositoryEntityAssembler';
import { ObservationAccumulator } from '../shared/observationAccumulator';
import { RepositoryRelationshipAssembler } from '../shared/repositoryRelationshipAssembler';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';

/**
 * Go has no embeddable compiler/type-checker, so this provider's tier is
 * honestly bounded relative to TypeScriptSemanticProvider, and differs
 * from Python/Java/C# in ways specific to Go (see
 * docs/engineering-log/GO_SEMANTIC_PROVIDER_REPORT.md): methods aren't nested inside their
 * struct's declaration at all (linked via receiver-type matching instead
 * of AST nesting), struct/interface embedding is the EXTENDS analog, and
 * IMPLEMENTS is not attempted at all -- Go gives no syntax for interface
 * satisfaction to even heuristically approximate.
 */
export class GoSemanticProvider implements SemanticProvider {
    public readonly name = 'go-semantic-provider';
    public readonly version = '1.0.0';

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.go');
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult> {
        const startTime = Date.now();
        const workspaceRoot = typeof projectContextToken === 'string' ? projectContextToken : path.dirname(filePath);

        try {
            const language = getTreeSitterLanguage('go');
            if (!language) {
                throw new Error('tree-sitter-go grammar is not available');
            }
            const parser = new Parser();
            parser.setLanguage(language);
            const tree = parseSourceSafely(parser, content);
            if (!tree) {
                throw new Error('tree-sitter-go failed to parse this file');
            }

            const { moduleRoot, modulePath } = GoModuleResolver.findModule(filePath);
            const importPath = GoModuleResolver.computeImportPath(filePath, moduleRoot, modulePath);

            const handle: GoProgramHandle = {
                tree,
                sourceText: content,
                filePath,
                workspaceRoot,
                importPath,
                modulePath,
                moduleRoot
            };

            const moduleDescriptor: IdentityDescriptor = IdentityDescriptorBuilder.build(null, importPath || path.basename(filePath), 'module', handle);
            const nameResolver = new GoNameResolver(handle.tree.rootNode);

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
                name: importPath || path.basename(filePath),
                filePath,
                startLine: 1,
                endLine: handle.tree.rootNode.endPosition.row + 1,
                modifiers: [],
                visibility: 'public',
                canonicalIdentity: CanonicalIdentityFactory.create(moduleDescriptor)
            }));

            // Structural relationships (DECLARES/IMPORTS/EXTENDS) are
            // AST-certain, as is INSTANTIATES (composite_literal filtered to
            // type_identifier is unambiguous once the container-literal
            // shapes are excluded); only CALLS resolution is a bounded
            // heuristic (same-file, receiver-variable-name matching) -- see
            // docs/engineering-log/GO_SEMANTIC_PROVIDER_REPORT.md.
            const astAccumulator = new ObservationAccumulator('ast');
            const heuristicAccumulator = new ObservationAccumulator('heuristic');
            for (const descriptor of descriptors) {
                if (descriptor.relationshipKind === 'CALLS') {
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
