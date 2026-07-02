import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { RuntimeStore } from './runtimeStore';
import { RuntimeSnapshotManifest, RuntimeSnapshotEvent, RuntimeEvent } from './runtimeSchema';

export class RuntimeIngestionBuilder {
    constructor(
        private store: RuntimeStore,
        private workspaceRoot: string
    ) {}

    public async build(): Promise<void> {
        const snapshotPath = path.join(this.workspaceRoot, 'runtime_snapshot.jsonl');

        if (!fs.existsSync(snapshotPath)) {
            console.warn(`WARN: runtime_snapshot.jsonl not found at ${snapshotPath}. Proceeding with offline baseline.`);
            return;
        }

        const fileStream = fs.createReadStream(snapshotPath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        let isFirstLine = true;
        let manifest: RuntimeSnapshotManifest | null = null;
        const validEvents: RuntimeEvent[] = [];

        for await (const line of rl) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            if (isFirstLine) {
                isFirstLine = false;
                try {
                    const parsed = JSON.parse(trimmedLine);
                    if (!parsed.repository_commit_hash) {
                        throw new Error('Missing repository_commit_hash in manifest');
                    }
                    manifest = parsed as RuntimeSnapshotManifest;
                } catch (e: any) {
                    console.error(`ERROR: runtime_snapshot schema validation failed. Manifest invalid. ${e.message}`);
                    return; // Abort entire run
                }
                continue;
            }

            try {
                const parsed = JSON.parse(trimmedLine) as RuntimeSnapshotEvent;
                
                // Validate severity
                if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(parsed.severity)) {
                    console.warn(`WARN: Unknown severity ${parsed.severity}. Dropping line.`);
                    continue;
                }

                // If unknown event type, we still keep it.
                // Convert to internal format
                validEvents.push({
                    event_id: parsed.event_id,
                    component_id: parsed.component_id,
                    event_type: parsed.event_type,
                    severity: parsed.severity,
                    payload: parsed.payload || '',
                    timestamp: new Date(parsed.timestamp),
                    repository_commit_hash: manifest!.repository_commit_hash
                });
            } catch (e: any) {
                console.warn(`WARN: Skipped malformed line in snapshot. ${e.message}`);
            }
        }

        if (validEvents.length > 0) {
            // Because duplicate event handling is INSERT OR IGNORE in the store, we can just pass them.
            this.store.appendEvents(validEvents);
        }
    }
}
