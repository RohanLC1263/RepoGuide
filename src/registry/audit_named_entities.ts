import * as path from 'path';
import { LogicalUnitStore } from '../store/logicalUnitStore';

function isMinifiedOrGenerated(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (lower.includes('eval_repos/yarn/')) return true; // Known minified bundle source from previous audits
    if (lower.endsWith('.min.js')) return true;
    if (lower.includes('/dist/')) return true;
    if (lower.includes('/build/')) return true;
    return false;
}

async function runAudit() {
    const repoRoot = process.cwd();
    const unitStore = new LogicalUnitStore();
    await unitStore.init(repoRoot);
    const allUnits = await unitStore.getAll();

    const persistentTypes = new Set(['file', 'class', 'interface', 'function', 'method', 'constant', 'type_alias']);
    
    // Filter out ephemeral and generated code
    const persistentUnits = allUnits.filter(u => 
        persistentTypes.has(u.type) && !isMinifiedOrGenerated(u.filePath)
    );

    console.log(`Total Extractable Units: ${allUnits.length}`);
    console.log(`Total Persistent Entities: ${persistentUnits.length}`);

    // Task 1: Collision Audit
    const signatures = new Map<string, any[]>();
    for (const u of persistentUnits) {
        // Fallback to block symbol if missing (shouldn't happen for these types)
        const sym = u.symbol || 'unnamed';
        const sig = `${u.filePath}::${sym}::${u.type}`;
        if (!signatures.has(sig)) signatures.set(sig, []);
        signatures.get(sig)!.push(u);
    }

    const uniqueSignatures = signatures.size;
    let collisionCount = 0;
    const collisions = [];

    for (const [sig, group] of signatures.entries()) {
        if (group.length > 1) {
            collisionCount++;
            collisions.push({ sig, group });
        }
    }

    const collisionPercentage = (collisionCount / uniqueSignatures) * 100;
    console.log(`\n=== Task 1: Collision Audit ===`);
    console.log(`Unique Signatures: ${uniqueSignatures}`);
    console.log(`Collision Count: ${collisionCount} signatures have >1 entity`);
    console.log(`Collision Percentage: ${collisionPercentage.toFixed(2)}%`);

    // Task 2: False Merge Investigation
    collisions.sort((a, b) => b.group.length - a.group.length);
    console.log(`\n=== Task 2: Top Collisions ===`);
    for (let i = 0; i < Math.min(50, collisions.length); i++) {
        const c = collisions[i];
        console.log(`Signature: ${c.sig} (Count: ${c.group.length})`);
        c.group.forEach(u => {
            console.log(`  - ID: ${u.id} | lines: ${u.startLine}-${u.endLine}`);
        });
    }

    // Task 4: Alias Candidate Validation
    const globalSymbols = new Map<string, Set<string>>();
    for (const [sig, group] of signatures.entries()) {
        const u = group[0];
        const sym = u.symbol || 'unnamed';
        if (sym === 'unnamed' || sym.length < 4) continue; // skip noise
        const key = `${sym}::${u.type}`;
        if (!globalSymbols.has(key)) globalSymbols.set(key, new Set());
        globalSymbols.get(key)!.add(u.filePath);
    }

    let aliasCandidates = 0;
    console.log(`\n=== Task 4: Alias Candidates ===`);
    for (const [key, paths] of globalSymbols.entries()) {
        if (paths.size > 1 && paths.size < 5) { // Filter out extreme noise like 'main' everywhere
            aliasCandidates++;
            if (aliasCandidates <= 10) {
                console.log(`Candidate: ${key} appears in ${paths.size} files`);
                paths.forEach(p => console.log(`  - ${p}`));
            }
        }
    }
    console.log(`Total Alias Candidates (2-4 files): ${aliasCandidates}`);

}

runAudit().catch(console.error);
