import { ProgramGraphStore } from '../store/programGraphStore';
import { FactStore } from '../store/factStore';
import { SemanticImpactEngine } from '../query/semanticImpactEngine';
import { UsageHeuristicEvaluator } from '../query/usageHeuristicEvaluator';
import { TransitiveGraphWalker } from '../query/transitiveGraphWalker';
import { FactRecord } from '../indexing/factTypes';

// Mock scenario for evaluation
interface Scenario {
    id: string;
    targetSymbol: string;
    actualModifiedFiles: string[];
    description: string;
}

const scenarios: Scenario[] = [
    {
        id: 'HC-001',
        targetSymbol: 'UserService',
        actualModifiedFiles: ['src/controllers/userController.ts'],
        description: 'Interface change requiring downstream update'
    },
    {
        id: 'HC-002',
        targetSymbol: 'AuthUtil',
        actualModifiedFiles: [],
        description: 'Internal refactor, safe downstream'
    },
    {
        id: 'HC-003',
        targetSymbol: 'DatabaseConfig',
        actualModifiedFiles: ['src/app.ts', 'src/db.ts'],
        description: 'Signature modification breaking instantiations'
    },
    {
        id: 'HC-004',
        targetSymbol: 'Helper',
        actualModifiedFiles: [],
        description: 'Rename unused import'
    },
    {
        id: 'HC-005',
        targetSymbol: 'Logger',
        actualModifiedFiles: ['src/services/paymentService.ts'],
        description: 'Delete method'
    }
];

function setupMockGraphAndFacts(graphStore: ProgramGraphStore, factStore: FactStore) {
    const graph = {
        nodes: {} as Record<string, any>,
        edges: [] as any[],
        nodeCount: 0,
        edgeCount: 0
    };
    (graphStore as any).graph = graph;

    const addNode = (n: any) => {
        graph.nodes[n.id] = n;
        graph.nodeCount++;
    };
    const addEdge = (e: any) => {
        graph.edges.push(e);
        graph.edgeCount++;
    };

    // Scenario 1: UserService (interface change)
    addNode({ id: 'UserService', symbol: 'UserService', type: 'class', filePath: 'src/services/userService.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'userController', symbol: 'userController', type: 'file', filePath: 'src/controllers/userController.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'userRoute', symbol: 'userRoute', type: 'file', filePath: 'src/routes/userRoute.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    
    // userController uses UserService method (actionable)
    addEdge({ from: 'userController', to: 'UserService', type: 'calls_method' });
    // userRoute just imports it (safe)
    addEdge({ from: 'userRoute', to: 'UserService', type: 'imports' });

    // Scenario 2: AuthUtil
    addNode({ id: 'AuthUtil', symbol: 'AuthUtil', type: 'class', filePath: 'src/utils/auth.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'authMiddleware', symbol: 'authMiddleware', type: 'file', filePath: 'src/middleware/auth.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    // Middleware imports AuthUtil but doesn't call (internal refactor)
    addEdge({ from: 'authMiddleware', to: 'AuthUtil', type: 'imports' });

    // Scenario 3: DatabaseConfig
    addNode({ id: 'DatabaseConfig', symbol: 'DatabaseConfig', type: 'class', filePath: 'src/config/db.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'app', symbol: 'app', type: 'file', filePath: 'src/app.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'db', symbol: 'db', type: 'file', filePath: 'src/db.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'server', symbol: 'server', type: 'file', filePath: 'src/server.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    
    addEdge({ from: 'app', to: 'DatabaseConfig', type: 'instantiates' });
    addEdge({ from: 'db', to: 'DatabaseConfig', type: 'implements_interface' });
    addEdge({ from: 'server', to: 'DatabaseConfig', type: 'imports' }); // safe

    // Scenario 4: Helper
    addNode({ id: 'Helper', symbol: 'Helper', type: 'function', filePath: 'src/utils/helper.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'worker', symbol: 'worker', type: 'file', filePath: 'src/worker.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addEdge({ from: 'worker', to: 'Helper', type: 'imports' });

    // Scenario 5: Logger
    addNode({ id: 'Logger', symbol: 'Logger', type: 'class', filePath: 'src/utils/logger.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'paymentService', symbol: 'paymentService', type: 'file', filePath: 'src/services/paymentService.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addNode({ id: 'emailService', symbol: 'emailService', type: 'file', filePath: 'src/services/emailService.ts', role: 'implementation', startLine: 1, endLine: 10, content: '', language: 'ts' });
    addEdge({ from: 'paymentService', to: 'Logger', type: 'calls' });
    addEdge({ from: 'emailService', to: 'Logger', type: 'imports' });

    (graphStore as any).buildIndexes();
}

export async function runBenchmark() {
    console.log('--- Starting Semantic Impact Engine V1 Benchmark ---');
    
    const factStore = new FactStore();
    const graphStore = new ProgramGraphStore();
    
    setupMockGraphAndFacts(graphStore, factStore);

    const evaluator = new UsageHeuristicEvaluator(factStore);
    const engine = new SemanticImpactEngine(graphStore, evaluator);
    const bfsWalker = new TransitiveGraphWalker(graphStore);

    let totalActionablePredicted = 0;
    let totalActionableCorrect = 0;
    let totalSafeCorrect = 0;
    let totalSafePredicted = 0;
    let totalCriticalMisses = 0;
    let totalActualModified = 0;

    let bfsTotalActionablePredicted = 0;
    let bfsTotalActionableCorrect = 0;

    for (const scenario of scenarios) {
        console.log(`\nEvaluating Scenario: ${scenario.id} (${scenario.description})`);
        
        // 1. Run Baseline (IDE Find References / BFS)
        const bfsResult = bfsWalker.getBlastRadius(scenario.targetSymbol);
        const bfsPredictedFiles = bfsResult.reachableNodes.map(n => n.node.filePath).filter(Boolean);
        bfsTotalActionablePredicted += bfsPredictedFiles.length;
        
        // 2. Run Semantic Impact Engine
        const engineResult = await engine.assessImpact(scenario.targetSymbol, 'UNKNOWN');
        
        const predictedActionable = engineResult.actionableFiles;
        const predictedSafe = engineResult.safeFiles;
        
        console.log(`  Engine Actionable: ${predictedActionable.length} files`);
        console.log(`  Engine Safe: ${predictedSafe.length} files`);
        console.log(`  BFS (IDE) Blast Radius: ${bfsPredictedFiles.length} files`);

        totalActionablePredicted += predictedActionable.length;
        totalSafePredicted += predictedSafe.length;
        totalActualModified += scenario.actualModifiedFiles.length;

        let misses = 0;
        let correctActionable = 0;

        for (const file of scenario.actualModifiedFiles) {
            if (predictedActionable.includes(file)) correctActionable++;
            else misses++;
            
            if (bfsPredictedFiles.includes(file)) bfsTotalActionableCorrect++;
        }

        totalActionableCorrect += correctActionable;
        totalCriticalMisses += misses;
    }

    const actionabilityScore = (totalActionablePredicted > 0 ? totalActionableCorrect / totalActionablePredicted : 1) * 100;
    const bfsActionabilityScore = (bfsTotalActionablePredicted > 0 ? bfsTotalActionableCorrect / bfsTotalActionablePredicted : 1) * 100;
    const criticalMissRate = (totalActualModified > 0 ? totalCriticalMisses / totalActualModified : 0) * 100;

    console.log('\n--- Benchmark Results ---');
    console.log(`IDE Find References Actionability Score: ${bfsActionabilityScore.toFixed(2)}%`);
    console.log(`Semantic Impact Engine Actionability Score: ${actionabilityScore.toFixed(2)}% (Target: >85%)`);
    console.log(`Critical Miss Rate: ${criticalMissRate.toFixed(2)}% (Target: <5%)`);
    
    if (actionabilityScore >= 85 && criticalMissRate <= 5) {
        console.log('\nSUCCESS: Semantic Impact Engine V1 exceeds benchmark targets.');
    } else {
        console.log('\nFAILURE: Benchmark targets not met.');
        process.exit(1);
    }
}

if (require.main === module) {
    runBenchmark().catch(console.error);
}
