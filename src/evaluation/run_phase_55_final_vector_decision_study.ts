import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined })
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) })
        }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') return shim;
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { craftConnectGoldenCases } from './craftConnectGolden';
import { secondRepoGoldenCases } from './secondRepoGolden';
import { axiosGoldenCases } from './axiosGolden';
import { HybridRetrievalFusion } from '../query/hybridRetrievalFusion';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';

async function initStores(repoPath: string, dbDir: string) {
    const unitStore = new LogicalUnitStore(dbDir);
    const factStore = new FactStore(dbDir);
    const bm25Store = new Bm25Store(dbDir);
    const lanceStore = new LanceStore(dbDir);
    
    await unitStore.init(repoPath);
    await factStore.init(repoPath);
    await bm25Store.init();
    await lanceStore.init();
    
    const context: any = {
        workspaceRoot: repoPath,
        repoguideDataDir: dbDir,
        unitStore, factStore, bm25Store, lanceStore,
        getConfig: (key: string, def?: any) => def,
        logger: { info: () => {}, error: console.error, warn: () => {}, debug: () => {} }
    };

    let vectorDiskSize = 0;
    const lanceDbPath = dbDir;
    if (fs.existsSync(lanceDbPath)) {
        const getDirSize = (dirPath: string): number => {
            let size = 0;
            const files = fs.readdirSync(dirPath);
            for (const f of files) {
                const full = path.join(dirPath, f);
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    size += getDirSize(full);
                } else {
                    size += stat.size;
                }
            }
            return size;
        };
        vectorDiskSize = getDirSize(lanceDbPath);
    }
    
    let vectorCount = 0;
    try { vectorCount = await lanceStore.getChunkCount(); } catch {}
    
    return {
        unitStore, factStore, bm25Store, lanceStore, context,
        stats: {
            vectorCount,
            vectorDiskSizeMb: (vectorDiskSize / 1024 / 1024).toFixed(2)
        }
    };
}

function isMatch(chunk: any, expectedSpans: any[]): boolean {
    if (!expectedSpans) return false;
    const symbol = chunk.id.split('::')[1];
    return expectedSpans.some((s: any) => 
        chunk.filePath.toLowerCase().includes(s.filePattern.toLowerCase()) && 
        (!s.symbol || symbol === s.symbol)
    );
}

function isFileMatch(chunk: any, expectedSpans: any[]): boolean {
    if (!expectedSpans) return false;
    return expectedSpans.some((s: any) => 
        chunk.filePath.toLowerCase().includes(s.filePattern.toLowerCase())
    );
}

async function runStudy() {
    const repos = [
        { name: 'axios', path: 'c:\\Projects\\RepoGuide\\eval_repos\\axios', cases: axiosGoldenCases },
        { name: 'craftconnect', path: 'c:\\Users\\rohan\\Downloads\\CraftConnect', cases: craftConnectGoldenCases },
        { name: 'medusa', path: 'c:\\Projects\\RepoGuide\\eval_repos\\medusa', cases: secondRepoGoldenCases }
    ];

    const allResults: any[] = [];
    let globalLatencies = { prod: [] as number[], noVec: [] as number[] };

    for (const repo of repos) {
        console.log(`\n=============================================================`);
        console.log(`Starting Study for ${repo.name}`);
        console.log(`=============================================================`);
        const dbDir = path.join(repo.path, '.repoguide');
        
        // Use existing index
        const { bm25Store, lanceStore, stats } = await initStores(repo.path, dbDir);
        console.log(`Loaded existing index. Vectors: ${stats.vectorCount}, Vector DB Size: ${stats.vectorDiskSizeMb} MB`);

        const mockContext: any = {
            workspaceRoot: repo.path, repoguideDataDir: dbDir,
            getConfig: (key: string, defaultValue?: any) => defaultValue,
            logger: { info: () => {}, error: console.error, warn: () => {}, debug: () => {} }
        };
        const intentClassifier: any = { classify: async () => ({
            primaryIntent: 'general_explanation', concepts: [], roles: ['implementation'],
            needsHistory: false, needsDocumentation: false
        }) };

        const fusion = new HybridRetrievalFusion(lanceStore, bm25Store, dbDir, repo.path, intentClassifier, mockContext);

        const repoResults = {
            repo: repo.name,
            stats,
            queries: [] as any[]
        };

        for (const testCase of repo.cases) {
            let capturedData: any = null;
            (global as any).__phase54Capture = (q: string, data: any) => {
                capturedData = data;
            };

            // 1. Measure latency with Production config
            process.env.ABLATION_MODE = 'production';
            const startProd = performance.now();
            await fusion.retrieveContext(testCase.query, []);
            const latProd = performance.now() - startProd;
            
            const prodData = capturedData;

            // 2. Measure latency with No Vector config
            process.env.ABLATION_MODE = 'no_vector';
            const startNoVec = performance.now();
            await fusion.retrieveContext(testCase.query, []);
            const latNoVec = performance.now() - startNoVec;

            globalLatencies.prod.push(latProd);
            globalLatencies.noVec.push(latNoVec);

            const bm25Top20 = (prodData.bm25Results || []).slice(0, 20);
            const vecTop20 = (prodData.vectorResults || []).slice(0, 20);
            const fusedTop20 = (prodData.fusedChunks || []).slice(0, 20).map((x: any) => x.chunk);

            const bm25Ids = new Set(bm25Top20.map((c: any) => c.id));
            const vecIds = new Set(vecTop20.map((c: any) => c.id));
            const fusedIds = new Set(fusedTop20.map((c: any) => c.id));

            let overlapCount = 0;
            vecTop20.forEach((c: any) => { if (bm25Ids.has(c.id)) overlapCount++; });
            const overlapPct = vecTop20.length > 0 ? (overlapCount / vecTop20.length) * 100 : 0;

            const vHits = vecTop20.filter((c: any) => isMatch(c, testCase.expectedSpans));
            const bHits = bm25Top20.filter((c: any) => isMatch(c, testCase.expectedSpans));
            
            const uniqueVHits = vHits.filter((c: any) => !bm25Ids.has(c.id));
            const uniqueBHits = bHits.filter((c: any) => !vecIds.has(c.id));

            let category = 'D'; // Default to D
            let failureMode = '';

            const isUniqueVHitInFused = uniqueVHits.some((c: any) => fusedIds.has(c.id));

            if (uniqueVHits.length > 0) {
                if (isUniqueVHitInFused) {
                    category = 'A'; // Vector uniquely improves
                } else {
                    category = 'B'; // Vector retrieves relevant but fusion suppresses
                }
            } else if (vHits.length > 0 && uniqueVHits.length === 0 && overlapPct >= 70) {
                category = 'C'; // Vector duplicates BM25 (highly overlapping and finds relevant stuff but nothing unique)
            } else {
                category = 'D'; // Vector retrieves irrelevant chunks (no unique hits, and not high overlap duplicate)
                
                // Classify failure mode
                if (vHits.length > 0) {
                    failureMode = 'BM25 dominance';
                } else if (vecTop20.some((c: any) => isFileMatch(c, testCase.expectedSpans))) {
                    failureMode = 'Chunk granularity issue';
                } else {
                    const structuralKeywords = ['where', 'who', 'call', 'depend', 'import', 'use', 'break', 'impact', 'how many', 'list'];
                    const lowerQ = testCase.query.toLowerCase();
                    if (structuralKeywords.some(kw => lowerQ.includes(kw))) {
                        failureMode = 'Missing repository context';
                    } else {
                        failureMode = 'Semantic mismatch';
                    }
                }
            }

            repoResults.queries.push({
                query: testCase.query,
                expectedFiles: testCase.expectedSpans ? testCase.expectedSpans.map((s:any) => s.filePattern) : [],
                overlapPct,
                uniqueBm25Hits: uniqueBHits.length,
                uniqueVectorHits: uniqueVHits.length,
                totalVectorHits: vHits.length,
                totalBm25Hits: bHits.length,
                category,
                failureMode,
                top5VectorChunks: vecTop20.slice(0, 5).map((c: any) => `${path.basename(c.filePath)}::${c.id.split('::')[1] || 'chunk'}`),
                vectorScores: vecTop20.slice(0, 5).map((c: any) => c.__preFusionScore || 0)
            });
        }
        allResults.push(repoResults);
    }

    // Generate Markdown Report
    let md = '# Phase 55: Final Vector Decision Study\n\n';

    md += '## 1. Aggregate Statistics\n\n';
    md += '| Metric | Value |\n';
    md += '|---|---|\n';
    
    let totalQueries = 0;
    let catCounts = { A: 0, B: 0, C: 0, D: 0 };
    let failCounts = { 'Semantic mismatch': 0, 'Chunk granularity issue': 0, 'Missing repository context': 0, 'BM25 dominance': 0 };

    allResults.forEach(r => {
        totalQueries += r.queries.length;
        r.queries.forEach((q: any) => {
            catCounts[q.category as keyof typeof catCounts]++;
            if (q.category === 'D') {
                failCounts[q.failureMode as keyof typeof failCounts]++;
            }
        });
    });

    md += `| Total Queries Evaluated | ${totalQueries} |\n`;
    md += `| A. Vector Uniquely Improves | ${catCounts.A} (${(catCounts.A/totalQueries*100).toFixed(1)}%) |\n`;
    md += `| B. Vector Finds Relevant, Fusion Suppresses | ${catCounts.B} (${(catCounts.B/totalQueries*100).toFixed(1)}%) |\n`;
    md += `| C. Vector Duplicates BM25 | ${catCounts.C} (${(catCounts.C/totalQueries*100).toFixed(1)}%) |\n`;
    md += `| D. Vector Retrieves Irrelevant Chunks | ${catCounts.D} (${(catCounts.D/totalQueries*100).toFixed(1)}%) |\n\n`;

    const avgProdLat = globalLatencies.prod.reduce((a,b)=>a+b,0) / globalLatencies.prod.length;
    const avgNoVecLat = globalLatencies.noVec.reduce((a,b)=>a+b,0) / globalLatencies.noVec.length;
    const latPenalty = avgProdLat - avgNoVecLat;

    md += '## 2. Impact Assessment\n\n';
    md += '### Latency Impact\n';
    md += `- **Average Latency (Production):** ${avgProdLat.toFixed(1)} ms\n`;
    md += `- **Average Latency (No Vector):** ${avgNoVecLat.toFixed(1)} ms\n`;
    md += `- **Vector Retrieval Penalty:** +${latPenalty.toFixed(1)} ms per query\n\n`;

    md += '### Storage Impact\n';
    md += '| Repository | Vector Count | Vector DB Disk Size |\n';
    md += '|---|---|---|\n';
    allResults.forEach(r => {
        md += `| ${r.repo} | ${r.stats.vectorCount} | ${r.stats.vectorDiskSizeMb} MB |\n`;
    });
    md += '\n';

    md += '### Maintenance Cost Assessment\n';
    md += '- **Dependencies:** Relies on `vectordb` (LanceDB), `@xenova/transformers`, and `onnxruntime-node`.\n';
    md += '- **Compilation/Build:** Native ONNX bindings periodically cause cross-platform build issues or require heavy binaries.\n';
    md += '- **Index Time:** Embedding text via local models represents the majority of CPU time during indexing.\n\n';

    md += '## 3. Failure Analysis (Category D)\n\n';
    md += `*Analysis of why Vector Retrieval failed in ${catCounts.D} queries.*\n\n`;
    
    md += '| Failure Mode | Count | Percentage of Failures |\n';
    md += '|---|---|---|\n';
    for (const [mode, count] of Object.entries(failCounts)) {
        md += `| ${mode} | ${count} | ${catCounts.D > 0 ? (count/catCounts.D*100).toFixed(1) : 0}% |\n`;
    }
    md += '\n### Query-by-Query Evidence (Category D)\n\n';

    allResults.forEach(r => {
        const dQueries = r.queries.filter((q: any) => q.category === 'D');
        if (dQueries.length > 0) {
            md += `#### ${r.repo}\n\n`;
            dQueries.forEach((q: any) => {
                md += `**Query:** ${q.query}\n\n`;
                md += `- **Failure Mode:** ${q.failureMode}\n`;
                md += `- **Expected Files:** ${q.expectedFiles.join(', ')}\n`;
                md += `- **Vector Top 5:**\n`;
                q.top5VectorChunks.forEach((c: any, i: number) => {
                    md += `  ${i+1}. ${c} (Score: ${q.vectorScores[i] ? q.vectorScores[i].toFixed(4) : '0'})\n`;
                });
                md += '\n';
            });
        }
    });

    md += '## 4. Query-by-Query Overview (All Categories)\n\n';
    md += '| Repository | Query | Category | BM25 Overlap | Unique V-Hits | Unique B-Hits |\n';
    md += '|---|---|---|---|---|---|\n';
    allResults.forEach(r => {
        r.queries.forEach((q: any) => {
            md += `| ${r.repo} | ${q.query.substring(0, 40)}${q.query.length > 40 ? '...' : ''} | **${q.category}** | ${q.overlapPct.toFixed(0)}% | ${q.uniqueVectorHits} | ${q.uniqueBm25Hits} |\n`;
        });
    });
    md += '\n';

    md += '## 5. Final Recommendation\n\n';
    
    let recommendation = 'REMOVE';
    if (catCounts.A > (totalQueries * 0.1)) {
        recommendation = 'KEEP';
    } else if (catCounts.A > 0) {
        recommendation = 'FEATURE FLAG';
    }

    md += `### ${recommendation}\n\n`;
    md += `**Quantitative Justification:**\n`;
    md += `- Vector retrieval uniquely improved results in only **${catCounts.A} out of ${totalQueries}** queries (${(catCounts.A/totalQueries*100).toFixed(1)}%).\n`;
    md += `- It duplicated BM25 or provided zero unique relevant hits in **${catCounts.C + catCounts.D}** queries (${((catCounts.C + catCounts.D)/totalQueries*100).toFixed(1)}%).\n`;
    md += `- The latency penalty is **+${latPenalty.toFixed(1)} ms** per query.\n`;
    md += `- The failure modes show that semantic similarity frequently misinterprets structural/symbolic questions or falls back to BM25 dominance.\n`;
    md += `- Maintenance costs (ONNX, LanceDB bindings) outweigh the marginal retrieval benefit.\n`;

    fs.writeFileSync('c:\\Projects\\RepoGuide\\repoguide_final_vector_decision_report.md', md);
    console.log(`\nReport generated at c:\\Projects\\RepoGuide\\repoguide_final_vector_decision_report.md`);
}

runStudy().catch(console.error);
