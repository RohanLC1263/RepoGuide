import * as fs from 'fs';
import * as path from 'path';
import { QueryDispatcher } from '../query/queryDispatcher';
import { IndexManager } from '../indexing/indexManager';
import { StoragePipeline } from '../store/storagePipeline';


interface BenchmarkItem {
    question_id: string;
    category: string;
    repository_sha: string;
    query: string;
    ground_truth: {
        expected_entities: { signature: string; must_have: boolean }[];
        expected_edges: { source_signature: string; target_signature: string; edge_type: string }[];
    };
}

interface MetricResult {
    precision: number;
    recall: number;
    f1: number;
    topKAccuracy: number;
    graphEdgeDelta: number;
}

export class GoldDatasetRunner {
    private datasetPath: string;
    private dispatcher: any;

    constructor(datasetPath: string, dispatcher: any) {
        this.datasetPath = datasetPath;
        this.dispatcher = dispatcher;
    }

    async run(): Promise<void> {
        console.log(`Loading dataset from ${this.datasetPath}`);
        const data = fs.readFileSync(this.datasetPath, 'utf8');
        const items: BenchmarkItem[] = JSON.parse(data);

        console.log(`Starting execution of ${items.length} benchmark items...`);
        
        const categoryMetrics: Record<string, MetricResult[]> = {};
        const overallMetrics: MetricResult[] = [];

        for (const item of items) {
            console.log(`[${item.question_id}] Executing: ${item.query}`);
            
            // Execute the query against RepoGuide
            // Mocking dispatch execution for baseline report generation structure
            const response = await this.dispatcher.dispatch(item.query, {
                mode: 'comprehensive',
                maxDepth: 3
            });

            const retrievedSignatures = new Set(response.entities.map((e: any) => e.signature));
            const expectedSignatures = new Set(item.ground_truth.expected_entities.map(e => e.signature));

            // Precision & Recall
            let truePositives = 0;
            for (const expected of expectedSignatures) {
                if (retrievedSignatures.has(expected)) {
                    truePositives++;
                }
            }

            const precision = retrievedSignatures.size === 0 ? 0 : truePositives / retrievedSignatures.size;
            const recall = expectedSignatures.size === 0 ? 1 : truePositives / expectedSignatures.size;
            const f1 = (precision + recall) === 0 ? 0 : 2 * (precision * recall) / (precision + recall);
            
            const retrievedEdgesCount = response.edges?.length || 0;
            const expectedEdgesCount = item.ground_truth.expected_edges.length;
            const edgeDelta = Math.abs(retrievedEdgesCount - expectedEdgesCount);

            const result: MetricResult = {
                precision,
                recall,
                f1,
                topKAccuracy: truePositives > 0 ? 1 : 0, // Simplified Top-K for this example
                graphEdgeDelta: edgeDelta
            };

            if (!categoryMetrics[item.category]) {
                categoryMetrics[item.category] = [];
            }
            categoryMetrics[item.category].push(result);
            overallMetrics.push(result);
        }

        this.reportMetrics(categoryMetrics, overallMetrics);
    }

    private reportMetrics(categoryMetrics: Record<string, MetricResult[]>, overall: MetricResult[]) {
        const computeAverage = (arr: MetricResult[], key: keyof MetricResult) => {
            if (arr.length === 0) return 0;
            const sum = arr.reduce((acc, curr) => acc + curr[key], 0);
            return sum / arr.length;
        };

        console.log('\n--- OVERALL METRICS ---');
        console.log(`Precision: ${(computeAverage(overall, 'precision') * 100).toFixed(2)}%`);
        console.log(`Recall: ${(computeAverage(overall, 'recall') * 100).toFixed(2)}%`);
        console.log(`F1 Score: ${(computeAverage(overall, 'f1') * 100).toFixed(2)}%`);
        console.log(`Graph Edge Delta (avg): ${computeAverage(overall, 'graphEdgeDelta').toFixed(2)}`);

        console.log('\n--- CATEGORY METRICS ---');
        for (const [category, metrics] of Object.entries(categoryMetrics)) {
            console.log(`${category}:`);
            console.log(`  Precision: ${(computeAverage(metrics, 'precision') * 100).toFixed(2)}%`);
            console.log(`  Recall: ${(computeAverage(metrics, 'recall') * 100).toFixed(2)}%`);
            console.log(`  F1 Score: ${(computeAverage(metrics, 'f1') * 100).toFixed(2)}%`);
        }
    }
}

// CLI Execution Bootstrap
if (require.main === module) {
    console.log("Runner compiled and ready. Bootstrapping evaluation...");
}
