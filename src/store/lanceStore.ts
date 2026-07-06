import * as fs from 'fs';
import * as path from 'path';
import * as lancedb from 'vectordb';
import { MetricType } from 'vectordb';
import { CodeChunk } from './storeTypes';

function safeStringLiteral(value: string): string {
    // Escape SQL string delimiters and strip control characters.
    // Backslashes are literal path characters in Lance SQL filters.
    return value
        .replace(/'/g, "''")
        .replace(/[\x00-\x1f]/g, '');  // strip control chars
}

function filePathFilter(filePath: string): string {
    return `\`filePath\` = '${safeStringLiteral(filePath)}'`;
}

function idFilter(id: string): string {
    return `\`id\` = '${safeStringLiteral(id)}'`;
}

// An IVF_PQ ANN index is only worth its rebuild cost once the table has enough
// vectors to train meaningful partitions; below this, a brute-force scan is
// already fast. LanceDB's default query behavior (queryByVector never sets
// `.fastSearch(true)`) always merges an ANN scan of the indexed portion with a
// flat scan of any un-indexed delta, so newly-inserted rows stay searchable
// between rebuilds -- the rebuild trigger below is a latency tuning knob, not
// a correctness deadline.
const ANN_INDEX_ROW_THRESHOLD = 10000;
const ANN_INDEX_REBUILD_DELTA_RATIO = 0.2;

// Page size used internally when iterating the full table (getAllChunks /
// getAllFilePaths), to avoid one massive Arrow buffer materialization for
// large repositories. Callers still receive the full result set -- this
// bounds the transient/round-trip memory of fetching it, not the size of the
// returned array itself.
const SCAN_PAGE_SIZE = 1000;

interface AnnIndexState {
    builtAtRowCount: number;
}

export class LanceStore {
    private dbPath: string;
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;
    private hasSeqColumn = false;
    private nextSeq = 0;
    private annIndexState: AnnIndexState | null = null;
    private activeGeneration: 0 | 1 = 0;
    private rebuildGeneration: 0 | 1 | null = null;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
    }

    /**
     * Generation 0 keeps the original 'chunks' table name so existing on-disk
     * indexes need no migration/copy; generation 1 is a new sibling table used
     * only while a rebuild is staged. See beginRebuild()/commitRebuild().
     */
    private tableNameForGeneration(gen: 0 | 1): string {
        return gen === 0 ? 'chunks' : 'chunks_alt';
    }

    private activeGenerationPath(): string {
        return path.join(this.dbPath, 'active_generation.json');
    }

    private async readActiveGeneration(): Promise<0 | 1> {
        try {
            const raw = fs.readFileSync(this.activeGenerationPath(), 'utf8');
            const parsed = JSON.parse(raw) as { active?: 0 | 1 };
            return parsed.active === 1 ? 1 : 0;
        } catch {
            return 0;
        }
    }

    private async writeActiveGenerationAtomic(gen: 0 | 1): Promise<void> {
        const tmpPath = `${this.activeGenerationPath()}.tmp-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(tmpPath, JSON.stringify({ active: gen }), 'utf8');
        await fs.promises.rename(tmpPath, this.activeGenerationPath());
    }

    private async openOrCreateGenerationTable(gen: 0 | 1): Promise<void> {
        if (!this.db) {
            throw new Error('Not connected');
        }
        const tableName = this.tableNameForGeneration(gen);
        try {
            this.table = await this.db.openTable(tableName);
        } catch (e) {
            // Table doesn't exist, create it with a sample record
            const sample: CodeChunk & { seq: number } = {
                id: 'dummy',
                filePath: 'dummy',
                language: 'dummy',
                startLine: 0,
                endLine: 0,
                text: 'dummy',
                vector: new Array(768).fill(0),
                hash: 'dummy',
                seq: 0
            };
            this.table = await this.db.createTable(tableName, [sample as unknown as Record<string, unknown>]);
            await this.deleteChunkById('dummy');
        }
    }

    async init(): Promise<void> {
        this.db = await lancedb.connect(this.dbPath);
        this.activeGeneration = await this.readActiveGeneration();
        this.rebuildGeneration = null;
        await this.openOrCreateGenerationTable(this.activeGeneration);
        await this.initSeqCursor();
        this.annIndexState = this.loadAnnIndexState();
    }

    /** Whichever generation is currently backing `this.table` -- the rebuild generation while a rebuild is staged, otherwise the active one. */
    private currentGeneration(): 0 | 1 {
        return this.rebuildGeneration ?? this.activeGeneration;
    }

    private annIndexStatePath(): string {
        return path.join(this.dbPath, `ann_index_state_${this.tableNameForGeneration(this.currentGeneration())}.json`);
    }

    private loadAnnIndexState(): AnnIndexState | null {
        try {
            const raw = fs.readFileSync(this.annIndexStatePath(), 'utf8');
            return JSON.parse(raw) as AnnIndexState;
        } catch {
            return null;
        }
    }

    private saveAnnIndexState(state: AnnIndexState): void {
        try {
            fs.mkdirSync(this.dbPath, { recursive: true });
            fs.writeFileSync(this.annIndexStatePath(), JSON.stringify(state), 'utf8');
            this.annIndexState = state;
        } catch {
            // Non-fatal: worst case the index gets rebuilt again next threshold check.
        }
    }

    /**
     * Determines the current `seq` cursor by scanning just the `seq` column
     * (cheap relative to a full-chunk load -- no text/vector columns) rather
     * than tracking it purely in memory, so it survives extension restarts.
     * Tables written before this migration lack the column entirely; those
     * fall back to unpaginated reads until their next full reindex.
     */
    private async initSeqCursor(): Promise<void> {
        if (!this.table) {
            return;
        }
        try {
            const count = await this.table.countRows();
            if (count === 0) {
                this.hasSeqColumn = true;
                this.nextSeq = 0;
                return;
            }
            const rows = await this.table
                .filter('`startLine` >= 0')
                .select(['seq'])
                .limit(count + 100)
                .execute();
            let maxSeq = -1;
            let anyMissing = false;
            for (const row of rows) {
                const seq = (row as Record<string, unknown>).seq;
                if (typeof seq === 'number') {
                    if (seq > maxSeq) {
                        maxSeq = seq;
                    }
                } else {
                    anyMissing = true;
                }
            }
            this.hasSeqColumn = !anyMissing;
            this.nextSeq = maxSeq + 1;
        } catch {
            // `seq` column doesn't exist on this (pre-migration) table at all.
            this.hasSeqColumn = false;
        }
    }

    async insertChunks(chunks: CodeChunk[]): Promise<void> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        if (chunks.length === 0) {
            return;
        }
        const rows = this.hasSeqColumn
            ? chunks.map(c => ({ ...c, seq: this.nextSeq++ }))
            : chunks;
        await this.table.add(rows as unknown as Record<string, unknown>[]);
        await this.maybeBuildAnnIndex();
    }

    /**
     * Builds (or rebuilds) the IVF_PQ ANN index once the table is large enough
     * to benefit, and again whenever the un-indexed delta since the last build
     * grows large relative to the indexed set. Never affects search
     * correctness (see the module-level note on `.fastSearch`) -- only query
     * latency, since a bigger un-indexed delta means a bigger flat-scan
     * fallback on every query.
     */
    private async maybeBuildAnnIndex(): Promise<void> {
        if (!this.table) {
            return;
        }
        try {
            const count = await this.table.countRows();
            const state = this.annIndexState;
            const needsInitialBuild = !state && count >= ANN_INDEX_ROW_THRESHOLD;
            const needsRebuild = state !== null && (count - state.builtAtRowCount) > state.builtAtRowCount * ANN_INDEX_REBUILD_DELTA_RATIO;

            if (!needsInitialBuild && !needsRebuild) {
                return;
            }

            await this.table.createIndex({
                type: 'ivf_pq',
                column: 'vector',
                metric_type: MetricType.Cosine,
                replace: true
            });
            this.saveAnnIndexState({ builtAtRowCount: count });
        } catch (e) {
            // ANN indexing is a performance optimization, not a correctness
            // requirement -- brute-force search still works if this fails.
            console.warn('[Warn] Failed to build LanceDB ANN index:', e);
        }
    }

    async deleteChunksByFile(filePath: string): Promise<void> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        await this.table.delete(filePathFilter(filePath));
    }

    async getChunksByFile(filePath: string): Promise<CodeChunk[]> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        const results = await this.table.filter(filePathFilter(filePath)).execute();
        if (results.length > 0) {
            return results as unknown as CodeChunk[];
        }

        const normalizedTarget = normalizeFilePath(filePath);
        const allChunks = await this.getAllChunks();
        return allChunks.filter(chunk => normalizeFilePath(chunk.filePath) === normalizedTarget);
    }

    async queryByVector(vector: number[], topK: number): Promise<CodeChunk[]> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        // Never call .fastSearch(true) here: with an ANN index built, that flag
        // skips the flat scan over any un-indexed delta rows, which would make
        // recently-inserted chunks invisible to vector search until the next
        // index rebuild. Default (false) merges both scans automatically.
        const results = await this.table.search(vector).metricType('cosine' as any).limit(topK).execute();
        return results as unknown as CodeChunk[];
    }

    /**
     * Iterates the full table in bounded-size pages via the `seq` cursor
     * instead of one `.limit(count + N)` round trip. Bounds the transient
     * memory/Arrow-deserialization cost of the fetch; the returned array is
     * still the full result set, since every existing caller expects that.
     * Falls back to a single unpaginated load for tables predating the `seq`
     * migration (safe, just not memory-bounded until their next full reindex).
     */
    private async scanAllRows(): Promise<Record<string, unknown>[]> {
        if (!this.table) {
            return [];
        }
        if (!this.hasSeqColumn) {
            try {
                const count = await this.table.countRows();
                if (count === 0) {
                    return [];
                }
                return await this.table
                    .filter('`startLine` >= 0')
                    .limit(count + 1000)
                    .execute();
            } catch {
                return [];
            }
        }

        const rows: Record<string, unknown>[] = [];
        const upperBound = this.nextSeq;
        for (let start = 0; start < upperBound; start += SCAN_PAGE_SIZE) {
            const end = start + SCAN_PAGE_SIZE;
            try {
                const batch = await this.table
                    .filter(`\`seq\` >= ${start} AND \`seq\` < ${end}`)
                    .limit(SCAN_PAGE_SIZE)
                    .execute();
                rows.push(...batch);
            } catch {
                // Skip a bad page rather than failing the whole scan.
            }
        }
        return rows;
    }

    async getAllFilePaths(): Promise<string[]> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        try {
            const count = await this.table.countRows();
            if (count === 0) {
                return [];
            }
            const rows = await this.scanAllRows();
            const paths = new Set<string>();
            for (const row of rows) {
                const filePath = row.filePath;
                if (filePath && filePath !== 'dummy') {
                    paths.add(filePath as string);
                }
            }
            return Array.from(paths);
        } catch {
            return [];
        }
    }

    async deleteChunkById(id: string): Promise<void> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        await this.table.delete(idFilter(id));
    }

    async clearAll(): Promise<void> {
        if (this.db) {
            try {
                await this.db.dropTable(this.tableNameForGeneration(this.activeGeneration));
            } catch (e) {
                // Table might not exist
            }
            this.table = null;
            this.nextSeq = 0;
            this.hasSeqColumn = false;
            this.annIndexState = null;
            try {
                fs.rmSync(this.annIndexStatePath(), { force: true });
            } catch {
                // Non-fatal
            }
            await this.init();
        }
    }

    /**
     * Begins a safe rebuild: opens the currently-inactive generation's table as a
     * fresh, empty working area and repoints all subsequent writes (insertChunks,
     * ANN index builds) there, while any other reader -- including a fresh
     * LanceStore instance pointed at the same dbPath -- keeps seeing the untouched,
     * still-active generation's table until commitRebuild() flips the pointer. If
     * the process dies, or commitRebuild() is never called, the active generation
     * (and therefore every previously-indexed chunk) is never touched.
     */
    async beginRebuild(): Promise<void> {
        if (!this.db) {
            throw new Error('Not initialized');
        }
        const inactive: 0 | 1 = this.activeGeneration === 0 ? 1 : 0;
        this.rebuildGeneration = inactive;
        // A previous aborted rebuild may have left partial data in this slot.
        try {
            await this.db.dropTable(this.tableNameForGeneration(inactive));
        } catch {
            // Table might not exist
        }
        await this.openOrCreateGenerationTable(inactive);
        this.nextSeq = 0;
        this.hasSeqColumn = true;
        this.annIndexState = null;
    }

    /**
     * Commits the rebuild started by beginRebuild(), atomically flipping the
     * active-generation pointer to the newly-built table -- but only if the new
     * generation looks legitimately populated relative to what was there before.
     * Refuses (returns false, leaves the previous generation live) when the old
     * generation had real chunks and the new one has none: the exact signature of
     * a reindex that silently produced zero embeddable chunks (e.g. every
     * embedding call failed) rather than a genuinely empty repository.
     */
    async commitRebuild(previousChunkCount: number): Promise<boolean> {
        if (this.rebuildGeneration === null) {
            throw new Error('commitRebuild() called without a matching beginRebuild().');
        }
        const newGeneration = this.rebuildGeneration;
        const newChunkCount = await this.getChunkCount();
        if (previousChunkCount > 0 && newChunkCount === 0) {
            await this.abortRebuild();
            return false;
        }
        const oldGeneration: 0 | 1 = newGeneration === 0 ? 1 : 0;
        await this.writeActiveGenerationAtomic(newGeneration);
        this.activeGeneration = newGeneration;
        this.rebuildGeneration = null;
        // Best-effort cleanup of the now-superseded generation; failure here only
        // costs disk space until the next successful rebuild, not correctness.
        try {
            if (this.db) {
                await this.db.dropTable(this.tableNameForGeneration(oldGeneration));
            }
        } catch {
            // Non-fatal
        }
        return true;
    }

    /** Abandons an in-progress rebuild, leaving the active generation untouched. */
    async abortRebuild(): Promise<void> {
        if (this.rebuildGeneration === null) {
            return;
        }
        try {
            if (this.db) {
                await this.db.dropTable(this.tableNameForGeneration(this.rebuildGeneration));
            }
        } catch {
            // Non-fatal
        }
        this.rebuildGeneration = null;
        await this.openOrCreateGenerationTable(this.activeGeneration);
        await this.initSeqCursor();
        this.annIndexState = this.loadAnnIndexState();
    }

    async getChunkCount(): Promise<number> {
        if (!this.table) {
            return 0;
        }
        try {
            return await this.table.countRows();
        } catch {
            const results = await this.table.filter('\`startLine\` >= 0').execute();
            return results.length;
        }
    }

    async getAllChunks(): Promise<CodeChunk[]> {
        if (!this.table) {
            return [];
        }
        try {
            const count = await this.table.countRows();
            if (count === 0) {
                return [];
            }
            const rows = await this.scanAllRows();
            return (rows as unknown as CodeChunk[]).filter(chunk => chunk.id !== 'dummy');
        } catch {
            return [];
        }
    }

    async searchByKeywords(keywords: string[]): Promise<CodeChunk[]> {
        if (!this.table || keywords.length === 0) {
            return [];
        }
        try {
            const count = await this.table.countRows();
            if (count === 0) {
                return [];
            }

            const conditions = keywords.map(kw =>
                `(LOWER(\`text\`) LIKE '%${kw.toLowerCase().replace(/'/g, "''")}%' OR LOWER(\`filePath\`) LIKE '%${kw.toLowerCase().replace(/'/g, "''")}%')`
            ).join(' OR ');

            const results = await this.table
                .filter(conditions)
                .limit(50)
                .execute() as unknown as CodeChunk[];

            return results.filter(chunk => chunk.id !== 'dummy');
        } catch {
            return [];
        }
    }
}

function normalizeFilePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}
