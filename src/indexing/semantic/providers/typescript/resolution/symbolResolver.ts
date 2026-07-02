import * as ts from 'typescript';
import { ResolvedSymbol, ProgramHandle } from '../internalModels';
import { AliasResolver } from './aliasResolver';
import { IdentityOrigin } from '../../../../canonicalSymbolIdentity';

export class SymbolResolver {
    public static resolve(node: ts.Declaration, handle: ProgramHandle): ResolvedSymbol {
        if (!handle.typeChecker) {
            throw new Error('TypeChecker is required for SymbolResolver');
        }

        const typeChecker = handle.typeChecker;

        let symbol = typeChecker.getSymbolAtLocation((node as any).name || node);
        if (!symbol) {
            // Might be an anonymous default export without a name node
            if (ts.isExportAssignment(node) || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword))) {
                // For default exports without names, try to get the symbol of the node itself
                symbol = typeChecker.getSymbolAtLocation(node);
                if (!symbol) {
                    // Try to get type
                    const type = typeChecker.getTypeAtLocation(node);
                    symbol = type.symbol;
                }
            }
        }

        if (!symbol) {
            throw new Error('Unable to resolve symbol for node');
        }

        // Check if the symbol is in the cache
        if (handle.resolutionCache && handle.resolutionCache.has(symbol)) {
            return handle.resolutionCache.get(symbol)!;
        }

        const resolvedSymbol = AliasResolver.resolve(symbol, typeChecker);
        
        // Determine Origin
        const origin = this.determineOrigin(resolvedSymbol, typeChecker, handle);

        let signature: ts.Signature | undefined;
        if (ts.isFunctionLike(node)) {
            signature = typeChecker.getSignatureFromDeclaration(node as ts.SignatureDeclaration);
        }

        const result: ResolvedSymbol = {
            symbol: resolvedSymbol,
            signature,
            origin
        };

        if (handle.resolutionCache) {
            handle.resolutionCache.set(symbol, result);
        }

        return result;
    }

    private static determineOrigin(symbol: ts.Symbol, typeChecker: ts.TypeChecker, handle: ProgramHandle): IdentityOrigin {
        const declarations = symbol.declarations;
        if (!declarations || declarations.length === 0) {
            return 'Synthetic';
        }

        const sourceFile = declarations[0].getSourceFile();
        const filePath = sourceFile.fileName;

        if (sourceFile.isDeclarationFile) {
            if (filePath.includes('node_modules/typescript/lib')) {
                return 'Builtin';
            }
            if (filePath.includes('node_modules')) {
                return 'ExternalDependency';
            }
            return 'Ambient';
        }

        return 'Repository';
    }
}
