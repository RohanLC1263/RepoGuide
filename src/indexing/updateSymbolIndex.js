const fs = require('fs');

let content = fs.readFileSync('C:/Projects/RepoGuide/src/indexing/symbolIndex.ts', 'utf8');

content = content.replace("import { Logger } from '../context/repositoryContext';",
    "import { Logger } from '../context/repositoryContext';\nimport { CanonicalSymbolIdentity } from './canonicalSymbolIdentity';\nimport { formatUrn } from './canonicalSymbolIdentityUtils';");

content = content.replace("private symbolMap: Map<string, SymbolEntry[]> = new Map();",
    "private symbolMap: Map<string, SymbolEntry[]> = new Map();\n    private canonicalMap: Map<string, SymbolEntry[]> = new Map();");

const addSymbolsOld = `    public addSymbols(symbols: SymbolEntry[]): void {
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
        }
    }`;
const addSymbolsNew = `    public addSymbols(symbols: SymbolEntry[]): void {
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
    }`;
content = content.replace(addSymbolsOld, addSymbolsNew);

const lookupOld = `    public lookup(name: string): SymbolEntry[] {
        return this.symbolMap.get(name) || [];
    }`;
const lookupNew = `    public lookup(query: string | CanonicalSymbolIdentity): SymbolEntry[] {
        if (typeof query === 'string') {
            return this.symbolMap.get(query) || [];
        } else {
            const urn = formatUrn(query);
            return this.canonicalMap.get(urn) || [];
        }
    }`;
content = content.replace(lookupOld, lookupNew);

const lookupExactOld = `    public lookupExact(name: string): Array<{ entry: SymbolEntry; confidence: number }> {
        const results: Array<{ entry: SymbolEntry; confidence: number }> = [];

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
    }`;
const lookupExactNew = `    public lookupExact(query: string | CanonicalSymbolIdentity): Array<{ entry: SymbolEntry; confidence: number }> {
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
    }`;
content = content.replace(lookupExactOld, lookupExactNew);


const loadOld = `                this.symbolMap.clear();
                for (const [key, val] of Object.entries(plainObject)) {
                    this.symbolMap.set(key, val);
                }`;
const loadNew = `                this.symbolMap.clear();
                this.canonicalMap.clear();
                for (const [key, val] of Object.entries(plainObject)) {
                    this.symbolMap.set(key, val);
                    for (const sym of val) {
                        if (sym.canonicalId) {
                            const urn = formatUrn(sym.canonicalId);
                            const canList = this.canonicalMap.get(urn) || [];
                            // Avoid duplicates just in case
                            if (!canList.some(existing => existing.filePath === sym.filePath && existing.startLine === sym.startLine)) {
                                canList.push(sym);
                                this.canonicalMap.set(urn, canList);
                            }
                        }
                    }
                }`;
content = content.replace(loadOld, loadNew);

const removeOld = `    public removeSymbolsByFile(filePath: string): void {
        for (const [key, symbols] of this.symbolMap.entries()) {
            const filtered = symbols.filter(s => s.filePath !== filePath);
            if (filtered.length === 0) {
                this.symbolMap.delete(key);
            } else {
                this.symbolMap.set(key, filtered);
            }
        }
    }`;
const removeNew = `    public removeSymbolsByFile(filePath: string): void {
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
    }`;
content = content.replace(removeOld, removeNew);

const clearOld = `    public clear(): void {
        this.symbolMap.clear();
    }`;
const clearNew = `    public clear(): void {
        this.symbolMap.clear();
        this.canonicalMap.clear();
    }`;
content = content.replace(clearOld, clearNew);

fs.writeFileSync('C:/Projects/RepoGuide/src/indexing/symbolIndex.ts', content, 'utf8');
