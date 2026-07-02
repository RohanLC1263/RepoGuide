import * as path from 'path';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { ProgramGraphBuilder } from './programGraphBuilder';

// Basic PageRank
function computePageRank(nodes: string[], edges: any[], iterations=20, d=0.85) {
    const scores = new Map<string, number>();
    const n = nodes.length;
    if (n === 0) return scores;

    nodes.forEach(node => scores.set(node, 1 / n));

    const outDegree = new Map<string, number>();
    const inEdges = new Map<string, string[]>();

    for (const node of nodes) {
        outDegree.set(node, 0);
        inEdges.set(node, []);
    }

    for (const edge of edges) {
        if (!outDegree.has(edge.from)) continue;
        if (!inEdges.has(edge.to)) continue;
        
        outDegree.set(edge.from, outDegree.get(edge.from)! + 1);
        inEdges.get(edge.to)!.push(edge.from);
    }

    for (let iter = 0; iter < iterations; iter++) {
        const newScores = new Map<string, number>();
        let sinkContrib = 0;

        for (const node of nodes) {
            if (outDegree.get(node) === 0) {
                sinkContrib += scores.get(node)! / n;
            }
        }

        for (const node of nodes) {
            let rank = 0;
            for (const inNode of inEdges.get(node)!) {
                rank += scores.get(inNode)! / outDegree.get(inNode)!;
            }
            const newScore = (1 - d) / n + d * (rank + sinkContrib);
            newScores.set(node, newScore);
        }

        for (const [node, score] of newScores.entries()) {
            scores.set(node, score);
        }
    }
    return scores;
}

// Simple Community Detection (Label Propagation)
function detectCommunities(nodes: string[], edges: any[], iterations=10) {
    const labels = new Map<string, string>();
    nodes.forEach(n => labels.set(n, n));

    const adjacency = new Map<string, string[]>();
    nodes.forEach(n => adjacency.set(n, []));
    for (const edge of edges) {
        if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
            adjacency.get(edge.from)!.push(edge.to);
            adjacency.get(edge.to)!.push(edge.from);
        }
    }

    for (let iter = 0; iter < iterations; iter++) {
        // randomize order
        const shuffled = [...nodes].sort(() => Math.random() - 0.5);
        for (const node of shuffled) {
            const neighbors = adjacency.get(node)!;
            if (neighbors.length === 0) continue;

            const counts = new Map<string, number>();
            for (const neighbor of neighbors) {
                const label = labels.get(neighbor)!;
                counts.set(label, (counts.get(label) || 0) + 1);
            }

            let bestLabel = labels.get(node)!;
            let maxCount = 0;
            for (const [label, count] of counts.entries()) {
                if (count > maxCount) {
                    maxCount = count;
                    bestLabel = label;
                }
            }
            labels.set(node, bestLabel);
        }
    }
    
    const communities = new Map<string, string[]>();
    for (const [node, label] of labels.entries()) {
        if (!communities.has(label)) communities.set(label, []);
        communities.get(label)!.push(node);
    }
    return communities;
}

async function run() {
    const repoRoot = process.cwd();
    const unitStore = new LogicalUnitStore();
    const factStore = new FactStore();
    
    await unitStore.init(repoRoot);
    await factStore.init(repoRoot);

    const builder = new ProgramGraphBuilder();
    console.log("Building Original Graph...");
    const originalGraph = await builder.build(unitStore, factStore, repoRoot);

    const origNodes = Object.keys(originalGraph.nodes);
    const origEdges = originalGraph.edges;

    console.log(`Original Graph: ${origNodes.length} nodes, ${origEdges.length} edges`);

    // Build Rolled-Up Graph
    const ephemeralTypes = new Set(['branch', 'loop', 'import_block', 'prompt_template', 'if', 'for', 'while']);
    const rolledUpNodesList = [];
    const parentMap = new Map<string, string>(); // ephemeral node id -> nearest persistent parent id

    const units = await unitStore.getAll();
    const unitMap = new Map<string, any>();
    units.forEach(u => unitMap.set(u.id, u));

    // Find parents for ephemeral nodes
    for (const unit of units) {
        if (ephemeralTypes.has(unit.type)) {
            // Find parent
            let current = unit;
            while (current && ephemeralTypes.has(current.type) && current.parentUnitId) {
                current = unitMap.get(current.parentUnitId);
            }
            if (current && !ephemeralTypes.has(current.type)) {
                parentMap.set(unit.id, current.id);
            } else {
                parentMap.set(unit.id, unit.filePath); // fallback to file
            }
        } else {
            rolledUpNodesList.push(unit.id);
        }
    }

    // Rewrite edges
    const rolledUpEdgesList = [];
    for (const edge of origEdges) {
        let from = edge.from;
        let to = edge.to;
        if (parentMap.has(from)) from = parentMap.get(from)!;
        if (parentMap.has(to)) to = parentMap.get(to)!;
        if (from !== to) {
            rolledUpEdgesList.push({ from, to, type: edge.type, weight: edge.weight, metadata: edge.metadata });
        }
    }

    console.log(`Rolled-Up Graph: ${rolledUpNodesList.length} nodes, ${rolledUpEdgesList.length} edges`);

    // PageRank Analysis
    console.log("\n--- PageRank ---");
    const origPR = computePageRank(origNodes, origEdges);
    const rolledPR = computePageRank(rolledUpNodesList, rolledUpEdgesList);

    const topOrig = Array.from(origPR.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topRolled = Array.from(rolledPR.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);

    console.log("Top 10 Original:");
    topOrig.forEach((x, i) => console.log(`  ${i+1}. ${x[0]} (${x[1].toFixed(5)})`));
    console.log("Top 10 Rolled-Up:");
    topRolled.forEach((x, i) => console.log(`  ${i+1}. ${x[0]} (${x[1].toFixed(5)})`));

    // Community Detection Analysis
    console.log("\n--- Community Detection ---");
    const origComms = detectCommunities(origNodes, origEdges);
    const rolledComms = detectCommunities(rolledUpNodesList, rolledUpEdgesList);

    console.log(`Original: ${origComms.size} communities`);
    const origLens = Array.from(origComms.values()).map(x => x.length);
    console.log(`  Avg size: ${(origLens.reduce((a,b)=>a+b,0)/origLens.length).toFixed(1)}, Max size: ${Math.max(...origLens)}`);

    console.log(`Rolled-Up: ${rolledComms.size} communities`);
    const rolledLens = Array.from(rolledComms.values()).map(x => x.length);
    console.log(`  Avg size: ${(rolledLens.reduce((a,b)=>a+b,0)/rolledLens.length).toFixed(1)}, Max size: ${Math.max(...rolledLens)}`);

    // Fact Rollup Analysis
    console.log("\n--- Fact Rollup Analysis ---");
    const factTypes = new Map<string, number>();
    let rolledCount = 0;
    origEdges.forEach(e => {
        if (parentMap.has(e.from) || parentMap.has(e.to)) {
            rolledCount++;
            factTypes.set(e.type, (factTypes.get(e.type) || 0) + 1);
        }
    });
    console.log(`Total edges rolled up: ${rolledCount}`);
    for (const [k, v] of factTypes.entries()) {
        console.log(`  ${k}: ${v}`);
    }
}

run().catch(console.error);
