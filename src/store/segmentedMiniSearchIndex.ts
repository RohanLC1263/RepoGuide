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
    private readonly segmentsDir: string;
    private readonly legacyBlobPath: string;
    private readonly manifestPath: string;
    private readonly tombstonesPath: string;
    private readonly activePath: string;
    private readonly options: Options<T>;
    private readonly idField: string;
    private readonly sealThreshold: number;

    private active: MiniSearch<T>;
    private activeDocCount = 0;
    private sealedSegments: MiniSearch<T>[] = [];
    private manifest: SegmentedIndexManifest = { sealedSegmentIds: [] };
    private tombstones = new Set<string>();

    constructor(baseDir: string, indexName: string, options: Options<T>, sealThreshold = DEFAULT_SEAL_THRESHOLD) {
        this.segmentsDir = path.join(baseDir, `${indexName}_segments`);
        this.legacyBlobPath = path.join(baseDir, `${indexName}.json`);
        this.manifestPath = path.join(this.segmentsDir, 'manifest.json');
        this.tombstonesPath = path.join(this.segmentsDir, 'tombstones.json');
        this.activePath = path.join(this.segmentsDir, 'active.json');
        this.options = options;
        this.idField = options.idField ?? 'id';
        this.sealThreshold = sealThreshold;
        this.active = new MiniSearch<T>(options);
    }

    async init(): Promise<void> {
        await fs.promises.mkdir(this.segmentsDir, { recursive: true });

        this.tombstones = new Set((await this.readJsonSafe<string[]>(this.tombstonesPath)) ?? []);

        const existingManifest = await this.readJsonSafe<SegmentedIndexManifest>(this.manifestPath);
        if (existingManifest) {
            this.manifest = existingManifest;
        } else {
            this.manifest = { sealedSegmentIds: [] };
            await this.migrateLegacyBlob();
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
}
