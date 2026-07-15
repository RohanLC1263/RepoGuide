const fs = require('node:fs');
const path = require('node:path');

const { LogicalUnitStore } = require('../out/store/logicalUnitStore.js');
const { FactStore } = require('../out/store/factStore.js');
const { LogicalUnitBm25Store } = require('../out/store/logicalUnitBm25Store.js');
const { ProgramGraphStore } = require('../out/store/programGraphStore.js');
const { EvidencePacketBuilder } = require('../out/query/evidencePacketBuilder.js');
const { buildEvidencePlan } = require('../out/query/evidencePlanner.js');

// CraftConnect is a local checkout not part of this repo; require its path via
// env var rather than hardcoding a personal-machine path. (The other entries
// below still use local paths -- they are out of scope for this scrub.)
const craftConnectPath = process.env.CRAFTCONNECT_PATH;
if (!craftConnectPath) {
  throw new Error('CRAFTCONNECT_PATH is not set. Set it to your local CraftConnect checkout (e.g. CRAFTCONNECT_PATH=/path/to/CraftConnect) or remove the CraftConnect row from the repos list.');
}

const repos = [
  ['CraftConnect', craftConnectPath, 'C:/Projects/RepoGuide/scratch/cert_indexes/CraftConnect'],
  ['RepoGuide', 'C:/Projects/RepoGuide', 'C:/Projects/RepoGuide/.repoguide'],
  ['FastAPI', 'C:/Projects/fastapi', 'C:/Projects/RepoGuide/scratch/cert_indexes/FastAPI'],
  ['Axios', 'C:/Projects/RepoGuide/eval_repos/axios', 'C:/Projects/RepoGuide/eval_repos/axios/.repoguide']
];

const norm = value => String(value || '').replace(/\\/g, '/').toLowerCase();

function unique(items, predicate) {
  const seen = new Set();
  return items.filter(item => {
    if (!predicate(item)) return false;
    const key = `${item.symbol}:${norm(item.filePath)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function aggregate(results) {
  const n = results.length || 1;
  const at = k => results.filter(result => result.rank && result.rank <= k).length / n;
  return { n: results.length, top1: at(1), top3: at(3), top5: at(5), recall: results.filter(r => r.rank).length / n };
}

async function runRepo(name, root, dbDir) {
  const unitStore = new LogicalUnitStore(dbDir);
  const factStore = new FactStore(dbDir);
  const bm25Store = new LogicalUnitBm25Store(dbDir);
  const graphStore = new ProgramGraphStore();
  await Promise.all([unitStore.init(root), factStore.init(root), bm25Store.init(), graphStore.load(root)]);
  const builder = new EvidencePacketBuilder({ unitStore, factStore, bm25Store, lanceStore: {}, programGraphStore: graphStore });
  const units = await unitStore.getAll();
  const candidates = unique(units, unit => unit.symbol && unit.role === 'implementation');
  const classes = candidates.filter(unit => unit.type === 'class').slice(0, 4);
  const funcs = candidates.filter(unit => unit.type === 'function' || unit.type === 'method').slice(0, 8);
  const files = unique(candidates, unit => norm(unit.filePath).includes('/src/') || !norm(unit.filePath).includes('/test')).slice(0, 4);
  const relationships = funcs.slice(4, 8);
  const questions = [
    ...classes.map(unit => ['exact_symbol', `Where is ${unit.symbol} defined?`, unit]),
    ...funcs.slice(0, 4).map(unit => ['implementation', `How does ${unit.symbol} work?`, unit]),
    ...relationships.map(unit => ['relationship', `What calls or uses ${unit.symbol}?`, unit]),
    ...files.map(unit => ['architecture', `What role does ${path.basename(unit.filePath)} play in the architecture?`, unit]),
    ...funcs.slice(0, 4).map(unit => ['usage', `Where is ${unit.symbol} used?`, unit])
  ].slice(0, 20);
  const results = [];
  for (const [category, question, expected] of questions) {
    const started = Date.now();
    const packet = await builder.buildPacket(question, buildEvidencePlan(question));
    const ranked = [...packet.facts, ...packet.items].map(item => norm(item.file));
    const expectedFile = norm(expected.filePath);
    const index = ranked.findIndex(file => file === expectedFile || file.endsWith(`/${expectedFile}`) || expectedFile.endsWith(`/${file}`));
    results.push({
      category,
      question,
      expectedFile: expected.filePath,
      expectedSymbol: expected.symbol,
      rank: index < 0 ? null : index + 1,
      retrievedCount: ranked.length,
      coverageScore: packet.coverageScore,
      gaps: packet.gaps,
      latencyMs: Date.now() - started,
      top5: ranked.slice(0, 5)
    });
  }
  return { name, root, corpusUnits: units.length, summary: aggregate(results), results };
}

(async () => {
  const output = [];
  for (const [name, root, dbDir] of repos) {
    output.push(await runRepo(name, root, dbDir));
    console.log(name, output.at(-1).summary);
  }
  fs.writeFileSync('repoguide_certification_generalization_raw.json', JSON.stringify(output, null, 2));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
