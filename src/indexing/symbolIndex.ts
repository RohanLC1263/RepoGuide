import * as fs from 'fs';
import * as path from 'path';
import { SymbolEntry } from '../store/storeTypes';
import { Logger } from '../context/repositoryContext';
import { CanonicalSymbolIdentity } from './canonicalSymbolIdentity';
import { formatUrn } from './canonicalSymbolIdentityUtils';

const NOISE_SYMBOLS = new Set([
    't', 'i', 'e', 'n', 'x', 'id', 'db', 'fn', 'cb', 'ok', 'el',
    'eq', 'op', 'fs', 'fp', 'ctx', 'req', 'res', 'err', 'msg',
    'key', 'val', 'obj', 'arr', 'str', 'num', 'idx', 'len', 'tmp', 'ref'
]);

export class SymbolIndex {
    // Map of symbol name -> SymbolEntry[]
    private symbolMap: Map<string, SymbolEntry[]> = new Map();
    private canonicalMap: Map<string, SymbolEntry[]> = new Map();
    private logger?: Logger;

    public setLogger(logger: Logger): void {
        this.logger = logger;
    }

    public addSymbols(symbols: SymbolEntry[]): void {
        for (const sym of symbols) {
            if (sym.name.length < 3) {
                continue;
            }
            if (NOISE_SYMBOLS.has(sym.name.toLowerCase())) {
                continue;
            }
            const list = this.symbolMap.get(sym.name) || [];
            list.push(sym);
            this.symbolMap.set(sym.name, list);

            if (sym.canonicalId) {
                const urn = formatUrn(sym.canonicalId);
                const canList = this.canonicalMap.get(urn) || [];
                canList.push(sym);
                this.canonicalMap.set(urn, canList);
            }
        }
    }

    public lookup(query: string | CanonicalSymbolIdentity): SymbolEntry[] {
        if (typeof query === 'string') {
            return this.symbolMap.get(query) || [];
        } else {
            const urn = formatUrn(query);
            return this.canonicalMap.get(urn) || [];
        }
    }

    public lookupFuzzy(name: string): SymbolEntry[] {
        if (!name || name.length < 3) {
            return [];
        }

        const results: SymbolEntry[] = [];
        const seen = new Set<string>();

        const addResults = (resultsList: SymbolEntry[]) => {
            for (const r of resultsList) {
                const uniqueKey = `${r.filePath}:${r.startLine}:${r.endLine}:${r.name}`;
                if (!seen.has(uniqueKey)) {
                    seen.add(uniqueKey);
                    results.push(r);
                }
            }
        };

        // 1. Exact match
        addResults(this.lookup(name));

        // 2. PascalCase -> snake_case
        // "ConversationAgent" -> "conversation_agent"
        // "UserAgent" -> "user_agent"
        const toSnake = name
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
            .toLowerCase();
        if (toSnake !== name) {
            addResults(this.lookup(toSnake));
        }

        // 3. snake_case -> PascalCase
        // "conversation_agent" -> "ConversationAgent"
        if (name.includes('_')) {
            const toPascal = name.split('_')
                .filter(part => part.length > 0)
                .map(part => part[0].toUpperCase() + part.slice(1).toLowerCase())
                .join('');
            if (toPascal !== name) {
                addResults(this.lookup(toPascal));
            }
        }

        // 4. all-lower stripping (e.g. LLMRouter -> llmrouter)
        const allLower = name.toLowerCase().replace(/_/g, '');
        if (allLower !== name) {
            addResults(this.lookup(allLower));
        }

        // 5. NEW: Partial substring match against all symbol names
        // This is the critical fix — allows "visual" to match "VisualGroundingAgent"
        // Only run if no exact/variant matches were found AND the term is meaningful
        // (length > 5 to avoid false positives from short words like "get" or "test")
        if (results.length === 0 && name.length > 5) {
            const nameLower = name.toLowerCase();
            let partialCount = 0;
            for (const [symbolName, entries] of this.symbolMap.entries()) {
                if (partialCount >= 10) break;
                const symbolLower = symbolName.toLowerCase();
                // Match if the search term is a substring of the symbol name AND makes up at least 40% of it
                if (symbolLower.includes(nameLower) && nameLower.length >= symbolLower.length * 0.4) {
                    addResults(entries);
                    partialCount++;
                }
            }
        }

        return results;
    }

    public lookupExact(query: string | CanonicalSymbolIdentity): Array<{ entry: SymbolEntry; confidence: number }> {
        const results: Array<{ entry: SymbolEntry; confidence: number }> = [];

        if (typeof query !== 'string') {
            const urn = formatUrn(query);
            const exactMatches = this.canonicalMap.get(urn) ?? [];
            for (const entry of exactMatches) {
                results.push({ entry, confidence: 1.0 });
            }
            return results;
        }

        const name = query as string;
        const exactMatches = this.symbolMap.get(name) ?? [];
        for (const entry of exactMatches) {
            results.push({ entry, confidence: 1.0 });
        }

        if (results.length === 0) {
            const lower = name.toLowerCase();
            for (const [key, entries] of this.symbolMap.entries()) {
                if (key.toLowerCase() === lower) {
                    for (const entry of entries) {
                        results.push({ entry, confidence: 0.95 });
                    }
                }
            }
        }

        return results;
    }

    public lookupByConceptTokens(tokens: string[]): Array<{ entry: SymbolEntry; confidence: number }> {
        const normalizedTokens = tokens
            .map(token => token.trim())
            .filter(Boolean);
        const scoreMap = new Map<string, { entry: SymbolEntry; hits: number }>();

        for (const token of normalizedTokens) {
            const matches = this.lookupFuzzy(token);
            for (const match of matches) {
                if (match.name.length < 3 || NOISE_SYMBOLS.has(match.name.toLowerCase())) {
                    continue;
                }
                const key = `${match.filePath}:${match.startLine}:${match.endLine}:${match.name}`;
                const existing = scoreMap.get(key);
                if (existing) {
                    existing.hits += 1;
                } else {
                    scoreMap.set(key, { entry: match, hits: 1 });
                }
            }
        }

        const maxHits = Math.max(normalizedTokens.length, 1);
        return Array.from(scoreMap.values())
            .map(item => ({
                entry: item.entry,
                confidence: Math.min(0.9, item.hits / maxHits)
            }))
            .sort((a, b) => b.confidence - a.confidence);
    }

    public async save(repoguideDir: string): Promise<void> {
        try {
            const symbolsPath = path.join(repoguideDir, 'symbols.json');
            const dir = path.dirname(symbolsPath);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            
            const plainObject: Record<string, SymbolEntry[]> = {};
            for (const [key, val] of this.symbolMap.entries()) {
                plainObject[key] = val;
            }
            
            const tempPath = symbolsPath + '.tmp.' + Date.now();
            await fs.promises.writeFile(tempPath, JSON.stringify(plainObject, null, 2), 'utf-8');
            await fs.promises.rename(tempPath, symbolsPath);
            const pySymbolCount = Array.from(this.symbolMap.values())
                .flat()
                .filter(s => s.filePath.endsWith('.py')).length;
            this.logger?.debug(`Python symbols extracted: ${pySymbolCount}`);
        } catch (e) {
            this.logger?.error(`Failed to save symbols.json: ${e}`);
            throw e;
        }
    }

    public async load(repoguideDir: string): Promise<void> {
        try {
            const symbolsPath = path.join(repoguideDir, 'symbols.json');
            if (fs.existsSync(symbolsPath)) {
                const content = await fs.promises.readFile(symbolsPath, 'utf-8');
                const plainObject = JSON.parse(content) as Record<string, SymbolEntry[]>;
                
                this.symbolMap.clear();
                this.canonicalMap.clear();
                for (const [key, val] of Object.entries(plainObject)) {
                    this.symbolMap.set(key, val);
                    for (const sym of val) {
                        if (sym.canonicalId) {
                            const urn = formatUrn(sym.canonicalId);
                            const canList = this.canonicalMap.get(urn) || [];
                            if (!canList.some(existing => existing.filePath === sym.filePath && existing.startLine === sym.startLine)) {
                                canList.push(sym);
                                this.canonicalMap.set(urn, canList);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            this.logger?.error(`Failed to load symbols.json: ${e}`);
            this.symbolMap.clear();
            throw e;
        }
    }

    public removeSymbolsByFile(filePath: string): void {
        for (const [key, symbols] of this.symbolMap.entries()) {
            const filtered = symbols.filter(s => s.filePath !== filePath);
            if (filtered.length === 0) {
                this.symbolMap.delete(key);
            } else {
                this.symbolMap.set(key, filtered);
            }
        }
        for (const [key, symbols] of this.canonicalMap.entries()) {
            const filtered = symbols.filter(s => s.filePath !== filePath);
            if (filtered.length === 0) {
                this.canonicalMap.delete(key);
            } else {
                this.canonicalMap.set(key, filtered);
            }
        }
    }

    public clear(): void {
        this.symbolMap.clear();
        this.canonicalMap.clear();
    }

    public getAllSymbols(): SymbolEntry[] {
        const all: SymbolEntry[] = [];
        for (const symbols of this.symbolMap.values()) {
            all.push(...symbols);
        }

        const seen = new Set<string>();
        return all.filter(sym => {
            const key = `${sym.filePath}:${sym.startLine}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    public getStats(): { totalSymbols: number, totalFiles: number } {
        let totalSymbols = 0;
        const fileSet = new Set<string>();

        for (const symbols of this.symbolMap.values()) {
            totalSymbols += symbols.length;
            for (const sym of symbols) {
                fileSet.add(sym.filePath);
            }
        }

        return {
            totalSymbols,
            totalFiles: fileSet.size
        };
    }

    public hasNoiseSymbols(): boolean {
        for (const [name] of this.symbolMap.entries()) {
            if (name.length < 3 || NOISE_SYMBOLS.has(name.toLowerCase())) {
                return true;
            }
        }
        return false;
    }
}
