import * as fs from 'fs';
import * as path from 'path';
import Parser = require('node-tree-sitter');
import { SemanticProvider, SemanticExtractionResult } from '../../semanticProviderContract';
import { getTreeSitterLanguage } from '../../../languageDetector';
import { parseSourceSafely } from '../../../treeSitterParse';
import { CppProgramHandle, IdentityDescriptor } from './internalModels';
import { CppIncludeResolver } from './resolution/includeResolver';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CppNameResolver } from './resolution/nameResolver';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { SemanticAstWalker } from './semanticAstWalker';
import { RepositoryEntityAssembler } from './repositoryEntityAssembler';
import { ObservationAccumulator } from '../shared/observationAccumulator';
import { RepositoryRelationshipAssembler } from '../shared/repositoryRelationshipAssembler';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';

const HEADER_EXTENSIONS = new Set(['.h', '.hpp', '.hh', '.hxx', '.h++', '.inl']);
const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c++', '.c']);

/**
 * C++ has no embeddable compiler, so this provider's tier is honestly
 * bounded relative to TypeScriptSemanticProvider -- but the central
 * departure from every prior provider (see docs/engineering-log/CPP_SEMANTIC_PROVIDER_REPORT.md)
 * is that DECLARES for methods is frequently a CROSS-FILE relationship:
 * 84.2% of real header-declared methods are defined out-of-line in a
 * separate .cpp via `ClassName::method`, resolved through a paired-header
 * lookup (found via the .cpp's own first quoted #include, empirically
 * confirmed to be a 100%-reliable signal in real code), not same-file AST
 * nesting. Multiple inheritance is real and supported (EXTENDS as a list).
 * IMPLEMENTS is an explicit disclosed non-goal -- C++ gives no syntax
 * distinguishing a "pure interface" abstract base from an ordinary
 * concrete one. `#include` resolution is a disclosed approximation
 * (same-directory + conventional include/src roots), since real resolution
 * depends on build-system-specific -I flags this parser can't see.
 */
export class CppSemanticProvider implements SemanticProvider {
    public readonly name = 'cpp-semantic-provider';
    public readonly version = '1.0.0';

    public canHandle(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        return HEADER_EXTENSIONS.has(ext) || SOURCE_EXTENSIONS.has(ext);
    }

    public async extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult> {
        const startTime = Date.now();
        const workspaceRoot = typeof projectContextToken === 'string' ? projectContextToken : path.dirname(filePath);

        try {
            const language = getTreeSitterLanguage('cpp');
            if (!language) {
                throw new Error('tree-sitter-cpp grammar is not available');
            }
            const parser = new Parser();
            parser.setLanguage(language);
            const tree = parseSourceSafely(parser, content);
            if (!tree) {
                throw new Error('tree-sitter-cpp failed to parse this file');
            }

            const ext = path.extname(filePath).toLowerCase();
            const isHeader = HEADER_EXTENSIONS.has(ext);

            let pairedHeaderPath: string | null = null;
            let pairedHeaderTree: Parser.Tree | null = null;
            if (!isHeader) {
                const firstInclude = CppIncludeResolver.firstQuotedInclude(content);
                if (firstInclude) {
                    pairedHeaderPath = CppIncludeResolver.resolveQuotedInclude(firstInclude, filePath, workspaceRoot);
                    if (pairedHeaderPath) {
                        try {
                            const headerContent = fs.readFileSync(pairedHeaderPath, 'utf8');
                            pairedHeaderTree = parseSourceSafely(parser, headerContent);
                        } catch {
                            pairedHeaderTree = null; // paired header couldn't be read/parsed -- falls back to same-file-only resolution
                        }
                    }
                }
            }

            const handle: CppProgramHandle = {
                tree,
                sourceText: content,
                filePath,
                workspaceRoot,
                isHeader,
                pairedHeaderPath,
                pairedHeaderTree
            };

            const moduleDescriptor: IdentityDescriptor = IdentityDescriptorBuilder.build(null, path.basename(filePath), 'module', handle);
            const nameResolver = new CppNameResolver(handle.tree.rootNode, pairedHeaderTree?.rootNode ?? null);

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
                name: path.basename(filePath),
                filePath,
                startLine: 1,
                endLine: handle.tree.rootNode.endPosition.row + 1,
                modifiers: [],
                visibility: 'public',
                canonicalIdentity: CanonicalIdentityFactory.create(moduleDescriptor)
            }));

            // Structural relationships (DECLARES/IMPORTS/EXTENDS) are
            // AST-certain (once resolved, possibly cross-file via the
            // paired header), as is INSTANTIATES (new_expression filtered
            // to exclude array-new and primitive scalar new); only CALLS
            // resolution is a bounded heuristic (same-file/same-paired-header
            // only) -- see docs/engineering-log/CPP_SEMANTIC_PROVIDER_REPORT.md.
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
