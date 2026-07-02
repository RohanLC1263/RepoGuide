import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { EntityRegistryStore } from './entityRegistryStore';

describe('EntityRegistryStore', () => {
    let store: EntityRegistryStore;
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repoguide-registry-test-'));
        store = new EntityRegistryStore(tempDir);
        await store.init(tempDir);
    });

    afterEach(async () => {
        store.close();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should insert and retrieve a record', () => {
        store.insertRecord({
            uuid: 'uuid-1',
            signature: 'sig-1',
            entityType: 'function',
            createdAt: 100,
            lastSeenAt: 100
        });

        const record = store.getRecordBySignature('sig-1');
        assert.ok(record);
        assert.equal(record?.uuid, 'uuid-1');

        const metrics = store.getMetrics();
        assert.equal(metrics.newUuidCount, 1);
        assert.equal(metrics.registryHits, 1);
    });

    it('should throw on signature collision and update metrics', () => {
        store.insertRecord({
            uuid: 'uuid-1',
            signature: 'sig-1',
            entityType: 'function',
            createdAt: 100,
            lastSeenAt: 100
        });

        assert.throws(() => {
            store.insertRecord({
                uuid: 'uuid-2',
                signature: 'sig-1', // Duplicate signature
                entityType: 'function',
                createdAt: 200,
                lastSeenAt: 200
            });
        }, /Signature collision detected/);

        const metrics = store.getMetrics();
        assert.equal(metrics.signatureCollisions, 1);
    });

    it('should return undefined and increment miss metric if not found', () => {
        const record = store.getRecordBySignature('non-existent');
        assert.equal(record, undefined);

        const metrics = store.getMetrics();
        assert.equal(metrics.registryMisses, 1);
    });
});
