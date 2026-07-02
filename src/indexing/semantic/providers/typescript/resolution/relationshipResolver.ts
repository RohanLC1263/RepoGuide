import * as ts from 'typescript';
import { ProgramHandle, ResolvedRelationshipObservation } from '../internalModels';
import { KnownUnknown } from '../../../semanticProviderContract';
import { SymbolResolver } from './symbolResolver';
import { LocationMapper } from '../mappers/locationMapper';

export type ResolveResult = 
    | { type: 'observation', observation: ResolvedRelationshipObservation }
    | { type: 'unknown', unknown: KnownUnknown };

export class RelationshipResolver {
    private static locationMapper = new LocationMapper();

    public static resolve(node: ts.Node, handle: ProgramHandle): ResolveResult[] {
        if (!handle.typeChecker) return [];
        const typeChecker = handle.typeChecker;

        const results: ResolveResult[] = [];

        // Identify enclosing declaration (Source)
        const sourceDecl = this.getEnclosingDeclaration(node);
        if (!sourceDecl) {
            // Cannot emit a relationship without a source
            return [];
        }

        let sourceSymbol;
        try {
            sourceSymbol = SymbolResolver.resolve(sourceDecl, handle);
        } catch (err: any) {
            results.push({
                type: 'unknown',
                unknown: this.buildUnknown(node, handle, 'Source Resolution', err.message)
            });
            return results;
        }

        // DECLARES
        // If the node is a block or container, its children declarations emit DECLARES.
        // Handled differently: When we see a declaration, its container is the source, and the declaration itself is the target.
        if (this.isDeclaration(node) && node !== sourceDecl) {
            try {
                const targetSymbol = SymbolResolver.resolve(node as ts.Declaration, handle);
                const loc = this.locationMapper.map(node, handle.sourceFile);
                results.push({
                    type: 'observation',
                    observation: {
                        source: sourceSymbol,
                        target: targetSymbol,
                        relationshipKind: 'DECLARES',
                        astNode: node,
                        location: { filePath: handle.sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine }
                    }
                });
            } catch (err: any) {
                // Ignore DECLARES unknowns to avoid spam, or emit? 
                // Taxonomy says "Source Canonical Identity resolution fails -> Drop Relationship. Emit KnownUnknown."
            }
        }

        // CALLS
        if (ts.isCallExpression(node)) {
            this.handleCall(node, sourceSymbol, handle, results);
        }
        
        // INSTANTIATES
        else if (ts.isNewExpression(node)) {
            this.handleInstantiates(node, sourceSymbol, handle, results);
        }

        // IMPORTS
        else if (ts.isImportDeclaration(node)) {
            this.handleImports(node, sourceSymbol, handle, results);
        }
        else if (ts.isImportEqualsDeclaration(node)) {
            this.handleImportEquals(node, sourceSymbol, handle, results);
        }

        // EXTENDS / IMPLEMENTS
        else if (ts.isHeritageClause(node)) {
            this.handleHeritage(node, sourceSymbol, handle, results);
        }

        // REFERENCES
        else if (ts.isIdentifier(node) && !this.isPartOfOtherRelationship(node)) {
            this.handleReferences(node, sourceSymbol, handle, results);
        }

        return results;
    }

    private static handleCall(node: ts.CallExpression, sourceSymbol: any, handle: ProgramHandle, results: ResolveResult[]) {
        const typeChecker = handle.typeChecker!;
        const signature = typeChecker.getResolvedSignature(node);
        if (!signature || !signature.declaration) {
            results.push({
                type: 'unknown',
                unknown: this.buildUnknown(node, handle, 'Dynamic Dispatch', 'Target signature cannot be resolved')
            });
            return;
        }

        try {
            const targetSymbol = SymbolResolver.resolve(signature.declaration, handle);
            const loc = this.locationMapper.map(node.expression, handle.sourceFile);
            results.push({
                type: 'observation',
                observation: {
                    source: sourceSymbol,
                    target: targetSymbol,
                    relationshipKind: 'CALLS',
                    astNode: node.expression,
                    location: { filePath: handle.sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine }
                }
            });
        } catch (err: any) {
            results.push({
                type: 'unknown',
                unknown: this.buildUnknown(node, handle, 'Target Resolution', err.message)
            });
        }
    }

    private static handleInstantiates(node: ts.NewExpression, sourceSymbol: any, handle: ProgramHandle, results: ResolveResult[]) {
        const typeChecker = handle.typeChecker!;
        const signature = typeChecker.getResolvedSignature(node);
        if (!signature || !signature.declaration) {
            results.push({
                type: 'unknown',
                unknown: this.buildUnknown(node, handle, 'Dynamic Instantiation', 'Target signature cannot be resolved')
            });
            return;
        }

        try {
            // Target is typically a constructor declaration. The class is its parent.
            const targetDecl = ts.isConstructorDeclaration(signature.declaration) && signature.declaration.parent 
                ? signature.declaration.parent 
                : signature.declaration;
                
            const targetSymbol = SymbolResolver.resolve(targetDecl, handle);
            const loc = this.locationMapper.map(node.expression, handle.sourceFile);
            results.push({
                type: 'observation',
                observation: {
                    source: sourceSymbol,
                    target: targetSymbol,
                    relationshipKind: 'INSTANTIATES',
                    astNode: node.expression,
                    location: { filePath: handle.sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine }
                }
            });
        } catch (err: any) {
            results.push({
                type: 'unknown',
                unknown: this.buildUnknown(node, handle, 'Target Resolution', err.message)
            });
        }
    }

    private static handleImports(node: ts.ImportDeclaration, sourceSymbol: any, handle: ProgramHandle, results: ResolveResult[]) {
        // Source is usually the SourceFile itself
        const typeChecker = handle.typeChecker!;
        if (node.importClause) {
            if (node.importClause.name) {
                // Default import
                this.emitImport(node.importClause.name, node, sourceSymbol, handle, results);
            }
            if (node.importClause.namedBindings) {
                if (ts.isNamedImports(node.importClause.namedBindings)) {
                    for (const specifier of node.importClause.namedBindings.elements) {
                        this.emitImport(specifier.name, specifier, sourceSymbol, handle, results);
                    }
                } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                    this.emitImport(node.importClause.namedBindings.name, node.importClause.namedBindings, sourceSymbol, handle, results);
                }
            }
        }
    }

    private static handleImportEquals(node: ts.ImportEqualsDeclaration, sourceSymbol: any, handle: ProgramHandle, results: ResolveResult[]) {
        // e.g. import foo = require('bar');
        this.emitImport(node.name, node, sourceSymbol, handle, results);
    }
    private static emitImport(identifier: ts.Identifier, astNode: ts.Node, sourceSymbol: any, handle: ProgramHandle, results: ResolveResult[]) {
        const typeChecker = handle.typeChecker!;
        const sym = typeChecker.getSymbolAtLocation(identifier);
        if (!sym || !sym.declarations || sym.declarations.length === 0) {
            results.push({
                type: 'unknown',
                unknown: this.buildUnknown(astNode, handle, 'Unresolved Import', 'Import symbol cannot be resolved')
            });
            return;
        }

        try {
            const targetSymbol = SymbolResolver.resolve(sym.declarations[0], handle);
            const loc = this.locationMapper.map(astNode, handle.sourceFile);
            results.push({
                type: 'observation',
                observation: {
                    source: sourceSymbol,
                    target: targetSymbol,
                    relationshipKind: 'IMPORTS',
                    astNode: astNode,
                    location: { filePath: handle.sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine }
                }
            });
        } catch (err: any) {
            results.push({
                type: 'unknown',
                unknown: this.buildUnknown(astNode, handle, 'Target Resolution', err.message)
            });
        }
    }

    private static handleHeritage(node: ts.HeritageClause, sourceSymbol: any, handle: ProgramHandle, results: ResolveResult[]) {
        const typeChecker = handle.typeChecker!;
        const isExtends = node.token === ts.SyntaxKind.ExtendsKeyword;
        const kind = isExtends ? 'EXTENDS' : 'IMPLEMENTS';

        for (const type of node.types) {
            const typeType = typeChecker.getTypeAtLocation(type);
            if (!typeType || !typeType.symbol || !typeType.symbol.declarations || typeType.symbol.declarations.length === 0) {
                results.push({
                    type: 'unknown',
                    unknown: this.buildUnknown(type, handle, 'Unresolved Heritage', 'Heritage type cannot be resolved')
                });
                continue;
            }

            try {
                const targetSymbol = SymbolResolver.resolve(typeType.symbol.declarations[0], handle);
                const loc = this.locationMapper.map(type, handle.sourceFile);
                results.push({
                    type: 'observation',
                    observation: {
                        source: sourceSymbol,
                        target: targetSymbol,
                        relationshipKind: kind,
                        astNode: type,
                        location: { filePath: handle.sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine }
                    }
                });
            } catch (err: any) {
                results.push({
                    type: 'unknown',
                    unknown: this.buildUnknown(type, handle, 'Target Resolution', err.message)
                });
            }
        }
    }

    private static handleReferences(node: ts.Identifier, sourceSymbol: any, handle: ProgramHandle, results: ResolveResult[]) {
        const typeChecker = handle.typeChecker!;
        const sym = typeChecker.getSymbolAtLocation(node);
        if (!sym || !sym.declarations || sym.declarations.length === 0) {
            return; // Simple unresolvable identifiers don't need to spam Unknowns for REFERENCES
        }

        try {
            const targetDecl = sym.declarations[0];
            // Do not emit reference if it's the declaration itself
            if (targetDecl === node || targetDecl.parent === node || (targetDecl as any).name === node) {
                return;
            }

            const targetSymbol = SymbolResolver.resolve(targetDecl, handle);
            
            // Only emit REFERENCES if we aren't referencing ourselves
            if (sourceSymbol.symbol !== targetSymbol.symbol) {
                const loc = this.locationMapper.map(node, handle.sourceFile);
                results.push({
                    type: 'observation',
                    observation: {
                        source: sourceSymbol,
                        target: targetSymbol,
                        relationshipKind: 'REFERENCES',
                        astNode: node,
                        location: { filePath: handle.sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine }
                    }
                });
            }
        } catch (err: any) {
            // Don't spam unknowns for basic references
        }
    }

    private static getEnclosingDeclaration(node: ts.Node): ts.Declaration | undefined {
        let current: ts.Node = node;
        // For IMPORTS, the enclosing declaration is the SourceFile
        if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
            return node.getSourceFile();
        }

        while (current) {
            if (this.isDeclaration(current)) {
                return current as ts.Declaration;
            }
            current = current.parent;
        }
        return node.getSourceFile();
    }

    private static isDeclaration(node: ts.Node): boolean {
        return ts.isClassDeclaration(node) ||
               ts.isInterfaceDeclaration(node) ||
               ts.isFunctionDeclaration(node) ||
               ts.isMethodDeclaration(node) ||
               ts.isConstructorDeclaration(node) ||
               ts.isEnumDeclaration(node) ||
               ts.isModuleDeclaration(node) ||
               ts.isTypeAliasDeclaration(node) ||
               ts.isVariableDeclaration(node) && node.parent && ts.isVariableDeclarationList(node.parent) && node.parent.parent && (ts.isVariableStatement(node.parent.parent) || ts.isForStatement(node.parent.parent));
    }

    private static isPartOfOtherRelationship(node: ts.Node): boolean {
        let current = node.parent;
        while (current) {
            if (ts.isCallExpression(current) && current.expression === node) return true;
            if (ts.isNewExpression(current) && current.expression === node) return true;
            if (ts.isImportDeclaration(current) || ts.isImportClause(current) || ts.isImportSpecifier(current)) return true;
            if (ts.isHeritageClause(current) || ts.isExpressionWithTypeArguments(current)) return true;
            if (ts.isPropertyAccessExpression(current) && current.name === node) return true; // Handled by its expression
            if (this.isDeclaration(current) && (current as any).name === node) return true;
            current = current.parent;
        }
        return false;
    }

    private static buildUnknown(node: ts.Node, handle: ProgramHandle, construct: string, reason: string): KnownUnknown {
        const loc = this.locationMapper.map(node, handle.sourceFile);
        return {
            id: `ku-${Date.now()}-${Math.random()}`,
            source: { package: '', logicalNamespace: '', kind: 'unknown', qualifiedName: '', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' },
            sourceLocation: { filePath: handle.sourceFile.fileName, startLine: loc.startLine, endLine: loc.endLine },
            unsupportedConstruct: construct,
            reason: reason,
            evidence: [],
            recommendedHandling: 'Wait for future checkpoint support'
        };
    }
}
