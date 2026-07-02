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
import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';

async function loadIndex(repoPath: string) {
    const dbDir = path.join(repoPath, '.repoguide');
    const bm25Store = new Bm25Store(dbDir);
    const lanceStore = new LanceStore(dbDir);
    await bm25Store.init();
    await lanceStore.init();
    
    return { bm25Store, lanceStore, dbDir };
}

async function runStudy() {
    const repos = [
        { name: 'axios', path: 'c:\\Projects\\RepoGuide\\eval_repos\\axios', cases: axiosGoldenCases },
        { name: 'craftconnect', path: 'c:\\Users\\rohan\\Downloads\\CraftConnect', cases: craftConnectGoldenCases },
        { name: 'medusa', path: 'c:\\Projects\\RepoGuide\\eval_repos\\medusa', cases: secondRepoGoldenCases }
    ];

    const allResults: any[] = [];
    
    for (const repo of repos) {
        console.log(`\n=============================================================`);
        console.log(`Phase 54 Fusion Study for ${repo.name}`);
        console.log(`=============================================================`);
        
        const { bm25Store, lanceStore, dbDir } = await loadIndex(repo.path);
        
        const repoResults = {
            repo: repo.name,
            queries: [] as any[]
        };

        const mockContext: any = {
            workspaceRoot: repo.path, repoguideDataDir: dbDir,
            getConfig: (key: string, defaultValue?: any) => defaultValue,
            logger: { info: () => {}, error: console.error, warn: console.warn, debug: () => {} }
        };
        const intentClassifier: any = { classify: async () => ({
            primaryIntent: 'general_explanation',
            concepts: [],
            roles: ['implementation'],
            needsHistory: false,
            needsDocumentation: false
        }) };

        const fusion = new HybridRetrievalFusion(lanceStore, bm25Store, dbDir, repo.path, intentClassifier, mockContext);

        for (const testCase of repo.cases.slice(0, 30)) {
            const queryResults: any = {
                query: testCase.query,
                expectedFiles: testCase.expectedSpans ? testCase.expectedSpans.map((s:any) => s.filePattern) : []
            };
            
            // Set up capture
            let capture: any = null;
            (global as any).__phase54Capture = (q: string, data: any) => {
                capture = data;
            };

            process.env.ABLATION_MODE = 'production';
            await fusion.retrieveContext(testCase.query, []);

            if (capture) {
                // We have the raw chunks
                const mapChunk = (c: any) => `${path.basename(c.filePath)}::${c.startLine}`;
                
                queryResults.rawVector20 = capture.vectorResults.slice(0, 20).map(mapChunk);
                queryResults.rawBm25_20 = capture.bm25Results.slice(0, 20).map(mapChunk);
                queryResults.rawGraph20 = capture.prResults.slice(0, 20).map((p: string) => path.basename(p));
                
                const calculateOverlap = (a: string[], b: string[], topK: number) => {
                    const setA = new Set(a.slice(0, topK));
                    const setB = new Set(b.slice(0, topK));
                    if (setA.size === 0 && setB.size === 0) return 100;
                    if (setA.size === 0 || setB.size === 0) return 0;
                    let inter = 0;
                    for (const item of setA) if (setB.has(item)) inter++;
                    return (inter / Math.max(setA.size, setB.size)) * 100;
                };

                queryResults.overlap = {
                    vectorVsBm25: {
                        top5: calculateOverlap(queryResults.rawVector20, queryResults.rawBm25_20, 5),
                        top10: calculateOverlap(queryResults.rawVector20, queryResults.rawBm25_20, 10),
                        top20: calculateOverlap(queryResults.rawVector20, queryResults.rawBm25_20, 20)
                    },
                    vectorVsGraph: {
                        top5: calculateOverlap(capture.vectorResults.map((c:any) => path.basename(c.filePath)), queryResults.rawGraph20, 5),
                        top10: calculateOverlap(capture.vectorResults.map((c:any) => path.basename(c.filePath)), queryResults.rawGraph20, 10),
                        top20: calculateOverlap(capture.vectorResults.map((c:any) => path.basename(c.filePath)), queryResults.rawGraph20, 20)
                    },
                    bm25VsGraph: {
                        top5: calculateOverlap(capture.bm25Results.map((c:any) => path.basename(c.filePath)), queryResults.rawGraph20, 5),
                        top10: calculateOverlap(capture.bm25Results.map((c:any) => path.basename(c.filePath)), queryResults.rawGraph20, 10),
                        top20: calculateOverlap(capture.bm25Results.map((c:any) => path.basename(c.filePath)), queryResults.rawGraph20, 20)
                    }
                };

                // Score recording
                queryResults.fusionScores = [];
                capture.fusedChunks.slice(0, 10).forEach((fc: any, i: number) => {
                    queryResults.fusionScores.push({
                        rank: i + 1,
                        id: mapChunk(fc.chunk),
                        finalScore: fc.score.toFixed(4),
                        rawVectorScore: (capture.vectorResults.find((v:any) => v.id === fc.chunk.id)?.__preFusionScore || 0).toFixed(4),
                        rawBm25Score: (capture.bm25Results.find((b:any) => b.id === fc.chunk.id)?.__preFusionScore || 0).toFixed(4),
                        vectorPos: capture.vectorResults.findIndex((v:any) => v.id === fc.chunk.id) + 1,
                        bm25Pos: capture.bm25Results.findIndex((b:any) => b.id === fc.chunk.id) + 1,
                        prPos: capture.prResults.findIndex((p:string) => p === fc.chunk.filePath) + 1
                    });
                });
                
                let isUniqueUsefulVector = false;
                let vectorUsefulChunkStr = '';
                for (const exp of testCase.expectedSpans || []) {
                    const vecHas = queryResults.rawVector20.some((s: string) => s.toLowerCase().includes(exp.filePattern.toLowerCase()));
                    const bm25Has = queryResults.rawBm25_20.some((s: string) => s.toLowerCase().includes(exp.filePattern.toLowerCase()));
                    if (vecHas && !bm25Has) {
                        isUniqueUsefulVector = true;
                        vectorUsefulChunkStr = exp.filePattern;
                    }
                }

                if (!isUniqueUsefulVector && queryResults.overlap.vectorVsBm25.top20 > 60) {
                    queryResults.category = 'Category 2: Vector retrieves the same chunks as BM25';
                } else if (!isUniqueUsefulVector) {
                    queryResults.category = 'Category 1: Vector retrieves nothing useful';
                } else {
                    const fusedHas = capture.fusedChunks.slice(0, 10).some((c:any) => c.chunk.filePath.toLowerCase().includes(vectorUsefulChunkStr.toLowerCase()));
                    if (fusedHas) {
                        queryResults.category = 'Category 4: Vector materially improves final ranking';
                    } else {
                        queryResults.category = 'Category 3: Vector retrieves unique useful chunks but fusion suppresses them';
                    }
                }
            }
            
            repoResults.queries.push(queryResults);
        }
        allResults.push(repoResults);
    }
    
    fs.writeFileSync('c:\\Projects\\RepoGuide\\phase54_fusion_results.json', JSON.stringify(allResults, null, 2));
    console.log(`\nStudy complete. Results saved to phase54_fusion_results.json`);
}

runStudy().catch(console.error);
