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
import { walkFiles } from '../indexing/fileWalker';
import { extractLogicalUnitsFromFile } from '../indexing/logicalUnitExtractor';
import { extractFacts } from '../indexing/factExtractor';
import { embedText } from '../ollama/embedder';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { ProgramGraphStore } from '../store/programGraphStore';

async function buildIndex(context: any) {
    const { filePaths: files } = await walkFiles(context.workspaceRoot, []);
    console.log(`Found ${files.length} files to index.`);
    let unitsExtracted = 0;
    
    for (const f of files) {
        try {
            const units = await extractLogicalUnitsFromFile(f, context.workspaceRoot);
            if (units.length > 0) {
                await context.unitStore.upsertUnits(units);
                const chunks = [];
                for (const unit of units) {
                    if (unit.type === 'function' || unit.type === 'class' || unit.type === 'method' || unit.type === 'whole_file_fallback') {
                        const vector = await embedText(context, unit.content, 'nomic-embed-text');
                        chunks.push({
                            id: unit.id,
                            filePath: unit.filePath,
                            language: 'unknown',
                            startLine: unit.startLine,
                            endLine: unit.endLine,
                            text: unit.content,
                            vector,
                            hash: unit.id
                        });
                    }
                }
                if (chunks.length > 0) {
                    await context.bm25Store.insertChunks(chunks);
                    await context.lanceStore.insertChunks(chunks);
                }
                unitsExtracted += units.length;
                
                const fileFacts = [];
                for (const unit of units) {
                    const facts = extractFacts(unit);
                    fileFacts.push(...facts);
                }
                if (fileFacts.length > 0) {
                    await context.factStore.upsertFacts(fileFacts);
                }
            }
        } catch (e: any) {
            console.error(`Failed to index ${f}: ${e.stack || e}`);
        }
    }
    return unitsExtracted;
}

async function rebuildIndex(repoPath: string, dbDir: string) {
    console.log(`Deleting existing index at ${dbDir}...`);
    if (fs.existsSync(dbDir)) {
        fs.rmSync(dbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(dbDir, { recursive: true });
    
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
    
    const unitsExtracted = await buildIndex(context);
    
    console.log(`Building program graph...`);
    const programGraphStore = new ProgramGraphStore();
    await programGraphStore.build(unitStore, factStore, repoPath);

    const luBm25Store = new LogicalUnitBm25Store(dbDir);
    await luBm25Store.init();
    await luBm25Store.indexUnits(await unitStore.getAll());
    
    const lanceDbPath = dbDir;
    let vectorDiskSize = 0;
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
            units: unitsExtracted,
            vectorCount,
            vectorDiskSizeMb: (vectorDiskSize / 1024 / 1024).toFixed(2)
        }
    };
}

async function runStudy() {
    const repos = [
        { name: 'axios', path: 'c:\\Projects\\RepoGuide\\eval_repos\\axios', cases: axiosGoldenCases },
        { name: 'craftconnect', path: 'c:\\Users\\rohan\\Downloads\\CraftConnect', cases: craftConnectGoldenCases },
        { name: 'medusa', path: 'c:\\Projects\\RepoGuide\\eval_repos\\medusa', cases: secondRepoGoldenCases }
    ];

    const allResults: any[] = [];
    
    const configs = [
        { id: 'production', name: 'Production' },
        { id: 'no_vector', name: 'No Vector' },
        { id: 'vector_only', name: 'Vector Only' },
        { id: 'bm25_only', name: 'BM25 Only' },
        { id: 'graph_only', name: 'Graph/Symbol Only' }
    ];

    for (const repo of repos) {
        console.log(`\n=============================================================`);
        console.log(`Starting Study for ${repo.name}`);
        console.log(`=============================================================`);
        const dbDir = path.join(repo.path, '.repoguide');
        
        const startTime = performance.now();
        const { bm25Store, lanceStore, stats } = await rebuildIndex(repo.path, dbDir);
        const indexTime = performance.now() - startTime;
        
        console.log(`Index Rebuild Complete in ${(indexTime / 1000).toFixed(2)}s`);
        console.log(`Units: ${stats.units}, Vectors: ${stats.vectorCount}, Vector DB Size: ${stats.vectorDiskSizeMb} MB`);

        const repoResults = {
            repo: repo.name,
            stats,
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

        for (const testCase of repo.cases) {
            const queryResults: any = {
                query: testCase.query
            };
            
            for (const c of configs) {
                process.env.ABLATION_MODE = c.id;
                
                const qStart = performance.now();
                const packet = await fusion.retrieveContext(testCase.query, []); // Pass empty seedFiles
                const qEnd = performance.now();
                const totalLatency = qEnd - qStart;
                
                const sortedItems = [...packet.chunks].sort((a,b) => b.score - a.score);
                const top10 = sortedItems.slice(0, 10).map(i => `${path.basename(i.chunk.filePath)}::${i.chunk.id.split('::')[1] || 'chunk'}`);
                
                let foundInTop1 = false;
                let foundInTop5 = false;
                let rank = -1;

                if (testCase.expectedSpans) {
                    for (let i = 0; i < sortedItems.length; i++) {
                        const chunk = sortedItems[i].chunk;
                        const isMatch = testCase.expectedSpans.some((s: any) => 
                            chunk.filePath.toLowerCase().includes(s.filePattern.toLowerCase()) && 
                            (!s.symbol || chunk.id.split('::')[1] === s.symbol)
                        );
                        if (isMatch) {
                            if (rank === -1) rank = i + 1;
                            if (i === 0) foundInTop1 = true;
                            if (i < 5) foundInTop5 = true;
                        }
                    }
                }
                
                queryResults[c.name] = {
                    latencyMs: totalLatency,
                    top1Hit: foundInTop1,
                    top5Hit: foundInTop5,
                    mrr: rank === -1 ? 0 : (1 / rank),
                    top10,
                    expectedFiles: testCase.expectedSpans ? testCase.expectedSpans.map((s:any) => s.filePattern) : []
                };
            }
            repoResults.queries.push(queryResults);
        }
        allResults.push(repoResults);
    }
    
    fs.writeFileSync('c:\\Projects\\RepoGuide\\corrected_vector_roi_study_results.json', JSON.stringify(allResults, null, 2));
    console.log(`\nStudy complete. Results saved to corrected_vector_roi_study_results.json`);
}

runStudy().catch(console.error);
