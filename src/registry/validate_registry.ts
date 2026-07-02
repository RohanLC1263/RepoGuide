import * as path from 'path';
import { EntityRegistryStore } from './entityRegistryStore';

async function validateRegistry(repoRoot: string) {
    const store = new EntityRegistryStore();
    try {
        await store.init(repoRoot);
    } catch (e) {
        console.error('Failed to initialize registry:', e);
        process.exit(1);
    }

    const records = store.getAllRecords();
    const metrics = store.getMetrics();

    const uniqueSignatures = new Set<string>();
    const duplicateSignatures = new Map<string, number>();

    let totalEntities = records.length;

    for (const record of records) {
        if (uniqueSignatures.has(record.signature)) {
            duplicateSignatures.set(record.signature, (duplicateSignatures.get(record.signature) || 1) + 1);
        } else {
            uniqueSignatures.add(record.signature);
        }
    }

    // A UUID is reused if the number of unique signatures is greater than the number of unique UUIDs.
    // Since our UUID to signature mapping is 1:1 unless aliases are used, let's see unique UUIDs.
    const uniqueUuids = new Set(records.map(r => r.uuid));
    const uuidReuseRate = totalEntities > 0 
        ? ((totalEntities - uniqueUuids.size) / totalEntities) * 100 
        : 0;

    // Potential Alias Candidates (same symbol and type, different path)
    // Map of symbol::type -> Set of filePaths
    const symbolMap = new Map<string, Set<string>>();
    for (const sig of uniqueSignatures) {
        const parts = sig.split('::');
        if (parts.length >= 3) {
            const filePath = parts[0];
            const symbol = parts[1];
            const type = parts[2];
            const key = `${symbol}::${type}`;
            if (!symbolMap.has(key)) {
                symbolMap.set(key, new Set());
            }
            symbolMap.get(key)!.add(filePath);
        }
    }

    let aliasCandidates = 0;
    for (const [key, paths] of symbolMap.entries()) {
        if (paths.size > 1) {
            aliasCandidates += paths.size; // These are candidate instances
        }
    }

    console.log('--- Registry Validation Report ---');
    console.log(`Total Entities:           ${totalEntities}`);
    console.log(`Unique Signatures:        ${uniqueSignatures.size}`);
    console.log(`Duplicate Signatures:     ${Array.from(duplicateSignatures.values()).reduce((a, b) => a + b, 0)}`);
    console.log(`UUID Reuse Rate:          ${uuidReuseRate.toFixed(2)}%`);
    console.log(`Potential Alias Cands:    ${aliasCandidates}`);
    console.log(`Registry Hits:            ${metrics.registryHits}`);
    console.log(`Registry Misses:          ${metrics.registryMisses}`);
    console.log(`Signature Collision Cnt:  ${metrics.signatureCollisions}`);
    console.log(`New UUID Count:           ${metrics.newUuidCount}`);
    console.log(`Alias Resolutions:        ${metrics.aliasResolutions}`);
    console.log('----------------------------------');
}

// Simple CLI runner
const repoRoot = process.argv[2] || process.cwd();
validateRegistry(repoRoot).catch(console.error);
