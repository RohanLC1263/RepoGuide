import * as ts from 'typescript';
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { DeclarationExtractionResult, ProgramHandle } from './internalModels';
import { DeclarationClassifier } from './mappers/declarationClassifier';
import { LocationMapper } from './mappers/locationMapper';
import { ModifierMapper } from './mappers/modifierMapper';
import { DocumentationExtractor } from './mappers/documentationExtractor';
import { SymbolResolver } from './resolution/symbolResolver';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CanonicalIdentityFactory } from './resolution/canonicalIdentityFactory';

export class DeclarationVisitor {
    private results: DeclarationExtractionResult[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    private classifier = new DeclarationClassifier();
    private locationMapper = new LocationMapper();
    private modifierMapper = new ModifierMapper();
    private docExtractor = new DocumentationExtractor();

    public processNode(node: ts.Node, handle: ProgramHandle): void {
        const sourceFile = handle.sourceFile;
        try {
            // Prune subtrees we don't care about (e.g. function bodies) for declarations
            if (this.isInsideFunctionBody(node)) {
                return;
            }

            // If it's a declaration, map it
            const entityKind = this.classifier.classify(node);
            if (entityKind) {
                const declNode = node as ts.Declaration;
                let name = 'anonymous';

                if (ts.isVariableDeclaration(declNode)) {
                    if (ts.isIdentifier(declNode.name)) {
                        name = declNode.name.text;
                    } else {
                        // Destructuring or other unsupported forms
                        this.addKnownUnknown(declNode, sourceFile, 'Destructuring variable declaration', 'Destructuring is not yet supported for semantic entities.');
                        return; // Do not emit unsupported decls
                    }
                } else if ((declNode as any).name && ts.isIdentifier((declNode as any).name)) {
                    name = (declNode as any).name.text;
                }

                if (entityKind !== 'method' && entityKind !== 'function' && entityKind !== 'class' && entityKind !== 'interface' && entityKind !== 'enum' && entityKind !== 'namespace' && entityKind !== 'type_alias' && entityKind !== 'variable') {
                    // Unhandled
                } else {
                    const loc = this.locationMapper.map(declNode, sourceFile);
                    const mods = this.modifierMapper.map(declNode);
                    const doc = this.docExtractor.extract(declNode, sourceFile);

                    // CP3C: Resolve Canonical Identity
                    let canonicalIdentity;
                    if (handle.typeChecker) {
                        try {
                            const resolvedSymbol = SymbolResolver.resolve(declNode, handle);
                            const descriptor = IdentityDescriptorBuilder.build(resolvedSymbol, handle);
                            canonicalIdentity = CanonicalIdentityFactory.create(descriptor);
                        } catch (err: any) {
                            if (err.message.includes('Unresolvable') || err.message.includes('Alias cycle')) {
                                this.addKnownUnknown(declNode, sourceFile, 'Alias Resolution', err.message);
                            } else {
                                this.diagnostics.push({
                                    code: 'EXT-002',
                                    severity: 'error',
                                    message: `Symbol resolution error: ${err.message}`,
                                    location: loc as any
                                });
                            }
                            return; // Do not emit entity if identity resolution failed
                        }
                    }

                    if (canonicalIdentity) {
                        this.results.push({
                            node: declNode,
                            entityKind,
                            name,
                            filePath: sourceFile.fileName,
                            startLine: loc.startLine,
                            endLine: loc.endLine,
                            modifiers: mods.modifiers,
                            visibility: mods.visibility,
                            documentation: doc,
                            canonicalIdentity
                        });
                    }
                }
            }
        } catch (err: any) {
            this.diagnostics.push({
                code: 'EXT-001',
                severity: 'error',
                message: `Internal error during AST traversal: ${err.message}`,
                location: this.locationMapper.map(node, sourceFile) as any // Cast because diagnostics might use diff format
            });
        }
    }

    private isInsideFunctionBody(node: ts.Node): boolean {
        let current = node.parent;
        while (current) {
            if (ts.isBlock(current) && current.parent && (
                ts.isFunctionDeclaration(current.parent) || 
                ts.isMethodDeclaration(current.parent) || 
                ts.isConstructorDeclaration(current.parent) ||
                ts.isArrowFunction(current.parent) ||
                ts.isFunctionExpression(current.parent) ||
                ts.isGetAccessor(current.parent) ||
                ts.isSetAccessor(current.parent)
            )) {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    public getResults() {
        return {
            results: this.results,
            diagnostics: this.diagnostics,
            knownUnknowns: this.knownUnknowns
        };
    }

    private addKnownUnknown(node: ts.Node, sourceFile: ts.SourceFile, construct: string, reason: string) {
        const loc = this.locationMapper.map(node, sourceFile);
        this.knownUnknowns.push({
            id: `ku-${Date.now()}-${Math.random()}`,
            source: { package: '', logicalNamespace: '', kind: 'unknown', qualifiedName: '', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' },
            sourceLocation: { filePath: sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine },
            unsupportedConstruct: construct,
            reason: reason,
            evidence: [],
            recommendedHandling: 'Wait for future checkpoint support'
        });
    }
}
