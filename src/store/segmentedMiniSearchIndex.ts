import * as fs from 'fs';
import * as path from 'path';
import MiniSearch, { Options, SearchOptions, SearchResult } from 'minisearch';

const DEFAULT_SEAL_THRESHOLD = 500;

interface SegmentedIndexManifest {
    sealedSegmentIds: string[]; // oldest -> newest
}

/**
 * Lucene-style sealed-segment persistence for MiniSearch, shared by
 * Bm25Store and LogicalUnitBm25Store.
 *
 * Writes only ever touch a small "active" segment (rewritten in full on each
 * change, but bounded to `sealThreshold` documents) instead of the entire
 * corpus. Once the active segment fills up it's sealed as an immutable
 * segment file and a fresh active segment starts. Deletes are tombstones
 * checked at query/count time rather than rewrites of sealed segments.
 *
 * Known limitation: segments are never merged/compacted (MiniSearch doesn't
 * expose a safe way to enumerate a loaded index's original documents unless
 * every indexed field is also a stored field, which isn't true for every
 * caller here) -- segment count and the tombstone set grow unboundedly over
 * a long-lived repository. A full reindex (`clearAll()` + rebuild) is the
 * reset point; this is a real gap, not silently glossed over.
 */
export class SegmentedMiniSearchIndex<T extends Record<string, unknown> = Record<string, unknown>> {
    private readonly baseDir: string;
    private readonly indexName: string;
    private readonly legacyBlobPath: string;
    private readonly activeGenerationPath: string;
    private readonly options: Options<T>;
    private readonly idField: string;
    private readonly sealThreshold: number;

    private activeGeneration: 0 | 1 = 0;
    private rebuildGeneration: 0 | 1 | null = null;
    private segmentsDir: string;
    private manifestPath: string;
    private tombstonesPath: string;
    private activePath: string;

    private active: MiniSearch<T>;
    private activeDocCount = 0;
    private sealedSegments: MiniSearch<T>[] = [];
    private manifest: SegmentedIndexManifest = { sealedSegmentIds: [] };
    private tombstones = new Set<string>();

    constructor(baseDir: string, indexName: string, options: Options<T>, sealThreshold = DEFAULT_SEAL_THRESHOLD) {
        this.baseDir = baseDir;
        this.indexName = indexName;
        this.legacyBlobPath = path.join(baseDir, `${indexName}.json`);
        this.activeGenerationPath = path.join(baseDir, `${indexName}_active_gen.json`);
        this.options = options;
        this.idField = options.idField ?? 'id';
        this.sealThreshold = sealThreshold;
        this.active = new MiniSearch<T>(options);
        this.segmentsDir = this.dirForGeneration(0);
        this.manifestPath = path.join(this.segmentsDir, 'manifest.json');
        this.tombstonesPath = path.join(this.segmentsDir, 'tombstones.json');
        this.activePath = path.join(this.segmentsDir, 'active.json');
    }

    /**
     * Generation 0 keeps the original, non-suffixed segments directory so existing
     * on-disk indexes need no migration/copy; generation 1 is a new sibling
     * directory used only while a rebuild is staged. See beginRebuild()/commitRebuild().
     */
    private dirForGeneration(gen: 0 | 1): string {
        return gen === 0
            ? path.join(this.baseDir, `${this.indexName}_segments`)
            : path.join(this.baseDir, `${this.indexName}_segments_alt`);
    }

    private setPathsForGeneration(gen: 0 | 1): void {
        this.segmentsDir = this.dirForGeneration(gen);
        this.manifestPath = path.join(this.segmentsDir, 'manifest.json');
        this.tombstonesPath = path.join(this.segmentsDir, 'tombstones.json');
        this.activePath = path.join(this.segmentsDir, 'active.json');
    }

    private async readActiveGeneration(): Promise<0 | 1> {
        const raw = await this.readJsonSafe<{ active: 0 | 1 }>(this.activeGenerationPath);
        return raw?.active === 1 ? 1 : 0;
    }

    private async writeActiveGenerationAtomic(gen: 0 | 1): Promise<void> {
        const tmpPath = `${this.activeGenerationPath}.tmp-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(tmpPath, JSON.stringify({ active: gen }), 'utf8');
        await fs.promises.rename(tmpPath, this.activeGenerationPath);
    }

    async init(): Promise<void> {
        this.activeGeneration = await this.readActiveGeneration();
        this.rebuildGeneration = null;
        this.setPathsForGeneration(this.activeGeneration);
        await this.loadFromDisk();
    }

    private async loadFromDisk(): Promise<void> {
        await fs.promises.mkdir(this.segmentsDir, { recursive: true });

        this.tombstones = new Set((await this.readJsonSafe<string[]>(this.tombstonesPath)) ?? []);

        const existingManifest = await this.readJsonSafe<SegmentedIndexManifest>(this.manifestPath);
        if (existingManifest) {
            this.manifest = existingManifest;
        } else {
            this.manifest = { sealedSegmentIds: [] };
            if (this.activeGeneration === 0) {
                await this.migrateLegacyBlob();
            }
        }

        this.sealedSegments = [];
        for (const segId of this.manifest.sealedSegmentIds) {
            const searcher = await this.loadSegment(segId);
            if (searcher) {
                this.sealedSegments.push(searcher);
            }
        }

        const activeRaw = await this.readTextSafe(this.activePath);
        this.active = activeRaw ? this.loadFromJSON(activeRaw) : new MiniSearch<T>(this.options);
        this.activeDocCount = this.active.documentCount;
    }

    private loadFromJSON(raw: string): MiniSearch<T> {
        return MiniSearch.loadJSON<T>(raw, this.options);
    }

    private async loadSegment(segId: string): Promise<MiniSearch<T> | null> {
        const raw = await this.readTextSafe(path.join(this.segmentsDir, `${segId}.json`));
        return raw ? this.loadFromJSON(raw) : null;
    }

    /** A pre-migration single-blob index file, if present, becomes the first sealed segment. */
    private async migrateLegacyBlob(): Promise<void> {
        const raw = await this.readTextSafe(this.legacyBlobPath);
        if (!raw) {
            return;
        }
        try {
            const legacy = this.loadFromJSON(raw);
            if (legacy.documentCount === 0) {
                return;
            }
            const segId = this.newSegmentId();
            await fs.promises.writeFile(path.join(this.segmentsDir, `${segId}.json`), raw, 'utf8');
            this.manifest.sealedSegmentIds.push(segId);
            await this.saveManifest();
        } catch {
            // Legacy blob unreadable/corrupt -- nothing to migrate, start fresh.
        }
    }

    private newSegmentId(): string {
        return `seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    private async readJsonSafe<V>(p: string): Promise<V | null> {
        const raw = await this.readTextSafe(p);
        if (!raw) {
            return null;
        }
        try {
            return JSON.parse(raw) as V;
        } catch {
            return null;
        }
    }

    private async readTextSafe(p: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(p, 'utf8');
        } catch {
            return null;
        }
    }

    private async saveManifest(): Promise<void> {
        await fs.promises.writeFile(this.manifestPath, JSON.stringify(this.manifest), 'utf8');
    }

    private async saveTombstones(): Promise<void> {
        await fs.promises.writeFile(this.tombstonesPath, JSON.stringify(Array.from(this.tombstones)), 'utf8');
    }

    private async saveActive(): Promise<void> {
        await fs.promises.writeFile(this.activePath, JSON.stringify(this.active), 'utf8');
    }

    async addAllAsync(docs: T[]): Promise<void> {
        if (docs.length === 0) {
            return;
        }
        // A previously-tombstoned id being re-inserted while still physically
        // present in the (mutable) active segment would otherwise collide --
        // MiniSearch throws on duplicate ids. Sealed segments are left alone;
        // their stale copy stays tombstone-filtered at query time.
        let tombstonesChanged = false;
        for (const doc of docs) {
            const id = doc[this.idField] as string;
            if (this.active.has(id)) {
                this.active.discard(id);
            }
            // Re-inserting a previously-deleted id (e.g. identical content
            // reappearing at the same location) must clear its tombstone --
            // otherwise the fresh copy would be immediately search-invisible.
            if (this.tombstones.has(id)) {
                this.tombstones.delete(id);
                tombstonesChanged = true;
            }
        }
        await this.active.addAllAsync(docs);
        this.activeDocCount = this.active.documentCount;
        await this.saveActive();
        if (tombstonesChanged) {
            await this.saveTombstones();
        }
        await this.maybeSeal();
    }

    private async maybeSeal(): Promise<void> {
        if (this.activeDocCount < this.sealThreshold) {
            return;
        }
        const segId = this.newSegmentId();
        await fs.promises.writeFile(path.join(this.segmentsDir, `${segId}.json`), JSON.stringify(this.active), 'utf8');
        this.manifest.sealedSegmentIds.push(segId);
        await this.saveManifest();
        this.sealedSegments.push(this.active);

        this.active = new MiniSearch<T>(this.options);
        this.activeDocCount = 0;
        await this.saveActive();
    }

    has(id: string): boolean {
        if (this.tombstones.has(id)) {
            return false;
        }
        if (this.active.has(id)) {
            return true;
        }
        return this.sealedSegments.some(seg => seg.has(id));
    }

    async discard(id: string): Promise<void> {
        if (!this.has(id) || this.tombstones.has(id)) {
            return;
        }
        this.tombstones.add(id);
        await this.saveTombstones();
    }

    async discardMany(ids: string[]): Promise<void> {
        let changed = false;
        for (const id of ids) {
            if (this.has(id) && !this.tombstones.has(id)) {
                this.tombstones.add(id);
                changed = true;
            }
        }
        if (changed) {
            await this.saveTombstones();
        }
    }

    search(query: string, options?: SearchOptions): SearchResult[] {
        // Keyed by id (not pushed to a plain array): if an id was deleted then
        // re-inserted, its old copy can still be physically present in a
        // sealed segment (segments are never rewritten) alongside the fresh
        // copy in `active` -- keep the best-scoring occurrence, not both.
        const byId = new Map<string, SearchResult>();
        for (const seg of [this.active, ...this.sealedSegments]) {
            for (const r of seg.search(query, options)) {
                if (this.tombstones.has(r.id as string)) {
                    continue;
                }
                const existing = byId.get(r.id as string);
                if (!existing || r.score > existing.score) {
                    byId.set(r.id as string, r);
                }
            }
        }
        return Array.from(byId.values()).sort((a, b) => b.score - a.score);
    }

    get documentCount(): number {
        let total = this.activeDocCount;
        for (const seg of this.sealedSegments) {
            total += seg.documentCount;
        }
        return Math.max(0, total - this.tombstones.size);
    }

    async clearAll(): Promise<void> {
        this.active = new MiniSearch<T>(this.options);
        this.activeDocCount = 0;
        this.sealedSegments = [];
        this.manifest = { sealedSegmentIds: [] };
        this.tombstones = new Set();
        try {
            await fs.promises.rm(this.segmentsDir, { recursive: true, force: true });
        } catch {
            // Non-fatal
        }
        await fs.promises.mkdir(this.segmentsDir, { recursive: true });
        try {
            await fs.promises.unlink(this.legacyBlobPath);
        } catch {
            // May not exist
        }
    }

    /**
     * Begins a safe rebuild: allocates the currently-inactive generation as a fresh,
     * empty working area and repoints all subsequent writes (addAllAsync/discard/etc.)
     * there, while any other reader -- including a fresh instance of this same class
     * pointed at the same baseDir -- keeps seeing the untouched, still-active
     * generation until commitRebuild() flips the pointer. If the process dies, or
     * commitRebuild() is never called, the active generation (and therefore every
     * previously-indexed document) is never touched.
     */
    async beginRebuild(): Promise<void> {
        const inactive: 0 | 1 = this.activeGeneration === 0 ? 1 : 0;
        this.rebuildGeneration = inactive;
        this.setPathsForGeneration(inactive);
        // A previous aborted rebuild may have left partial data in this slot.
        try {
            await fs.promises.rm(this.segmentsDir, { recursive: true, force: true });
        } catch {
            // Non-fatal
        }
        await fs.promises.mkdir(this.segmentsDir, { recursive: true });
        this.active = new MiniSearch<T>(this.options);
        this.activeDocCount = 0;
        this.sealedSegments = [];
        this.manifest = { sealedSegmentIds: [] };
        this.tombstones = new Set();
    }

    /**
     * Commits the rebuild started by beginRebuild(), atomically flipping the
     * active-generation pointer to the newly-built data -- but only if the new
     * generation looks legitimately populated relative to what was there before.
     * Refuses (returns false, leaves the previous generation live) when the old
     * generation had real documents and the new one has none: the exact signature
     * of a reindex that silently produced zero indexable content (e.g. every chunk
     * failed to embed) rather than a genuinely empty repository.
     */
    async commitRebuild(previousDocCount: number): Promise<boolean> {
        if (this.rebuildGeneration === null) {
            throw new Error('commitRebuild() called without a matching beginRebuild().');
        }
        const newGeneration = this.rebuildGeneration;
        const newDocCount = this.documentCount;
        if (previousDocCount > 0 && newDocCount === 0) {
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
            await fs.promises.rm(this.dirForGeneration(oldGeneration), { recursive: true, force: true });
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
            await fs.promises.rm(this.dirForGeneration(this.rebuildGeneration), { recursive: true, force: true });
        } catch {
            // Non-fatal
        }
        this.rebuildGeneration = null;
        this.setPathsForGeneration(this.activeGeneration);
        await this.loadFromDisk();
    }
}
