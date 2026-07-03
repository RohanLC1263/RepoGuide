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
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { buildEvidencePlan } from '../query/evidencePlanner';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';
import { walkFiles } from '../indexing/fileWalker';
import { extractLogicalUnitsFromFile } from '../indexing/logicalUnitExtractor';
import { extractFacts } from '../indexing/factExtractor';
import { ProgramGraphStore } from '../store/programGraphStore';
import { scoreEvidencePacket, scoreAnswerGate } from './evidenceScorers';
import { embedText } from '../ollama/embedder';
import { EvidenceAnswerSynthesizer } from '../query/evidenceAnswerSynthesizer';
import { AnswerGate } from '../query/answerGate';

async function rebuildIndex(repoPath: string, dbDir: string) {
    const unitStore = new LogicalUnitStore(dbDir);
    const factStore = new FactStore(dbDir);
    const bm25Store = new Bm25Store(dbDir);
    const lanceStore = new LanceStore(dbDir);
    const programGraphStore = new ProgramGraphStore();

    await unitStore.init(repoPath);
    await factStore.init(repoPath);
    await bm25Store.init();
    await lanceStore.init();

    const dummyContext: any = {
        getConfig: (key: string, defaultValue?: any) => defaultValue
    };

    const { filePaths } = await walkFiles(repoPath);
    console.log(`Found ${filePaths.length} files to index.`);
    let unitsExtracted = 0;

    for (const fp of filePaths) {
        try {
            const units = await extractLogicalUnitsFromFile(fp, repoPath);
            if (units.length > 0) {
                await unitStore.upsertUnits(units);
                const chunks = [];
                for (const u of units) {
                    const vector = await embedText(dummyContext, u.content, 'nomic-embed-text');
                    chunks.push({
                        id: u.id,
                        filePath: u.filePath,
                        text: u.content,
                        language: 'unknown',
                        startLine: u.startLine,
                        endLine: u.endLine,
                        vector: Array.from(vector),
                        hash: u.id
                    });
                }
                if (chunks.length > 0) {
                    await bm25Store.insertChunks(chunks);
                    await lanceStore.insertChunks(chunks);
                }
                unitsExtracted += units.length;
                
                const fileFacts = [];
                for (const unit of units) {
                    const facts = extractFacts(unit);
                    fileFacts.push(...facts);
                }
                if (fileFacts.length > 0) {
                    await factStore.upsertFacts(fileFacts);
                }
            }
        } catch (e) {
            console.error(`Failed to index ${fp}:`, e);
        }
    }
    
    console.log(`Building program graph...`);
    await programGraphStore.build(unitStore, factStore, repoPath);

    const luBm25Store = new LogicalUnitBm25Store(dbDir);
    await luBm25Store.init();
    await luBm25Store.clearAll();
    const allUnits = await unitStore.getAll();
    await luBm25Store.indexUnits(allUnits);
    
    // Calculate vector disk size
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
        unitStore, factStore, luBm25Store, lanceStore, programGraphStore, 
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
    
    for (const repo of repos) {
        console.log(`\n=============================================================`);
        console.log(`Starting Study for ${repo.name}`);
        console.log(`=============================================================`);
        const dbDir = path.join(repo.path, '.repoguide');
        
        const startTime = performance.now();
        const { unitStore, factStore, luBm25Store, lanceStore, programGraphStore, stats } = await rebuildIndex(repo.path, dbDir);
        const indexTime = performance.now() - startTime;
        
        console.log(`Index Rebuild Complete in ${(indexTime / 1000).toFixed(2)}s`);
        console.log(`Units: ${stats.units}, Vectors: ${stats.vectorCount}, Vector DB Size: ${stats.vectorDiskSizeMb} MB`);

        const builderProduction = new EvidencePacketBuilder({
            unitStore, factStore, bm25Store: luBm25Store, programGraphStore
        });

        // Note: EvidencePacketBuilder never actually read lanceStore (dead wiring, removed
        // during the Phase 1 consolidation) so this "no vector" variant was already
        // equivalent to the production builder before this change too.
        const builderNoVector = new EvidencePacketBuilder({
            unitStore, factStore, bm25Store: luBm25Store, programGraphStore
        });

        const mockLogger = {
            appendLine: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
            stageStart: () => {}, stageProgress: () => {}, stageComplete: () => {}, stageFailed: () => {},
            artifactWritten: () => {}, queryLog: () => {}, repairLog: () => {}
        };
        const mockContext = {
            workspaceRoot: repo.path, repoguideDataDir: dbDir,
            getConfig: <T>(key: string, defaultValue?: T) => defaultValue as T,
            asRelativePath: (p: string) => path.relative(repo.path, p),
            logger: mockLogger, notifyInfo: async () => {}, notifyWarning: async () => {}, notifyError: async () => {}
        };
        const synthesizer = new EvidenceAnswerSynthesizer(mockContext);
        const answerGate = new AnswerGate();

        const repoResults = {
            repo: repo.name,
            stats,
            queries: [] as any[]
        };

        for (const testCase of repo.cases) {
            console.log(`\nTesting Query: ${testCase.query}`);
            const queryResults: any = { query: testCase.query };
            
            for (const config of ['Production', 'NoVector']) {
                const builder = config === 'Production' ? builderProduction : builderNoVector;
                
                // Track memory
                const memBefore = process.memoryUsage().heapUsed;
                
                const qStart = performance.now();
                const plan = buildEvidencePlan(testCase.query);
                const rStart = performance.now();
                const packet = await builder.buildPacket(testCase.query, plan);
                const retrievalLatency = performance.now() - rStart;
                
                let evalResult = scoreEvidencePacket(testCase, packet);
                
                const answer = await synthesizer.synthesize(packet, 'qwen2.5-coder:7b');
                const gateResult = answerGate.verify(answer, packet);
                evalResult = scoreAnswerGate(gateResult, evalResult, testCase);
                
                const qEnd = performance.now();
                const queryLatency = qEnd - qStart;
                
                const memAfter = process.memoryUsage().heapUsed;
                const memUsed = Math.max(0, memAfter - memBefore);
                
                const sortedItems = [...packet.items].sort((a,b) => b.score - a.score);
                const top10 = sortedItems.slice(0, 10).map(i => `${path.basename(i.file)}::${i.symbol||i.type}`);
                
                queryResults[config] = {
                    top10
                };
            }
            repoResults.queries.push(queryResults);
        }
        allResults.push(repoResults);
    }
    
    fs.writeFileSync('c:\\Projects\\RepoGuide\\vector_roi_top10_results.json', JSON.stringify(allResults, null, 2));
    console.log(`\nStudy complete. Results saved to vector_roi_top10_results.json`);
}

runStudy().catch(console.error);
