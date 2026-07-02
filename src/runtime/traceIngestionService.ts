import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { unwrapArtifact, wrapArtifact } from '../comprehension/schema-versions';
import { openDatabase } from '../store/sqliteLoader';

export type TraceFormat = 'pytest' | 'coverage' | 'otel' | 'log' | 'manual';

export interface RuntimeTraceEndpoint {
    relativePath: string | null;
    symbol: string | null;
}

export interface RuntimeEdge {
    from: RuntimeTraceEndpoint;
    to: RuntimeTraceEndpoint;
    source: TraceFormat;
    confidence: number;
    observedCount: number;
}

export interface RuntimeTracesSchema {
    schemaVersion: '1.0';
    ingestedAt: string;
    traceFormat: TraceFormat | null;
    runtimeEdges: RuntimeEdge[];
    verifiedLines: Record<string, number[]>;
    ingestStats: {
        edgesAdded: number;
        filesVerified: number;
        parseErrors: number;
    };
}

export interface IngestResult {
    edgesAdded: number;
    filesVerified: number;
    errors: number;
}

interface ParsedTrace {
    edges: RuntimeEdge[];
    verifiedLines: Record<string, number[]>;
    errors: number;
}

type OutputLogger = { appendLine(message: string): void; show?: (preserveFocus?: boolean) => void };

interface BetterSqliteDatabase {
    prepare(source: string): { all(...params: unknown[]): any[] };
    close(): void;
}

export class TraceIngestionService implements vscode.Disposable {
    private readonly commandDisposable: vscode.Disposable;

    constructor(
        private readonly workspaceRoot: string,
        private readonly understandingDir: string,
        private readonly outputChannel?: OutputLogger
    ) {
        this.commandDisposable = vscode.commands.registerCommand(
            'repoguide.importTrace',
            async (traceFilePath?: string, format?: TraceFormat) => {
                await this.runImportCommand(traceFilePath, format);
            }
        );
    }

    dispose(): void {
        this.commandDisposable.dispose();
    }

    public async ingest(traceFilePath: string, format: TraceFormat): Promise<IngestResult> {
        const result: IngestResult = { edgesAdded: 0, filesVerified: 0, errors: 0 };
        const existing = this.loadExistingTraces();
        const parsed = await this.parseTrace(traceFilePath, format);

        result.errors = parsed.errors;
        result.edgesAdded = mergeRuntimeEdges(existing, parsed.edges);
        result.filesVerified = mergeVerifiedLines(existing, parsed.verifiedLines);

        existing.ingestedAt = new Date().toISOString();
        existing.traceFormat = format;
        existing.ingestStats.edgesAdded += result.edgesAdded;
        existing.ingestStats.filesVerified += result.filesVerified;
        existing.ingestStats.parseErrors += result.errors;

        this.writeRuntimeTraces(existing);
        this.updateLexicalMapRuntimeVerification(existing.verifiedLines);

        this.outputChannel?.appendLine(
            `[Info] Trace ingested successfully. Edges added: ${result.edgesAdded}, ` +
            `Files verified: ${result.filesVerified}, Errors: ${result.errors}`
        );

        await vscode.commands.executeCommand('repoguide.reconcileRuntimeTraces').then(undefined, () => {
            this.outputChannel?.appendLine('[Info] Runtime trace reconciliation command not available yet; ingestion artifact is ready for Phase 10.2.');
        });
        return result;
    }

    private async runImportCommand(traceFilePath?: string, format?: TraceFormat): Promise<void> {
        this.outputChannel?.show?.(true);

        const selectedPath = traceFilePath ?? await this.pickTraceFile();
        if (!selectedPath) {
            return;
        }

        const selectedFormat = format ?? await this.pickTraceFormat();
        if (!selectedFormat) {
            return;
        }

        this.outputChannel?.appendLine(
            `[Info] TraceIngestion: importing ${selectedPath} as ${selectedFormat}. ` +
            'Trace ingestion is opt-in and never executes the selected file.'
        );

        try {
            await this.ingest(selectedPath, selectedFormat);
        } catch (error) {
            this.outputChannel?.appendLine(`[Warn] TraceIngestionService: import failed - ${String(error)}`);
            await vscode.window.showErrorMessage(`RepoGuide: failed to import trace: ${String(error)}`);
        }
    }

    private async pickTraceFile(): Promise<string | null> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Import Execution Trace',
            filters: {
                'Trace files': ['json', 'log', 'txt', 'coverage'],
                'All files': ['*']
            }
        });
        return uris?.[0]?.fsPath ?? null;
    }

    private async pickTraceFormat(): Promise<TraceFormat | null> {
        const selected = await vscode.window.showQuickPick([
            { label: 'Pytest trace', description: 'pytest --tb=long output or pytest-json-report', value: 'pytest' as const },
            { label: 'Coverage.py', description: '.coverage SQLite file or coverage.json', value: 'coverage' as const },
            { label: 'OpenTelemetry JSON', description: 'JSON spans export', value: 'otel' as const },
            { label: 'Application log', description: 'Plain text log matched against lexical symbols', value: 'log' as const },
            { label: 'Manual RepoGuide JSON', description: '{ "calls": [{ "caller": "...", "callee": "..." }] }', value: 'manual' as const }
        ], {
            placeHolder: 'Select trace format'
        });

        return selected?.value ?? null;
    }

    private async parseTrace(traceFilePath: string, format: TraceFormat): Promise<ParsedTrace> {
        if (!fs.existsSync(traceFilePath)) {
            throw new Error(`trace file does not exist: ${traceFilePath}`);
        }

        if (format === 'coverage' && path.basename(traceFilePath) === '.coverage') {
            return this.parseCoverageDatabase(traceFilePath);
        }

        const content = await fs.promises.readFile(traceFilePath, 'utf8');
        switch (format) {
            case 'pytest':
                return this.parsePytest(content);
            case 'coverage':
                return this.parseCoverageJson(content);
            case 'otel':
                return this.parseOpenTelemetry(content);
            case 'log':
                return this.parseApplicationLog(content);
            case 'manual':
                return this.parseManualTrace(content);
        }
    }

    private parsePytest(content: string): ParsedTrace {
        const parsed = emptyParsedTrace();
        const json = parseJson<any>(content);
        if (json) {
            const tests = Array.isArray(json.tests)
                ? json.tests
                : Array.isArray(json.report?.tests) ? json.report.tests : [];

            if (tests.length === 0) {
                parsed.errors += 1;
                return parsed;
            }

            for (const test of tests) {
                const { relativePath, symbol } = parsePytestNodeId(test.nodeid);
                const traceback = test.call?.traceback ?? test.setup?.traceback ?? test.teardown?.traceback ?? [];
                let previous: RuntimeTraceEndpoint = { relativePath, symbol };
                for (const frame of traceback) {
                    const next = {
                        relativePath: this.normalizeTracePath(frame.path ?? frame.file ?? frame.filename),
                        symbol: stringOrNull(frame.name ?? frame.function)
                    };
                    if (next.relativePath || next.symbol) {
                        parsed.edges.push(makeEdge(previous, next, 'pytest', 0.8));
                        previous = next;
                    }
                }
                if (test.outcome === 'failed' && test.call?.crash) {
                    const crash = test.call.crash;
                    parsed.edges.push(makeEdge(
                        { relativePath, symbol },
                        {
                            relativePath: this.normalizeTracePath(crash.path),
                            symbol: stringOrNull(crash.message?.split(':')?.[0] ?? 'exception')
                        },
                        'pytest',
                        0.7
                    ));
                }
            }
            return parsed;
        }

        const frameRegex = /File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+([A-Za-z_][\w.]*)/g;
        const exceptionRegex = /^\s*([A-Za-z_][\w.]*Error|[A-Za-z_][\w.]*Exception)\b/gm;
        let currentTest: RuntimeTraceEndpoint = { relativePath: null, symbol: null };
        let previous: RuntimeTraceEndpoint | null = null;
        let match: RegExpExecArray | null;

        while ((match = frameRegex.exec(content)) !== null) {
            const endpoint = {
                relativePath: this.normalizeTracePath(match[1]),
                symbol: match[3]
            };
            if (match[3].startsWith('test_')) {
                currentTest = endpoint;
                previous = endpoint;
                continue;
            }
            parsed.edges.push(makeEdge(previous ?? currentTest, endpoint, 'pytest', 0.75));
            previous = endpoint;
        }

        while ((match = exceptionRegex.exec(content)) !== null) {
            parsed.edges.push(makeEdge(previous ?? currentTest, { relativePath: null, symbol: match[1] }, 'pytest', 0.65));
        }

        if (parsed.edges.length === 0) {
            parsed.errors += 1;
        }
        return parsed;
    }

    private parseCoverageJson(content: string): ParsedTrace {
        const parsed = emptyParsedTrace();
        const json = parseJson<any>(content);
        if (!json?.files || typeof json.files !== 'object') {
            parsed.errors += 1;
            return parsed;
        }

        for (const [filePath, info] of Object.entries<any>(json.files)) {
            const relativePath = this.normalizeTracePath(filePath);
            const executedLines = toNumberArray(info.executed_lines ?? info.executedLines);
            if (!relativePath || executedLines.length === 0) {
                continue;
            }
            parsed.verifiedLines[relativePath] = executedLines;
        }
        return parsed;
    }

    private parseCoverageDatabase(traceFilePath: string): ParsedTrace {
        const parsed = emptyParsedTrace();

        let db: BetterSqliteDatabase | null = null;
        try {
            db = openDatabase(traceFilePath, { readonly: true }) as unknown as BetterSqliteDatabase;
            const files = db.prepare('select id, path from file').all() as Array<{ id: number; path: string }>;
            const lineBits = db.prepare('select file_id, numbits from line_bits').all() as Array<{ file_id: number; numbits: Buffer }>;
            const fileById = new Map(files.map(file => [file.id, this.normalizeTracePath(file.path)]));
            for (const row of lineBits) {
                const relativePath = fileById.get(row.file_id);
                if (!relativePath) {
                    continue;
                }
                const lines = decodeCoverageNumbits(row.numbits);
                if (lines.length > 0) {
                    parsed.verifiedLines[relativePath] = lines;
                }
            }
        } catch (error) {
            this.outputChannel?.appendLine(`[Warn] TraceIngestion: failed to parse .coverage database - ${String(error)}`);
            parsed.errors += 1;
        } finally {
            db?.close();
        }

        return parsed;
    }

    private parseOpenTelemetry(content: string): ParsedTrace {
        const parsed = emptyParsedTrace();
        const json = parseJson<any>(content);
        if (!json) {
            parsed.errors += 1;
            return parsed;
        }

        const spans = collectOtelSpans(json);
        if (spans.length === 0) {
            parsed.errors += 1;
            return parsed;
        }

        const bySpanId = new Map<string, any>();
        for (const span of spans) {
            const id = stringOrNull(span.spanId ?? span.context?.span_id ?? span.span_id);
            if (id) {
                bySpanId.set(id, span);
            }
        }

        for (const span of spans) {
            const parentId = stringOrNull(span.parentSpanId ?? span.parent_span_id ?? span.parentId);
            const parent = parentId ? bySpanId.get(parentId) : null;
            if (!parent) {
                continue;
            }
            parsed.edges.push(makeEdge(
                endpointFromSpan(parent, this.normalizeTracePath.bind(this)),
                endpointFromSpan(span, this.normalizeTracePath.bind(this)),
                'otel',
                0.85
            ));
        }

        return parsed;
    }

    private parseApplicationLog(content: string): ParsedTrace {
        const parsed = emptyParsedTrace();
        const lexicalMap = this.readArtifact<any>('lexical_map.json');
        const knownSymbols: RuntimeTraceEndpoint[] = [];

        for (const [fileKey, entry] of Object.entries<any>(lexicalMap?.files ?? {})) {
            const relativePath = this.normalizeTracePath(entry.filePath ?? fileKey);
            for (const symbol of entry.symbols ?? []) {
                if (typeof symbol.name === 'string' && symbol.name.length >= 4) {
                    knownSymbols.push({ relativePath, symbol: symbol.name });
                }
            }
        }

        if (knownSymbols.length === 0) {
            parsed.errors += 1;
            return parsed;
        }

        const observed = new Set<string>();
        for (const line of content.split(/\r?\n/)) {
            for (const known of knownSymbols) {
                const symbol = known.symbol;
                if (!symbol) {
                    continue;
                }
                const pattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
                if (pattern.test(line)) {
                    const key = `${known.relativePath}:${symbol}`;
                    if (!observed.has(key)) {
                        parsed.edges.push(makeEdge(
                            { relativePath: null, symbol: 'log_entry' },
                            known,
                            'log',
                            0.55
                        ));
                        observed.add(key);
                    }
                }
            }
        }

        return parsed;
    }

    private parseManualTrace(content: string): ParsedTrace {
        const parsed = emptyParsedTrace();
        const json = parseJson<any>(content);
        if (!Array.isArray(json?.calls)) {
            parsed.errors += 1;
            return parsed;
        }

        for (const call of json.calls) {
            parsed.edges.push(makeEdge(
                this.parseManualEndpoint(call.caller),
                this.parseManualEndpoint(call.callee),
                'manual',
                0.95
            ));
        }
        return parsed;
    }

    private parseManualEndpoint(value: unknown): RuntimeTraceEndpoint {
        if (typeof value !== 'string') {
            return { relativePath: null, symbol: null };
        }
        const separator = value.lastIndexOf(':');
        if (separator < 0) {
            return { relativePath: null, symbol: value || null };
        }
        return {
            relativePath: this.normalizeTracePath(value.slice(0, separator)),
            symbol: stringOrNull(value.slice(separator + 1))
        };
    }

    private loadExistingTraces(): RuntimeTracesSchema {
        const tracePath = path.join(this.understandingDir, 'runtime_traces.json');
        const existing = unwrapArtifact<RuntimeTracesSchema>(readJsonFile(tracePath));
        if (existing?.runtimeEdges && existing?.verifiedLines && existing?.ingestStats) {
            return existing;
        }
        return {
            schemaVersion: '1.0',
            ingestedAt: new Date().toISOString(),
            traceFormat: null,
            runtimeEdges: [],
            verifiedLines: {},
            ingestStats: {
                edgesAdded: 0,
                filesVerified: 0,
                parseErrors: 0
            }
        };
    }

    private writeRuntimeTraces(state: RuntimeTracesSchema): void {
        fs.mkdirSync(this.understandingDir, { recursive: true });
        const tracePath = path.join(this.understandingDir, 'runtime_traces.json');
        fs.writeFileSync(tracePath, JSON.stringify(wrapArtifact('runtime_traces.json', state), null, 2), 'utf8');
    }

    private updateLexicalMapRuntimeVerification(verifiedLines: Record<string, number[]>): void {
        const lexicalPath = path.join(this.understandingDir, 'lexical_map.json');
        const raw = readJsonFile<any>(lexicalPath);
        const lexicalMap = unwrapArtifact<any>(raw);
        if (!lexicalMap?.files) {
            return;
        }

        let changed = false;
        for (const [fileKey, entry] of Object.entries<any>(lexicalMap.files)) {
            const relativePath = this.normalizeTracePath(entry.filePath ?? fileKey);
            const executed = relativePath ? verifiedLines[relativePath] : undefined;
            if (!executed || !Array.isArray(entry.symbols)) {
                continue;
            }
            const executedSet = new Set(executed);
            for (const symbol of entry.symbols) {
                const start = Number(symbol.startLine);
                const end = Number(symbol.endLine);
                if (!Number.isFinite(start) || !Number.isFinite(end)) {
                    continue;
                }
                for (let line = start; line <= end; line += 1) {
                    if (executedSet.has(line)) {
                        symbol.runtimeVerified = true;
                        symbol.runtimeVerifiedAt = new Date().toISOString();
                        changed = true;
                        break;
                    }
                }
            }
        }

        if (changed) {
            if (raw && typeof raw === 'object' && 'data' in raw) {
                raw.data = lexicalMap;
                raw.updatedAt = new Date().toISOString();
                fs.writeFileSync(lexicalPath, JSON.stringify(raw, null, 2), 'utf8');
            } else {
                fs.writeFileSync(lexicalPath, JSON.stringify(wrapArtifact('lexical_map.json', lexicalMap), null, 2), 'utf8');
            }
            this.outputChannel?.appendLine('[Info] TraceIngestion: marked runtime-verified lexical symbols from coverage.');
        }
    }

    private readArtifact<T>(artifactName: string): T | null {
        return unwrapArtifact<T>(readJsonFile(path.join(this.understandingDir, artifactName)));
    }

    private normalizeTracePath(value: unknown): string | null {
        if (typeof value !== 'string' || value.trim() === '') {
            return null;
        }
        const normalized = value.replace(/\\/g, '/');
        const absolute = path.isAbsolute(value)
            ? value
            : path.resolve(this.workspaceRoot, normalized);
        const relative = path.relative(this.workspaceRoot, absolute);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return relative.replace(/\\/g, '/');
        }
        return normalized.replace(/^\.\//, '');
    }
}

function emptyParsedTrace(): ParsedTrace {
    return {
        edges: [],
        verifiedLines: {},
        errors: 0
    };
}

function makeEdge(
    from: RuntimeTraceEndpoint,
    to: RuntimeTraceEndpoint,
    source: TraceFormat,
    confidence: number
): RuntimeEdge {
    return {
        from,
        to,
        source,
        confidence,
        observedCount: 1
    };
}

function mergeRuntimeEdges(state: RuntimeTracesSchema, edges: RuntimeEdge[]): number {
    let added = 0;
    for (const edge of edges) {
        const existing = state.runtimeEdges.find(item =>
            item.source === edge.source &&
            item.from.relativePath === edge.from.relativePath &&
            item.from.symbol === edge.from.symbol &&
            item.to.relativePath === edge.to.relativePath &&
            item.to.symbol === edge.to.symbol
        );
        if (existing) {
            existing.observedCount += edge.observedCount;
            existing.confidence = Math.max(existing.confidence, edge.confidence);
        } else {
            state.runtimeEdges.push(edge);
            added += 1;
        }
    }
    return added;
}

function mergeVerifiedLines(state: RuntimeTracesSchema, verifiedLines: Record<string, number[]>): number {
    let filesVerified = 0;
    for (const [relativePath, lines] of Object.entries(verifiedLines)) {
        const existing = new Set(state.verifiedLines[relativePath] ?? []);
        const before = existing.size;
        for (const line of lines) {
            existing.add(line);
        }
        state.verifiedLines[relativePath] = Array.from(existing).sort((a, b) => a - b);
        if (existing.size > before || before === 0) {
            filesVerified += 1;
        }
    }
    return filesVerified;
}

function parsePytestNodeId(nodeid: unknown): RuntimeTraceEndpoint {
    if (typeof nodeid !== 'string') {
        return { relativePath: null, symbol: null };
    }
    const parts = nodeid.split('::');
    return {
        relativePath: parts[0]?.replace(/\\/g, '/') ?? null,
        symbol: parts.slice(1).join('::') || null
    };
}

function parseJson<T>(content: string): T | null {
    try {
        return JSON.parse(content) as T;
    } catch {
        return null;
    }
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function toNumberArray(value: unknown): number[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return Array.from(new Set(value.map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
}

function collectOtelSpans(value: any): any[] {
    if (Array.isArray(value)) {
        return value;
    }
    if (Array.isArray(value.spans)) {
        return value.spans;
    }
    const spans: any[] = [];
    for (const resourceSpan of value.resourceSpans ?? []) {
        for (const scopeSpan of resourceSpan.scopeSpans ?? resourceSpan.instrumentationLibrarySpans ?? []) {
            if (Array.isArray(scopeSpan.spans)) {
                spans.push(...scopeSpan.spans);
            }
        }
    }
    return spans;
}

function endpointFromSpan(span: any, normalizePath: (value: unknown) => string | null): RuntimeTraceEndpoint {
    return {
        relativePath: normalizePath(getSpanAttribute(span, 'code.filepath') ?? getSpanAttribute(span, 'code.file.path')),
        symbol: stringOrNull(
            getSpanAttribute(span, 'code.function') ??
            getSpanAttribute(span, 'code.function.name') ??
            span.name
        )
    };
}

function getSpanAttribute(span: any, key: string): unknown {
    const attributes = span.attributes;
    if (!attributes) {
        return null;
    }
    if (!Array.isArray(attributes)) {
        return attributes[key] ?? null;
    }
    const found = attributes.find((item: any) => item.key === key);
    if (!found) {
        return null;
    }
    const value = found.value;
    return value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? value?.boolValue ?? value;
}

function decodeCoverageNumbits(raw: Buffer): number[] {
    const lines: number[] = [];
    for (let byteIndex = 0; byteIndex < raw.length; byteIndex += 1) {
        const byte = raw[byteIndex];
        for (let bit = 0; bit < 8; bit += 1) {
            if ((byte & (1 << bit)) !== 0) {
                lines.push(byteIndex * 8 + bit + 1);
            }
        }
    }
    return lines;
}


function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
