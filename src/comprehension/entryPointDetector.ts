import * as fs from 'fs';
import * as path from 'path';
import { FileUnderstanding, LexicalMap, LexicalSymbol } from './types';
import { DecoratorMap, InheritanceMap } from './typeDecoratorInheritanceBuilders';

export type EntryPointType = 
    | 'http_route' 
    | 'cli' 
    | 'background_task' 
    | 'event_handler' 
    | 'service_method' 
    | 'test';

export interface EntryPoint {
    id: string;
    type: EntryPointType;
    relativePath: string;
    symbol: string;
    startLine: number;
    httpMethod: string | null;
    routePath: string | null;
    detectionSource: 'decorator' | 'pattern' | 'naming' | 'file_understanding';
    confidence: number;
}

export interface EntryPointsIndex {
    schemaVersion: '1.0';
    detectedAt: string;
    entryPoints: EntryPoint[];
    stats: {
        total: number;
        byType: Record<string, number>;
    };
}

export class EntryPointDetector {
    private entryPoints: EntryPoint[] = [];

    constructor(
        private projectRoot: string,
        private lexicalMap: LexicalMap,
        private decoratorMap: DecoratorMap | null,
        private inheritanceMap: InheritanceMap | null,
        private fileUnderstandings: Map<string, FileUnderstanding>,
        private outputChannel?: { appendLine(msg: string): void }
    ) {}

    public detect(): EntryPointsIndex {
        // Run all 7 strategies
        this.detectDecoratorRoutesAndTasks();
        this.detectPatternBasedRoutes();
        this.detectCliEntryPoints();
        this.detectInheritanceBackgroundTasks();
        this.detectEventHandlers();
        this.detectServiceOrchestrators();
        this.detectTests();

        const byType: Record<string, number> = {};
        for (const ep of this.entryPoints) {
            byType[ep.type] = (byType[ep.type] || 0) + 1;
        }

        if (this.outputChannel) {
            const parts = Object.entries(byType)
                .map(([type, count]) => `${count} ${type}s`)
                .join(', ');
            this.outputChannel.appendLine(`[Info] Entry points: ${this.entryPoints.length} detected (${parts})`);
        }

        return {
            schemaVersion: '1.0',
            detectedAt: new Date().toISOString(),
            entryPoints: this.entryPoints,
            stats: {
                total: this.entryPoints.length,
                byType
            }
        };
    }

    private add(ep: Omit<EntryPoint, 'id'>) {
        const id = `${ep.relativePath}:${ep.symbol}:${ep.startLine}:${ep.type}`;
        if (!this.entryPoints.some(existing => existing.id === id)) {
            this.entryPoints.push({ id, ...ep });
        }
    }

    // 1. FastAPI Routes & 4. Scheduled tasks (decorators)
    private detectDecoratorRoutesAndTasks() {
        if (!this.decoratorMap) return;
        for (const [relPath, fileMap] of Object.entries(this.decoratorMap.files)) {
            for (const [symbolName, info] of Object.entries(fileMap)) {
                for (const dec of info.decorators) {
                    const lexSymbol = this.findSymbol(relPath, symbolName);
                    if (!lexSymbol) continue;

                    if (dec.inferredRole === 'route') {
                        // Extract method and path
                        const match = dec.decoratorName.match(/\.(get|post|put|delete|patch|options|head)$/i);
                        const method = match ? match[1].toUpperCase() : null;
                        const routePath = dec.decoratorArgs[0]?.replace(/['"]/g, '') || null;

                        this.add({
                            type: 'http_route',
                            relativePath: relPath,
                            symbol: symbolName,
                            startLine: lexSymbol.startLine,
                            httpMethod: method,
                            routePath: routePath,
                            detectionSource: 'decorator',
                            confidence: 0.95
                        });
                    } else if (dec.inferredRole === 'task' || dec.decoratorName.includes('task')) {
                        this.add({
                            type: 'background_task',
                            relativePath: relPath,
                            symbol: symbolName,
                            startLine: lexSymbol.startLine,
                            httpMethod: null,
                            routePath: null,
                            detectionSource: 'decorator',
                            confidence: 0.95
                        });
                    }
                }
            }
        }
    }

    // 2. Express/Fastify routes (pattern)
    private detectPatternBasedRoutes() {
        for (const [fileKey, entry] of Object.entries(this.lexicalMap.files)) {
            const relPath = this.toRel(fileKey);
            const lines = this.readLines(relPath);

            if (entry.language === 'python') {
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    const match = line.match(/^@(app|router)\.(get|post|put|delete|patch|options|head)\s*\(\s*(['"])([^'"]+)\3/);
                    if (!match) {
                        continue;
                    }
                    const symbol = this.findNextFunctionSymbol(entry.symbols, i + 1);
                    this.add({
                        type: 'http_route',
                        relativePath: relPath,
                        symbol: symbol?.name ?? '<decorated_route>',
                        startLine: symbol?.startLine ?? i + 1,
                        httpMethod: match[2].toUpperCase(),
                        routePath: match[4],
                        detectionSource: 'pattern',
                        confidence: 0.90
                    });
                }
                continue;
            }

            if (!['javascript', 'typescript'].includes(entry.language)) continue;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.includes('createRoot(') || line.match(/\bReactDOM\.render\s*\(/)) {
                    this.add({
                        type: 'event_handler',
                        relativePath: relPath,
                        symbol: 'react_render',
                        startLine: i + 1,
                        httpMethod: null,
                        routePath: null,
                        detectionSource: 'pattern',
                        confidence: 0.85
                    });
                }
                const match = line.match(/\b(app|router)\.(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]+)\3/);
                if (match) {
                    this.add({
                        type: 'http_route',
                        relativePath: relPath,
                        symbol: '<anonymous_route>',
                        startLine: i + 1,
                        httpMethod: match[2].toUpperCase(),
                        routePath: match[4],
                        detectionSource: 'pattern',
                        confidence: 0.90
                    });
                }
            }
        }
    }

    private findNextFunctionSymbol(symbols: LexicalSymbol[], decoratorLine: number): LexicalSymbol | null {
        return symbols
            .filter(symbol =>
                (symbol.kind === 'function' || symbol.kind === 'method') &&
                symbol.startLine > decoratorLine
            )
            .sort((a, b) => a.startLine - b.startLine)[0] ?? null;
    }

    // 3. CLI Entry Points
    private detectCliEntryPoints() {
        for (const [fileKey, entry] of Object.entries(this.lexicalMap.files)) {
            const relPath = this.toRel(fileKey);
            const lines = this.readLines(relPath);

            if (entry.language === 'python') {
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('if __name__ == "__main__":') || lines[i].includes("if __name__ == '__main__':")) {
                        this.add({
                            type: 'cli',
                            relativePath: relPath,
                            symbol: '__main__',
                            startLine: i + 1,
                            httpMethod: null,
                            routePath: null,
                            detectionSource: 'pattern',
                            confidence: 0.90
                        });
                        break;
                    }
                }
            } else if (['javascript', 'typescript'].includes(entry.language)) {
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('process.argv') || lines[i].includes('commander') || lines[i].includes('yargs')) {
                        this.add({
                            type: 'cli',
                            relativePath: relPath,
                            symbol: 'cli_entry',
                            startLine: i + 1,
                            httpMethod: null,
                            routePath: null,
                            detectionSource: 'pattern',
                            confidence: 0.90
                        });
                        break;
                    }
                }
            }

            // Click/Typer decorators
            if (this.decoratorMap && this.decoratorMap.files[relPath]) {
                for (const [symbolName, info] of Object.entries(this.decoratorMap.files[relPath])) {
                    for (const dec of info.decorators) {
                        if (dec.decoratorName === 'click.command' || dec.decoratorName === 'typer.command' || dec.decoratorName.endsWith('.command')) {
                            const lexSymbol = this.findSymbol(relPath, symbolName);
                            if (lexSymbol) {
                                this.add({
                                    type: 'cli',
                                    relativePath: relPath,
                                    symbol: symbolName,
                                    startLine: lexSymbol.startLine,
                                    httpMethod: null,
                                    routePath: null,
                                    detectionSource: 'decorator',
                                    confidence: 0.95
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Scheduled tasks (inheritance)
    private detectInheritanceBackgroundTasks() {
        if (!this.inheritanceMap) return;
        const taskBases = ['Worker', 'BaseTask', 'Task', 'CeleryTask'];

        for (const [fileKey, entry] of Object.entries(this.lexicalMap.files)) {
            const relPath = this.toRel(fileKey);
            for (const sym of entry.symbols) {
                if (sym.kind === 'class') {
                    const classInfo = this.inheritanceMap.classes[`${relPath}:${sym.name}`];
                    if (classInfo && classInfo.parents.some(p => taskBases.includes(p))) {
                        const methods = entry.symbols.filter(s => s.containerName === sym.name && ['run', 'execute', 'process'].includes(s.name));
                        for (const m of methods) {
                            this.add({
                                type: 'background_task',
                                relativePath: relPath,
                                symbol: `${sym.name}.${m.name}`,
                                startLine: m.startLine,
                                httpMethod: null,
                                routePath: null,
                                detectionSource: 'pattern',
                                confidence: 0.90
                            });
                        }
                    }
                }
            }
        }
    }

    // 5. Event handlers
    private detectEventHandlers() {
        if (this.decoratorMap) {
            for (const [relPath, fileMap] of Object.entries(this.decoratorMap.files)) {
                for (const [symbolName, info] of Object.entries(fileMap)) {
                    for (const dec of info.decorators) {
                        if (dec.inferredRole === 'event_handler' || dec.decoratorName.includes('on_event') || dec.decoratorName.endsWith('.on')) {
                            const lexSymbol = this.findSymbol(relPath, symbolName);
                            if (lexSymbol) {
                                this.add({
                                    type: 'event_handler',
                                    relativePath: relPath,
                                    symbol: symbolName,
                                    startLine: lexSymbol.startLine,
                                    httpMethod: null,
                                    routePath: null,
                                    detectionSource: 'decorator',
                                    confidence: 0.95
                                });
                            }
                        }
                    }
                }
            }
        }

        for (const [fileKey, entry] of Object.entries(this.lexicalMap.files)) {
            if (!['javascript', 'typescript'].includes(entry.language)) continue;
            const relPath = this.toRel(fileKey);
            const lines = this.readLines(relPath);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(/\b(addEventListener|on)\s*\(/)) {
                    this.add({
                        type: 'event_handler',
                        relativePath: relPath,
                        symbol: '<anonymous_event_handler>',
                        startLine: i + 1,
                        httpMethod: null,
                        routePath: null,
                        detectionSource: 'pattern',
                        confidence: 0.90
                    });
                }
            }
        }
    }

    // 6. Service orchestrator entry points
    private detectServiceOrchestrators() {
        for (const [relPath, fu] of this.fileUnderstandings.entries()) {
            if (fu.domainRole === 'orchestrator' || fu.domainRole === 'service') {
                const lexFile = this.lexicalMap.files[relPath] 
                    ?? Object.entries(this.lexicalMap.files).find(([k]) => k.replace(/\\/g, '/') === relPath)?.[1];
                if (!lexFile) continue;

                for (const sym of lexFile.symbols) {
                    if (sym.kind === 'method' || sym.kind === 'function') {
                        const name = sym.name;
                        if (name.startsWith('run') || name.startsWith('execute') || name.startsWith('process') || name.startsWith('start')) {
                            this.add({
                                type: 'service_method',
                                relativePath: relPath,
                                symbol: sym.containerName ? `${sym.containerName}.${name}` : name,
                                startLine: sym.startLine,
                                httpMethod: null,
                                routePath: null,
                                detectionSource: 'file_understanding',
                                confidence: 0.75
                            });
                        }
                    }
                }
            }
        }
    }

    // 7. Test entry points
    private detectTests() {
        for (const [fileKey, entry] of Object.entries(this.lexicalMap.files)) {
            const relPath = this.toRel(fileKey);
            for (const sym of entry.symbols) {
                if (sym.kind === 'function' && sym.name.startsWith('test_')) {
                    this.add({
                        type: 'test',
                        relativePath: relPath,
                        symbol: sym.name,
                        startLine: sym.startLine,
                        httpMethod: null,
                        routePath: null,
                        detectionSource: 'naming',
                        confidence: 0.70
                    });
                } else if (sym.kind === 'class' && sym.name.startsWith('Test')) {
                    this.add({
                        type: 'test',
                        relativePath: relPath,
                        symbol: sym.name,
                        startLine: sym.startLine,
                        httpMethod: null,
                        routePath: null,
                        detectionSource: 'naming',
                        confidence: 0.70
                    });
                }
            }
        }
    }

    private toRel(fileKey: string): string {
        return path.isAbsolute(fileKey) ? path.relative(this.projectRoot, fileKey).replace(/\\/g, '/') : fileKey.replace(/\\/g, '/');
    }

    private readLines(relPath: string): string[] {
        try {
            return fs.readFileSync(path.join(this.projectRoot, relPath), 'utf8').split(/\r?\n/);
        } catch {
            return [];
        }
    }

    private findSymbol(relPath: string, symbolKey: string): LexicalSymbol | null {
        const entry = this.lexicalMap.files[relPath] 
            ?? Object.entries(this.lexicalMap.files).find(([k]) => k.replace(/\\/g, '/') === relPath)?.[1];
        if (!entry) return null;
        return entry.symbols.find(s => (s.containerName ? `${s.containerName}.${s.name}` : s.name) === symbolKey) || null;
    }
}
