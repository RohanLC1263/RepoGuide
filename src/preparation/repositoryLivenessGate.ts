import { buildRepositoryReadinessReport, RepositoryReadinessReport } from './repositoryReadiness';

export type LivenessStatus = 'ok' | 'never_indexed' | 'corrupted';

export interface LivenessResult {
    status: LivenessStatus;
    message?: string;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Defense-in-depth for the gap found investigating CraftConnect's empty
 * chunk stores: hasValidEvidenceIndex()/buildRepositoryReadinessReport() only
 * ever run at a handful of discrete lifecycle moments (activation, manual
 * resync, workspace-folder-changed) -- never mid-session. If an external
 * process empties the chunk-level stores (Lance/BM25) while a VS Code window
 * stays open without reactivating, nothing notices. This gate is checked at
 * query time instead, cheaply (TTL-cached, since buildRepositoryReadinessReport()
 * opens several stores), and distinguishes a genuinely fresh, never-indexed
 * repo (logical_units/facts also empty -- expected, no alarm) from the
 * corruption signature this investigation found: logical_units/facts
 * populated while chunk-level stores are empty, which only happens if a
 * previous reindex ran partway (structural extraction succeeded, embedding
 * never completed or was wiped) rather than never having run at all.
 */
export class RepositoryLivenessGate {
    private cached: { result: LivenessResult; checkedAt: number } | null = null;

    constructor(
        private readonly workspaceRoot: string,
        private readonly repoguideDir?: string,
        private readonly ttlMs: number = DEFAULT_TTL_MS
    ) {}

    /** Call after any full or incremental reindex completes, so a stale cached
     * result from before the reindex isn't served to the very next query. */
    invalidate(): void {
        this.cached = null;
    }

    async check(): Promise<LivenessResult> {
        if (this.cached && Date.now() - this.cached.checkedAt < this.ttlMs) {
            return this.cached.result;
        }
        const report = await buildRepositoryReadinessReport(this.workspaceRoot, this.repoguideDir);
        const result = classify(report);
        this.cached = { result, checkedAt: Date.now() };
        return result;
    }
}

function classify(report: RepositoryReadinessReport): LivenessResult {
    const byName = new Map(report.artifacts.map(artifact => [artifact.name, artifact]));
    const unitCount = byName.get('logical_units')?.recordCount ?? 0;
    const factCount = byName.get('facts')?.recordCount ?? 0;
    const lanceCount = byName.get('lance_chunks')?.recordCount ?? 0;
    const bm25Count = byName.get('bm25')?.recordCount ?? 0;

    const hasStructuralData = unitCount > 0 || factCount > 0;
    const chunksEmpty = lanceCount === 0 && bm25Count === 0;

    if (hasStructuralData && chunksEmpty) {
        return {
            status: 'corrupted',
            message: 'RepoGuide\'s chunk-level index (vector + keyword search) is empty even though other index data exists. This usually means a previous reindex was interrupted. Answers may be missing evidence until you re-sync.'
        };
    }
    if (!hasStructuralData && chunksEmpty) {
        return { status: 'never_indexed' };
    }
    return { status: 'ok' };
}
