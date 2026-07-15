import * as path from 'path';
import Parser = require('node-tree-sitter');
import { SemanticProvider, SemanticExtractionResult } from '../../semanticProviderContract';
import { getTreeSitterLanguage } from '../../../languageDetector';
import { parseSourceSafely } from '../../../treeSitterParse';
import { RustProgramHandle, IdentityDescriptor } from './internalModels';
import { RustCrateResolver } from './resolution/crateResolver';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { RustNameResolver } from './resolution/nameResolver';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { SemanticAstWalker } from './semanticAstWalker';
import { RepositoryEntityAssembler } from './repositoryEntityAssembler';
import { ObservationAccumulator } from '../shared/observationAccumulator';
import { RepositoryRelationshipAssembler } from '../shared/repositoryRelationshipAssembler';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';

/**
 * Rust has no embeddable compiler/type-checker, so this provider's tier is
 * honestly bounded relative to TypeScriptSemanticProvider, in ways specific
 * to Rust (see docs/engineering-log/RUST_SEMANTIC_PROVIDER_REPORT.md): methods live in separate
 * impl blocks (never nested inside their struct/enum's own declaration),
 * linked via same-file type-name matching rather than AST nesting; `impl
 * Trait for Type` gives IMPLEMENTS a genuine tier improvement over every
 * prior provider; `trait Sub: Super` supertrait bounds are the EXTENDS
 * analog; INSTANTIATES needs no filtering (struct_expression is
 * unambiguous); CALLS is narrower than Go's (only `self.method()` and
 * `Type::method()`/`Self::method()` forms, since Rust has no
 * receiver-variable-name convention to check an arbitrary call against);
 * derive macros (`#[derive(Debug)]`) and `macro_rules!`-generated code are
 * a disclosed non-goal, invisible to static AST parsing.
 */
export class RustSemanticProvider implements SemanticProvider {
    public readonly name = 'rust-semantic-provider';
    public readonly version = '1.0.0';

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.rs');
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult> {
        const startTime = Date.now();
        const workspaceRoot = typeof projectContextToken === 'string' ? projectContextToken : path.dirname(filePath);

        try {
            const language = getTreeSitterLanguage('rust');
            if (!language) {
                throw new Error('tree-sitter-rust grammar is not available');
            }
            const parser = new Parser();
            parser.setLanguage(language);
            const tree = parseSourceSafely(parser, content);
            if (!tree) {
                throw new Error('tree-sitter-rust failed to parse this file');
            }

            const { crateRoot, crateName } = RustCrateResolver.findCrate(filePath);
            const modulePath = RustCrateResolver.computeModulePath(filePath, crateRoot, crateName);

            const handle: RustProgramHandle = {
                tree,
                sourceText: content,
                filePath,
                workspaceRoot,
                modulePath,
                crateName,
                crateRoot
            };

            const moduleDescriptor: IdentityDescriptor = IdentityDescriptorBuilder.build(null, modulePath || path.basename(filePath), 'module', handle);
            const nameResolver = new RustNameResolver(handle.tree.rootNode);

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

            // Structural relationships (DECLARES/IMPORTS/EXTENDS/IMPLEMENTS)
            // are AST-certain, as is INSTANTIATES (struct_expression is
            // unambiguous); only CALLS resolution is a bounded heuristic
            // (same-file, self/Self/Type-qualified forms only) -- see
            // docs/engineering-log/RUST_SEMANTIC_PROVIDER_REPORT.md.
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
