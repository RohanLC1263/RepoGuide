import * as path from 'path';
import Parser = require('node-tree-sitter');
import { SemanticProvider, SemanticExtractionResult } from '../../semanticProviderContract';
import { getTreeSitterLanguage } from '../../../languageDetector';
import { parseSourceSafely } from '../../../treeSitterParse';
import { CSharpProgramHandle, IdentityDescriptor } from './internalModels';
import { CSharpNamespaceResolver } from './resolution/namespaceResolver';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CSharpNameResolver } from './resolution/nameResolver';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { SemanticAstWalker } from './semanticAstWalker';
import { RepositoryEntityAssembler } from './repositoryEntityAssembler';
import { ObservationAccumulator } from '../shared/observationAccumulator';
import { RepositoryRelationshipAssembler } from '../shared/repositoryRelationshipAssembler';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';

/**
 * C# has no embeddable equivalent of a real compiler/type checker, so this
 * provider's tier is honestly bounded relative to TypeScriptSemanticProvider,
 * and differs from both PythonSemanticProvider and JavaSemanticProvider in
 * one significant way (see CSHARP_SEMANTIC_PROVIDER_REPORT.md): C#'s
 * base_list syntax doesn't distinguish "extends" from "implements" the way
 * Java's separate superclass/interfaces fields do, so EXTENDS/IMPLEMENTS
 * classification only happens when a base-list entry resolves locally.
 */
export class CSharpSemanticProvider implements SemanticProvider {
    public readonly name = 'csharp-semantic-provider';
    public readonly version = '1.0.0';

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.cs');
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult> {
        const startTime = Date.now();
        const workspaceRoot = typeof projectContextToken === 'string' ? projectContextToken : path.dirname(filePath);

        try {
            const language = getTreeSitterLanguage('csharp');
            if (!language) {
                throw new Error('tree-sitter-c-sharp grammar is not available');
            }
            const parser = new Parser();
            parser.setLanguage(language);
            const tree = parseSourceSafely(parser, content);
            if (!tree) {
                throw new Error('tree-sitter-c-sharp failed to parse this file');
            }

            const namespaceDecl = tree.rootNode.namedChildren.find(c => c.type === 'namespace_declaration' || c.type === 'file_scoped_namespace_declaration');
            const namespaceName = namespaceDecl?.childForFieldName('name')?.text ?? '';

            const handle: CSharpProgramHandle = {
                tree,
                sourceText: content,
                filePath,
                workspaceRoot,
                namespaceName
            };

            const moduleDescriptor: IdentityDescriptor = IdentityDescriptorBuilder.build(null, namespaceName || path.basename(filePath), 'module', handle);
            const nameResolver = new CSharpNameResolver(handle.tree.rootNode);

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
                name: namespaceName || path.basename(filePath),
                filePath,
                startLine: 1,
                endLine: handle.tree.rootNode.endPosition.row + 1,
                modifiers: [],
                visibility: 'public',
                canonicalIdentity: CanonicalIdentityFactory.create(moduleDescriptor)
            }));

            // Structural relationships (DECLARES/IMPORTS/EXTENDS/IMPLEMENTS) are
            // AST-certain, as is INSTANTIATES (`new X()` is unambiguous); only
            // CALLS resolution is a bounded heuristic (bare/`this.` calls only,
            // no inheritance/override awareness) -- see
            // CSHARP_SEMANTIC_PROVIDER_REPORT.md.
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
