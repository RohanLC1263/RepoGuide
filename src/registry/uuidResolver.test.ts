import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { EntityRegistryStore } from './entityRegistryStore';
import { UUIDResolver } from './uuidResolver';
import { EntitySignature } from './types';

describe('UUIDResolver', () => {
    let store: EntityRegistryStore;
    let resolver: UUIDResolver;
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repoguide-resolver-test-'));
        store = new EntityRegistryStore(tempDir);
        await store.init(tempDir);
        resolver = new UUIDResolver(store);
    });

    afterEach(async () => {
        store.close();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should generate a new UUID for an unknown signature', () => {
        const sig: EntitySignature = { filePath: 'foo.ts', symbol: 'bar', type: 'function' };
        const uuid1 = resolver.resolveUUID(sig);
        
        assert.ok(uuid1);
        assert.equal(uuid1.length > 0, true);
        
        const metrics = store.getMetrics();
        assert.equal(metrics.newUuidCount, 1);
    });

    it('should return the exact same UUID for a known signature', () => {
        const sig: EntitySignature = { filePath: 'foo.ts', symbol: 'bar', type: 'function' };
        const uuid1 = resolver.resolveUUID(sig);
        const uuid2 = resolver.resolveUUID(sig);
        
        assert.equal(uuid1, uuid2);
        
        const metrics = store.getMetrics();
        assert.equal(metrics.newUuidCount, 1);
        assert.equal(metrics.registryHits, 1); // One hit for the second lookup
    });

    it('should resolve through alias if present', () => {
        // Direct hack for test to insert alias since we dont have public API for alias insert yet
        const sig: EntitySignature = { filePath: 'old.ts', symbol: 'bar', type: 'function' };
        const uuid1 = resolver.resolveUUID(sig);

        // Manually insert alias for new.ts -> uuid1
        const newSigStr = 'new.ts::bar::function';
        // Note: the test simulates a rename from old.ts to new.ts
        // In reality, the alias system maps old -> new or vice versa.
        // We'll just insert an alias into DB for the test.
        const db = (store as any).db;
        db.exec(`INSERT INTO signature_aliases (old_signature, new_signature, uuid, timestamp) 
                 VALUES ('${newSigStr}', 'old.ts::bar::function', '${uuid1}', 0)`);
        
        const newSig: EntitySignature = { filePath: 'new.ts', symbol: 'bar', type: 'function' };
        const resolvedUuid = resolver.resolveUUID(newSig);

        assert.equal(resolvedUuid, uuid1);
        const metrics = store.getMetrics();
        assert.equal(metrics.aliasResolutions, 1);
    });
});
