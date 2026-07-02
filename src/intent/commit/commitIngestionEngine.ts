import { CommitStore } from './commitStore';
import { CommitProvider } from './providers/commitProvider';
import { CommitSyncStats } from './commitTypes';

export class CommitIngestionEngine {
    constructor(
        private store: CommitStore,
        private provider: CommitProvider
    ) {}

    /**
     * Incrementally synchronizes commit metadata from Git into the local SQLite store.
     * Safely recovers from force-pushes via a full resync.
     */
    public async syncIncremental(): Promise<CommitSyncStats> {
        const stats: CommitSyncStats = {
            commitsProcessed: 0,
            filesProcessed: 0,
            durationMs: 0
        };
        const startTime = Date.now();

        let lastSha = this.store.getLastProcessedCommit();

        // 1. Force-push protection validation
        if (lastSha) {
            const exists = await this.provider.verifyCheckpointExists(lastSha);
            if (!exists) {
                console.warn(`[CommitIngestion] Checkpoint SHA ${lastSha} no longer exists. History was rewritten. Performing full resync.`);
                this.store.truncateAll();
                lastSha = null;
            }
        }

        // 2. Bulk retrieve all commits since the last checkpoint
        const newCommits = await this.provider.listCommits(lastSha || undefined);

        if (newCommits.length === 0) {
            stats.durationMs = Date.now() - startTime;
            return stats; // Up to date
        }

        // 3. Persist to DB in batches to handle large repositories safely
        stats.oldestCommit = newCommits[0].sha;
        stats.newestCommit = newCommits[newCommits.length - 1].sha;

        // Save sequentially or in a single transaction
        // newCommits is already ordered oldest-to-newest by the provider
        await this.store.saveBatch(newCommits);

        for (const commit of newCommits) {
            stats.commitsProcessed++;
            stats.filesProcessed += commit.files.length;
            
            // Advance the checkpoint continuously in memory, save it at the end
            lastSha = commit.sha;
        }

        // 4. Update sync state
        if (lastSha) {
            this.store.setLastProcessedCommit(lastSha);
        }

        stats.durationMs = Date.now() - startTime;
        return stats;
    }
}
