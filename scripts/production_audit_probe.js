const fs = require('node:fs');
const path = require('node:path');

const { LogicalUnitStore } = require('../out/store/logicalUnitStore.js');
const { FactStore } = require('../out/store/factStore.js');
const { LogicalUnitBm25Store } = require('../out/store/logicalUnitBm25Store.js');
const { ProgramGraphStore } = require('../out/store/programGraphStore.js');
const { EvidencePacketBuilder } = require('../out/query/evidencePacketBuilder.js');
const { buildEvidencePlan } = require('../out/query/evidencePlanner.js');
const { AnswerGate } = require('../out/query/answerGate.js');

const root = path.resolve(__dirname, '..');
const repoguideDir = path.join(root, '.repoguide');

function norm(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function pick(items, count, predicate = () => true) {
  const picked = [];
  const seen = new Set();
  for (const item of items) {
    if (picked.length >= count) break;
    if (!predicate(item)) continue;
    const key = `${item.symbol || item.filePath || item.factId || item.id}:${item.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
  }
  return picked;
}

function aggregate(results) {
  const denom = results.length || 1;
  return {
    n: results.length,
    top1: results.filter(r => r.top1).length / denom,
    top3: results.filter(r => r.top3).length / denom,
    top5: results.filter(r => r.top5).length / denom,
    recall: results.filter(r => r.recall).length / denom
  };
}

function scoreResult(question, packet, expectedFile) {
  const ranked = [...packet.facts, ...packet.items].map(item => ({
    file: norm(item.file),
    symbol: item.symbol || '',
    type: item.type,
    signal: item.retrieval_signal,
    score: item.score,
    startLine: item.startLine,
    stale: Boolean(item.stale)
  }));
  const rank = ranked.findIndex(item =>
    item.file === expectedFile ||
    item.file.endsWith('/' + expectedFile) ||
    expectedFile.endsWith('/' + item.file)
  );
  return {
    ...question,
    top1: rank === 0,
    top3: rank >= 0 && rank < 3,
    top5: rank >= 0 && rank < 5,
    recall: rank >= 0,
    rank: rank >= 0 ? rank + 1 : null,
    retrievedCount: ranked.length,
    gaps: packet.gaps,
    coverageScore: packet.coverageScore,
    top: ranked.slice(0, 5)
  };
}

async function main() {
  const unitStore = new LogicalUnitStore(repoguideDir);
  const factStore = new FactStore(repoguideDir);
  const bm25Store = new LogicalUnitBm25Store(repoguideDir);
  const programGraphStore = new ProgramGraphStore();

  await unitStore.init(root);
  await factStore.init(root);
  await bm25Store.init();
  await programGraphStore.load(root);

  const builder = new EvidencePacketBuilder({
    unitStore,
    factStore,
    bm25Store,
    lanceStore: {},
    programGraphStore
  });

  const units = await unitStore.getAll();
  const facts = await factStore.queryFacts({ limit: Number.POSITIVE_INFINITY });
  const implUnits = units.filter(unit => unit.role === 'implementation' && unit.symbol);
  const classUnits = pick(implUnits, 10, unit => unit.type === 'class');
  const methodUnits = pick(implUnits, 10, unit => unit.type === 'method' || unit.type === 'function');
  const constFacts = pick(facts, 10, fact =>
    ['constant', 'numeric_threshold', 'config_value', 'environment_variable'].includes(fact.factType) && fact.symbol
  );
  const callFacts = pick(facts, 10, fact =>
    ['call_site', 'instantiation', 'dependency_injection', 'fallback_chain', 'assignment'].includes(fact.factType) && fact.symbol
  );
  const files = pick(units, 10, unit => norm(unit.filePath).includes('/src/') && unit.filePath.endsWith('.ts'));

  const questions = [];
  for (const unit of classUnits) {
    questions.push({
      category: 'class',
      question: `Where is ${unit.symbol} defined?`,
      expectedFile: norm(unit.filePath),
      expectedSymbol: unit.symbol
    });
  }
  for (const unit of methodUnits) {
    questions.push({
      category: 'method_function',
      question: `How does ${unit.symbol} work?`,
      expectedFile: norm(unit.filePath),
      expectedSymbol: unit.symbol
    });
  }
  for (const fact of constFacts) {
    questions.push({
      category: 'constant_config',
      question: `Where is ${fact.symbol} configured or defined?`,
      expectedFile: norm(fact.filePath),
      expectedSymbol: fact.symbol
    });
  }
  for (const fact of callFacts) {
    questions.push({
      category: 'relationship_flow',
      question: `What uses or calls ${fact.symbol}?`,
      expectedFile: norm(fact.filePath),
      expectedSymbol: fact.symbol
    });
  }
  for (const unit of files) {
    questions.push({
      category: 'file_architecture',
      question: `What is the role of ${path.basename(unit.filePath)} in the architecture?`,
      expectedFile: norm(unit.filePath),
      expectedSymbol: unit.symbol
    });
  }

  const results = [];
  for (const question of questions.slice(0, 50)) {
    const plan = buildEvidencePlan(question.question);
    const packet = await builder.buildPacket(question.question, plan);
    results.push({
      ...scoreResult(question, packet, question.expectedFile),
      queryType: plan.queryType
    });
  }

  const adversarialQuestions = [
    'Where is DEFAULT_THRESHOLD_2 defined?',
    'How does HybridRetrievalFusionV2 work?',
    'What is MAX_AGENT_DEPTH?',
    'How does AdvancedDependencyGraph operate?',
    'Where is fake_file_zz99.ts used?',
    'Explain NonexistentRepoGuideClass constructor parameters.',
    'What calls definitely_not_a_real_method?',
    'Where is REPOGUIDE_SECRET_TOKEN configured?',
    'How does EvidencePacketBuilderPro synthesize citations?',
    'What is the value of MIN_CONFIDENCE_OVERRIDE_999?'
  ];
  const answerGate = new AnswerGate();
  const adversarial = [];
  for (const question of adversarialQuestions) {
    const plan = buildEvidencePlan(question);
    const packet = await builder.buildPacket(question, plan);
    const ranked = [...packet.facts, ...packet.items].map(item => ({
      file: norm(item.file),
      symbol: item.symbol || '',
      type: item.type,
      signal: item.retrieval_signal,
      score: item.score,
      startLine: item.startLine,
      content: String(item.content || '').slice(0, 120)
    }));
    const syntheticLie = `DEFAULT_THRESHOLD_2 is defined in fake_file_zz99.ts at line 123 with value "made-up-value".`;
    const gateResult = answerGate.verify(syntheticLie, packet);
    adversarial.push({
      question,
      queryType: plan.queryType,
      symbolHints: plan.symbolHints,
      retrievedCount: ranked.length,
      gaps: packet.gaps,
      coverageScore: packet.coverageScore,
      syntheticLieGateOutcome: gateResult.outcome,
      syntheticLieGateDiagnostics: gateResult.diagnostics,
      top: ranked.slice(0, 5)
    });
  }

  const byCategory = {};
  for (const category of [...new Set(results.map(result => result.category))]) {
    byCategory[category] = aggregate(results.filter(result => result.category === category));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      overall: aggregate(results),
      byCategory,
      corpus: {
        units: units.length,
        facts: facts.length,
        bm25Docs: bm25Store.getIndexedCount(),
        graph: programGraphStore.getStats(),
        lanceChunks: 'not initialized: evidence packet builder omits vector retrieval'
      }
    },
    results,
    adversarial
  };

  fs.writeFileSync(path.join(root, 'repoguide_independent_audit_results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
