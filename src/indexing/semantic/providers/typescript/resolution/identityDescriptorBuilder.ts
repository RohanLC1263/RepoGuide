import * as ts from 'typescript';
import { ResolvedSymbol, IdentityDescriptor, ProgramHandle } from '../internalModels';
import { SignatureHasher } from './signatureHasher';
import { IdentityAuthority } from '../../../../canonicalSymbolIdentity';
import * as path from 'path';

export class IdentityDescriptorBuilder {
    public static build(resolved: ResolvedSymbol, handle: ProgramHandle): IdentityDescriptor {
        if (!handle.typeChecker) {
            throw new Error('TypeChecker is required for IdentityDescriptorBuilder');
        }

        const typeChecker = handle.typeChecker;
        const symbol = resolved.symbol;

        let signatureHash = '';
        if (resolved.signature) {
            signatureHash = SignatureHasher.hashSignature(resolved.signature, typeChecker, this.isStatic(symbol));
        } else {
            // Hash the type instead if it's not a function/method
            const type = typeChecker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration || symbol.declarations?.[0] as ts.Node);
            signatureHash = SignatureHasher.hashType(type, typeChecker);
        }

        let symbolKind = 'unknown';
        if (symbol.flags & ts.SymbolFlags.Class) symbolKind = 'class';
        else if (symbol.flags & ts.SymbolFlags.Interface) symbolKind = 'interface';
        else if (symbol.flags & ts.SymbolFlags.Function) symbolKind = 'function';
        else if (symbol.flags & ts.SymbolFlags.Method) symbolKind = 'method';
        else if (symbol.flags & ts.SymbolFlags.Variable) symbolKind = 'variable';
        else if (symbol.flags & ts.SymbolFlags.Enum) symbolKind = 'enum';
        else if (symbol.flags & ts.SymbolFlags.TypeAlias) symbolKind = 'type_alias';
        else if (symbol.flags & ts.SymbolFlags.Namespace) symbolKind = 'namespace';

        let qualifiedName = typeChecker.getFullyQualifiedName(symbol);
        
        // Strip out the file path prefix that getFullyQualifiedName often includes (e.g. `"file/path".Name`)
        if (qualifiedName.startsWith('"')) {
            const closingQuote = qualifiedName.indexOf('"', 1);
            if (closingQuote !== -1) {
                qualifiedName = qualifiedName.substring(closingQuote + 1);
                if (qualifiedName.startsWith('.')) {
                    qualifiedName = qualifiedName.substring(1);
                }
            }
        }

        // Clean up the name for default exports
        if (symbol.escapedName === ts.InternalSymbolName.Default) {
            qualifiedName = 'default';
        }

        let pkg = 'unknown';
        let logicalNamespace = 'unknown';

        const declarations = symbol.declarations;
        if (declarations && declarations.length > 0) {
            const sourceFile = declarations[0].getSourceFile();
            const filePath = sourceFile.fileName;
            
            // Normalize path to posix
            const normalizedPath = filePath.split(path.sep).join(path.posix.sep);
            logicalNamespace = normalizedPath;

            // Basic package extraction for node_modules
            if (normalizedPath.includes('node_modules/')) {
                const parts = normalizedPath.split('node_modules/');
                const pkgPath = parts[parts.length - 1];
                const pkgParts = pkgPath.split('/');
                if (pkgParts[0].startsWith('@')) {
                    pkg = `${pkgParts[0]}/${pkgParts[1]}`;
                } else {
                    pkg = pkgParts[0];
                }
            } else {
                pkg = 'workspace'; // or extract from package.json
            }
        }

        const identityAuthority: IdentityAuthority = 'compiler';

        return {
            package: pkg,
            logicalNamespace: logicalNamespace,
            qualifiedName: qualifiedName,
            symbolKind: symbolKind,
            signatureHash: signatureHash,
            identityOrigin: resolved.origin,
            identityAuthority: identityAuthority
        };
    }

    private static isStatic(symbol: ts.Symbol): boolean {
        if (!symbol.valueDeclaration) return false;
        const modifiers = ts.canHaveModifiers(symbol.valueDeclaration) ? ts.getModifiers(symbol.valueDeclaration) : undefined;
        if (!modifiers) return false;
        return modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
    }
}
