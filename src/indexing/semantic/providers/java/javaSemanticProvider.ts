import * as path from 'path';
import Parser = require('node-tree-sitter');
import { SemanticProvider, SemanticExtractionResult } from '../../semanticProviderContract';
import { getTreeSitterLanguage } from '../../../languageDetector';
import { parseSourceSafely } from '../../../treeSitterParse';
import { JavaProgramHandle, IdentityDescriptor } from './internalModels';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { JavaNameResolver } from './resolution/nameResolver';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { SemanticAstWalker } from './semanticAstWalker';
import { RepositoryEntityAssembler } from './repositoryEntityAssembler';
import { ObservationAccumulator } from '../shared/observationAccumulator';
import { RepositoryRelationshipAssembler } from '../shared/repositoryRelationshipAssembler';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';

/**
 * Java has no embeddable equivalent of a real compiler/type checker, so this
 * provider's tier is honestly bounded relative to TypeScriptSemanticProvider,
 * and differs in specific ways from PythonSemanticProvider (see
 * JAVA_SEMANTIC_PROVIDER_REPORT.md): package resolution is authoritative
 * (Java's `package` declaration, unlike Python's best-effort __init__.py
 * walk), and INSTANTIATES is unambiguous (`new X()`, no uppercase-name
 * guess) rather than heuristic.
 */
export class JavaSemanticProvider implements SemanticProvider {
    public readonly name = 'java-semantic-provider';
    public readonly version = '1.0.0';

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.java');
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult> {
        const startTime = Date.now();
        const workspaceRoot = typeof projectContextToken === 'string' ? projectContextToken : path.dirname(filePath);

        try {
            const language = getTreeSitterLanguage('java');
            if (!language) {
                throw new Error('tree-sitter-java grammar is not available');
            }
            const parser = new Parser();
            parser.setLanguage(language);
            const tree = parseSourceSafely(parser, content);
            if (!tree) {
                throw new Error('tree-sitter-java failed to parse this file');
            }

            const packageDecl = tree.rootNode.namedChildren.find(c => c.type === 'package_declaration');
            const packageName = packageDecl?.namedChildren[0]?.text ?? '';

            const handle: JavaProgramHandle = {
                tree,
                sourceText: content,
                filePath,
                workspaceRoot,
                packageName
            };

            const moduleDescriptor: IdentityDescriptor = IdentityDescriptorBuilder.build(null, packageName || path.basename(filePath), 'module', handle);
            const nameResolver = new JavaNameResolver(handle.tree.rootNode);

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
                name: packageName || path.basename(filePath),
                filePath,
                startLine: 1,
                endLine: handle.tree.rootNode.endPosition.row + 1,
                modifiers: [],
                visibility: 'public',
                canonicalIdentity: CanonicalIdentityFactory.create(moduleDescriptor)
            }));

            // Structural relationships (DECLARES/IMPORTS/EXTENDS/IMPLEMENTS) are
            // AST-certain, as is INSTANTIATES (`new X()` is unambiguous, unlike
            // Python's uppercase-name guess); only CALLS resolution is a bounded
            // heuristic (bare/`this.` calls only, no inheritance/override
            // awareness) -- see JAVA_SEMANTIC_PROVIDER_REPORT.md.
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
