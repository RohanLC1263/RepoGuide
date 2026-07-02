import * as path from 'path';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import * as crypto from 'crypto';

async function investigate() {
    const repoRoot = process.cwd();
    const unitStore = new LogicalUnitStore();
    await unitStore.init(repoRoot);
    const units = await unitStore.getAll();

    // Task 1: Taxonomy Audit
    const typeCounts = new Map<string, number>();
    for (const u of units) {
        typeCounts.set(u.type, (typeCounts.get(u.type) || 0) + 1);
    }
    console.log("=== Taxonomy Audit ===");
    for (const [type, count] of typeCounts.entries()) {
        console.log(`${type}: ${count}`);
    }

    // Task 5: Minified Code
    let minifiedCollisions = 0;
    const yarnMinified = units.filter(u => u.filePath.includes('eval_repos/yarn/packages/'));
    console.log(`\n=== Minified Code ===`);
    console.log(`Units in Yarn eval_repos: ${yarnMinified.length}`);

    // Task 2 & 3: Structural Path & Content Hash available?
    // Let's see what a sample of tricky units look like.
    const branches = units.filter(u => u.type === 'branch' && u.symbol && u.symbol.includes('.if'));
    console.log(`\n=== Sample Branch Entity ===`);
    if (branches.length > 0) {
        console.log(JSON.stringify(branches[0], null, 2));
    }

    const mdBlocks = units.filter(u => u.filePath.endsWith('.md') && u.type === 'prompt_template');
    console.log(`\n=== Sample MD Block Entity ===`);
    if (mdBlocks.length > 0) {
        console.log(JSON.stringify(mdBlocks[0], null, 2));
    }
}

investigate().catch(console.error);
