import * as path from 'path';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { SignatureGenerator } from './signatureGenerator';

async function auditRegistry(repoRoot: string) {
    console.log(`Starting Registry Audit for ${repoRoot}`);
    
    const unitStore = new LogicalUnitStore();
    await unitStore.init(repoRoot);
    const units = await unitStore.getAll();
    
    console.log(`Total Logical Units in DB: ${units.length}`);

    // Map signature -> list of LogicalUnit IDs
    const signatureToLUs = new Map<string, any[]>();
    
    // Map of symbol::type -> list of filePath::symbol::type
    const aliasCandidates = new Map<string, Set<string>>();

    for (const unit of units) {
        const sigStr = SignatureGenerator.generate({
            filePath: unit.filePath,
            symbol: unit.symbol,
            type: unit.type
        });

        if (!signatureToLUs.has(sigStr)) {
            signatureToLUs.set(sigStr, []);
        }
        signatureToLUs.get(sigStr)!.push(unit);

        // Alias tracking
        const symbol = unit.symbol || 'block';
        const key = `${symbol}::${unit.type}`;
        if (!aliasCandidates.has(key)) {
            aliasCandidates.set(key, new Set());
        }
        aliasCandidates.get(key)!.add(sigStr);
    }

    console.log(`Unique Signatures Generated: ${signatureToLUs.size}`);

    // TASK 1: Collision Analysis (excluding .md files for clarity)
    const collisions = Array.from(signatureToLUs.entries())
        .filter(([sig, arr]) => arr.length > 1 && !sig.includes('.md::'))
        .sort((a, b) => b[1].length - a[1].length);

    console.log(`\n=== TOP 50 COLLISIONS ===`);
    let count = 0;
    for (const [sig, arr] of collisions) {
        if (count >= 50) break;
        console.log(`\nSignature: ${sig} (Count: ${arr.length})`);
        // Show first 3 LUs for this signature
        for (let i = 0; i < Math.min(3, arr.length); i++) {
            console.log(`  - ID: ${arr[i].id} | symbol: ${arr[i].symbol || 'N/A'} | type: ${arr[i].type} | lines: ${arr[i].startLine}-${arr[i].endLine}`);
        }
        count++;
    }

    // TASK 3: Alias Candidate Analysis
    console.log(`\n=== ALIAS CANDIDATE ANALYSIS ===`);
    let actualAliasGroups = 0;
    let actualAliasPaths = 0;
    let noisyAliasGroups = 0;

    for (const [key, sigs] of aliasCandidates.entries()) {
        if (sigs.size > 1) {
            // Is it noise? If symbol is 'block', it's noise.
            if (key.startsWith('block::') || key.startsWith('unknown::')) {
                noisyAliasGroups++;
            } else {
                actualAliasGroups++;
                actualAliasPaths += sigs.size;
            }
        }
    }
    console.log(`Total symbol::type groups with >1 file: ${actualAliasGroups + noisyAliasGroups}`);
    console.log(`Noisy Groups (symbol is block/unknown): ${noisyAliasGroups}`);
    console.log(`Potentially Real Alias Groups: ${actualAliasGroups}`);
    console.log(`Potentially Real Alias Paths involved: ${actualAliasPaths}`);

    console.log(`\n=== EXAMPLES OF REAL ALIAS CANDIDATES ===`);
    let aliasCount = 0;
    for (const [key, sigs] of aliasCandidates.entries()) {
        if (sigs.size > 1 && !key.startsWith('block::') && !key.startsWith('unknown::')) {
            console.log(`\nSymbol/Type: ${key}`);
            for (const sig of Array.from(sigs).slice(0, 3)) {
                console.log(`  - ${sig}`);
            }
            if (sigs.size > 3) console.log(`  ... and ${sigs.size - 3} more`);
            aliasCount++;
            if (aliasCount >= 10) break;
        }
    }

}

const repoRoot = process.argv[2] || process.cwd();
auditRegistry(repoRoot).catch(console.error);
