import { DatabaseSync } from 'node:sqlite';
import { OrchestratorState, OrchestratorStatus } from './orchestratorTypes';

export class OrchestratorStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS orchestrator_state (
                id TEXT PRIMARY KEY,
                last_full_rebuild_start TEXT,
                last_full_rebuild_end TEXT,
                status TEXT,
                failed_at_step TEXT,
                diagnostics TEXT
            );
        `);
    }

    public getState(id: string = 'GLOBAL'): OrchestratorState | null {
        const row = this.db.prepare(`SELECT * FROM orchestrator_state WHERE id = ?`).get(id) as any;
        if (!row) return null;
        return {
            id: row.id,
            lastFullRebuildStart: new Date(row.last_full_rebuild_start),
            lastFullRebuildEnd: row.last_full_rebuild_end ? new Date(row.last_full_rebuild_end) : null,
            status: row.status as OrchestratorStatus,
            failedAtStep: row.failed_at_step,
            diagnostics: row.diagnostics
        };
    }

    public saveState(state: OrchestratorState): void {
        const stmt = this.db.prepare(`
            INSERT INTO orchestrator_state (id, last_full_rebuild_start, last_full_rebuild_end, status, failed_at_step, diagnostics)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                last_full_rebuild_start=excluded.last_full_rebuild_start,
                last_full_rebuild_end=excluded.last_full_rebuild_end,
                status=excluded.status,
                failed_at_step=excluded.failed_at_step,
                diagnostics=excluded.diagnostics
        `);
        stmt.run(
            state.id,
            state.lastFullRebuildStart.toISOString(),
            state.lastFullRebuildEnd ? state.lastFullRebuildEnd.toISOString() : null,
            state.status,
            state.failedAtStep,
            state.diagnostics
        );
    }
}
