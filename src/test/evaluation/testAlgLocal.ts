const mockVscode = {
    workspace: { getConfiguration: (section: string) => ({ get: (key: string) => {
        if (section === 'repoguide' && key === 'ollamaUrl') return 'http://localhost:11434';
        return undefined;
    } }) },
    Uri: { parse: (s: string) => ({ fsPath: s }) }
};
import * as m from 'module';
const originalRequire = m.Module.prototype.require;
m.Module.prototype.require = function(path: string) {
    if (path === 'vscode') return mockVscode;
    return originalRequire.apply(this, arguments as any);
};

import * as fs from 'fs';
import * as path from 'path';
// Repo-relative: out/test/evaluation -> repo root -> eval_repos/axios
const axiosRepo = path.resolve(__dirname, '../../../eval_repos/axios');
import { CommunityClustering } from '../../comprehension/communityClustering';

async function run() {
    const graphStr = fs.readFileSync(path.join(axiosRepo, '.repoguide', 'pagerank_graph.json'), 'utf8');
    const graph = JSON.parse(graphStr);
    
    let hashes = {
        'lib/core/Axios.js': 'hash1',
        'lib/core/dispatchRequest.js': 'hash2',
        'lib/core/InterceptorManager.js': 'hash3'
    };

    // Create fake annotations
    fs.mkdirSync(path.join(axiosRepo, '.repoguide', 'annotations'), { recursive: true });
    fs.writeFileSync(path.join(axiosRepo, '.repoguide', 'annotations', 'hash1.json'), JSON.stringify({
        key_symbols: ['Axios', 'request']
    }));
    fs.writeFileSync(path.join(axiosRepo, '.repoguide', 'annotations', 'hash2.json'), JSON.stringify({
        key_symbols: ['dispatchRequest', 'transformData']
    }));
    fs.writeFileSync(path.join(axiosRepo, '.repoguide', 'annotations', 'hash3.json'), JSON.stringify({
        key_symbols: ['InterceptorManager', 'use', 'eject']
    }));

    const mockContext = {
        logger: {
            appendLine: console.log,
            debug: console.log,
            info: console.log,
            warn: console.log,
            error: console.error
        }
    };
    const clustering = new CommunityClustering(axiosRepo, mockContext as any);
    const comms = (clustering as any).detectCommunities(graph);
    
    for (let i = 0; i < comms.length; i++) {
        if (comms[i].some((f: string) => f.includes('lib/core/Axios.js'))) {
            console.log(`\nGenerating summary for Community ${i}...`);
            const summary = await (clustering as any).generateSummaryForCommunity(comms[i], graph, hashes);
            console.log(summary);
        }
    }
}

run().catch(console.error);
