import * as fs from 'fs';
import * as path from 'path';
import { ADRStore } from './adrStore';
import { ADRDiscoveryEngine } from './adrDiscoveryEngine';
import { ADRParser } from './adrParser';
import { ADRSyncStats } from './adrTypes';

export class ADRIngestionEngine {
    constructor(
        private store: ADRStore,
        private discoveryEngine: ADRDiscoveryEngine,
        private parser: ADRParser,
        private workspaceRoot: string,
        private repositoryId: string
    ) {}

    public async syncIncremental(): Promise<ADRSyncStats> {
        const stats: ADRSyncStats = {
            adrsProcessed: 0,
            referencesProcessed: 0,
            durationMs: 0
        };
        const startTime = Date.now();

        const adrPaths = await this.discoveryEngine.discover();

        // Optional: We can get all current IDs in DB and delete any that no longer exist on disk.
        // For V1, we focus on ingestion of discovered files.
        const currentIdsInDb = new Set((await this.store.list()).map(a => a.id));
        const foundIds = new Set<string>();

        for (const absolutePath of adrPaths) {
            const relPath = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
            const content = await fs.promises.readFile(absolutePath, 'utf8');
            
            // Parse in memory to calculate Hash
            const { adr, references } = this.parser.parse(content, relPath, this.repositoryId);
            foundIds.add(adr.id);

            // Hash-based incremental check
            const existingHash = this.store.getHashForPath(relPath);
            if (existingHash === adr.sourceHash) {
                // Unchanged
                continue;
            }

            // Save to DB
            await this.store.save(adr, references);
            
            stats.adrsProcessed++;
            stats.referencesProcessed += references.length;
        }

        // Delete removed ADRs
        for (const dbId of currentIdsInDb) {
            if (!foundIds.has(dbId)) {
                await this.store.delete(dbId);
            }
        }

        stats.durationMs = Date.now() - startTime;
        return stats;
    }
}
