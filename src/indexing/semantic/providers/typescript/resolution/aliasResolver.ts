import * as ts from 'typescript';

export class AliasResolver {
    /**
     * Resolves an aliased symbol to its true defining symbol.
     * Includes recursion protection.
     */
    public static resolve(symbol: ts.Symbol, typeChecker: ts.TypeChecker): ts.Symbol {
        let currentSymbol = symbol;
        const visited = new Set<ts.Symbol>();

        while (currentSymbol.flags & ts.SymbolFlags.Alias) {
            if (visited.has(currentSymbol)) {
                // Cycle detected, break out and return the last safe symbol or throw?
                // The architecture says: "If a cycle or otherwise unresolvable alias chain is encountered, resolution must stop and emit the appropriate KnownUnknown or ProviderDiagnostic"
                // Actually, throwing an error here is fine, the caller (SymbolResolver) can catch it and emit ProviderDiagnostic.
                throw new Error(`Alias cycle detected for symbol: ${currentSymbol.name}`);
            }
            visited.add(currentSymbol);

            const aliased = typeChecker.getAliasedSymbol(currentSymbol);
            if (!aliased) {
                // Unresolvable (e.g. missing ambient type)
                throw new Error(`Unresolvable alias for symbol: ${currentSymbol.name}`);
            }
            currentSymbol = aliased;
        }

        return currentSymbol;
    }
}
