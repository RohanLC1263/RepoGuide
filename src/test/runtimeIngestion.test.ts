import test, { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { RuntimeStore } from '../runtime/runtimeStore';
import { RuntimeIngestionBuilder } from '../runtime/runtimeIngestionBuilder';

describe('Component 25 Phase A: Schema & Ingestion', () => {
    let db: DatabaseSync;
    let store: RuntimeStore;
    let workspaceRoot: string;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        store = new RuntimeStore(db);
        workspaceRoot = path.join(__dirname, 'mock_workspace_' + Date.now() + Math.random().toString(36).substring(7));
        fs.mkdirSync(workspaceRoot, { recursive: true });
    });

    afterEach(() => {
        db.close();
        if (fs.existsSync(workspaceRoot)) {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('Schema creation and table initialization', () => {
        const tablesQuery = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`);
        const tables = tablesQuery.all() as {name: string}[];
        const tableNames = tables.map(t => t.name);

        assert.ok(tableNames.includes('runtime_components'));
        assert.ok(tableNames.includes('runtime_events'));
        assert.ok(tableNames.includes('runtime_repository_mappings'));
        assert.ok(tableNames.includes('runtime_health_history'));
        assert.ok(tableNames.includes('runtime_patterns'));
        assert.ok(tableNames.includes('runtime_calibration_weight_history'));
        assert.ok(tableNames.includes('runtime_baselines'));
    });

    it('Ingestion skips when snapshot file is missing', async () => {
        const builder = new RuntimeIngestionBuilder(store, workspaceRoot);
        await builder.build();

        const countQuery = db.prepare(`SELECT COUNT(*) as c FROM runtime_events`);
        const result = countQuery.get() as { c: number };
        assert.equal(result.c, 0);
    });

    it('repository_commit_hash validation fails and drops everything on missing hash', async () => {
        const snapshotPath = path.join(workspaceRoot, 'runtime_snapshot.jsonl');
        const lines = [
            JSON.stringify({ "wrong_key": "abc" }),
            JSON.stringify({ event_id: "e1", component_id: "c1", event_type: "ERROR", severity: "CRITICAL", timestamp: new Date().toISOString() })
        ];
        fs.writeFileSync(snapshotPath, lines.join('\n'));

        const builder = new RuntimeIngestionBuilder(store, workspaceRoot);
        await builder.build();

        const countQuery = db.prepare(`SELECT COUNT(*) as c FROM runtime_events`);
        const result = countQuery.get() as { c: number };
        assert.equal(result.c, 0);
    });

    it('Ingestion succeeds, skips malformed row, filters invalid severity, deduplicates', async () => {
        store.upsertComponent({ component_id: 'c1', description: 'desc 1' });
        store.upsertComponent({ component_id: 'c2', description: 'desc 2' });

        const snapshotPath = path.join(workspaceRoot, 'runtime_snapshot.jsonl');
        const ts1 = new Date().toISOString();
        const lines = [
            JSON.stringify({ repository_commit_hash: "abc1234" }),
            JSON.stringify({ event_id: "e1", component_id: "c1", event_type: "ERROR", severity: "CRITICAL", timestamp: ts1 }),
            JSON.stringify({ event_id: "e2", component_id: "c2", event_type: "ERROR", severity: "UNKNOWN_SEV", timestamp: ts1 }),
            "this is a malformed row",
            JSON.stringify({ event_id: "e1", component_id: "c1", event_type: "ERROR", severity: "CRITICAL", timestamp: ts1 }),
            JSON.stringify({ event_id: "e3", component_id: "c2", event_type: "TIMEOUT", severity: "HIGH", timestamp: ts1 })
        ];
        fs.writeFileSync(snapshotPath, lines.join('\n'));

        const builder = new RuntimeIngestionBuilder(store, workspaceRoot);
        await builder.build();

        const countQuery = db.prepare(`SELECT COUNT(*) as c FROM runtime_events`);
        const result = countQuery.get() as { c: number };
        assert.equal(result.c, 2);

        const e1 = db.prepare(`SELECT * FROM runtime_events WHERE event_id = 'e1'`).get() as any;
        assert.equal(e1.repository_commit_hash, "abc1234");
        assert.equal(e1.severity, "CRITICAL");
    });
});
