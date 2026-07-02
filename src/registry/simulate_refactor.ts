import * as path from 'path';
import { LogicalUnitStore } from '../store/logicalUnitStore';

async function simulate() {
    const repoRoot = process.cwd();
    const unitStore = new LogicalUnitStore();
    await unitStore.init(repoRoot);
    const units = await unitStore.getAll();

    // Group by parent symbol to find a function with multiple branches
    const parentGroups = new Map<string, any[]>();
    for (const u of units) {
        if (u.type === 'branch' && u.parentSymbol) {
            const key = `${u.filePath}::${u.parentSymbol}`;
            if (!parentGroups.has(key)) parentGroups.set(key, []);
            parentGroups.get(key)!.push(u);
        }
    }

    // Find a parent with multiple branches
    const multiBranch = Array.from(parentGroups.entries())
        .filter(([_, arr]) => arr.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);

    console.log(`Found ${multiBranch.length} functions with 3+ branches.`);
    
    if (multiBranch.length > 0) {
        const [key, branches] = multiBranch[0];
        console.log(`\n=== CASE STUDY: ${key} ===`);
        branches.sort((a, b) => a.startLine - b.startLine);
        
        console.log("Original Extractor Output:");
        branches.forEach((b, i) => {
            console.log(`  [Line ${b.startLine}] ${b.symbol} | V2: ${b.symbol}#${i+1}`);
        });

        console.log("\nSimulated Refactor: Insert new branch at the top of the function");
        console.log("Expected New State:");
        console.log(`  [Line XX] NEW_BRANCH | V2: ${branches[0].symbol}#1 (HIJACKS UUID of old #1)`);
        branches.forEach((b, i) => {
            console.log(`  [Line ${b.startLine + 5}] ${b.symbol} | V2: ${b.symbol}#${i+2} (UUID CHANGED)`);
        });
    }

    // Measure overall UUID retention rate under branch insertion
    let totalBranches = 0;
    let corruptedBranches = 0;
    for (const [key, branches] of multiBranch) {
        totalBranches += branches.length;
        // If we insert 1 branch at the top, ALL existing branches shift index and lose UUID
        corruptedBranches += branches.length;
    }

    console.log(`\n=== UUID Retention Analysis ===`);
    console.log(`Total Branch Entities in multi-branch functions: ${totalBranches}`);
    console.log(`If one branch is inserted at the top of every function:`);
    console.log(`Corrupted UUIDs (V2-occurrenceIndex): ${corruptedBranches} (${(corruptedBranches/totalBranches*100).toFixed(1)}%)`);

}

simulate().catch(console.error);
