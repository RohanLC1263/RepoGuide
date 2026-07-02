const fs = require('node:fs');
const path = require('node:path');

const { LogicalUnitStore } = require('../out/store/logicalUnitStore.js');
const { FactStore } = require('../out/store/factStore.js');
const { LogicalUnitBm25Store } = require('../out/store/logicalUnitBm25Store.js');
const { ProgramGraphStore } = require('../out/store/programGraphStore.js');
const { EvidencePacketBuilder } = require('../out/query/evidencePacketBuilder.js');
const { EvidenceAnswerSynthesizer } = require('../out/query/evidenceAnswerSynthesizer.js');
const { AnswerGate } = require('../out/query/answerGate.js');
const { buildEvidencePlan } = require('../out/query/evidencePlanner.js');

const root = path.resolve(__dirname, '..');
const repoguideDir = path.join(root, '.repoguide');

const context = {
  workspaceRoot: root,
  getConfig(key, fallback) {
    if (key === 'ollamaUrl') return 'http://localhost:11434';
    return fallback;
  },
  asRelativePath(filePath) {
    return path.relative(root, filePath).replace(/\\/g, '/');
  },
  logger: {
    info() {},
    warn() {},
    error() {},
    appendLine() {}
  }
};

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
  const synthesizer = new EvidenceAnswerSynthesizer(context);
  const gate = new AnswerGate();

  const questions = [
    'Where is DEFAULT_THRESHOLD_2 defined?',
    'How does HybridRetrievalFusionV2 work?',
    'What calls definitely_not_a_real_method?'
  ];
  const results = [];
  for (const question of questions) {
    const plan = buildEvidencePlan(question);
    const packet = await builder.buildPacket(question, plan);
    const answer = await synthesizer.synthesize(packet, 'qwen2.5-coder:3b');
    const gateResult = gate.verify(answer, packet);
    results.push({
      question,
      queryType: plan.queryType,
      retrievedCount: packet.facts.length + packet.items.length,
      gaps: packet.gaps,
      coverageScore: packet.coverageScore,
      answer,
      gateOutcome: gateResult.outcome,
      gateDiagnostics: gateResult.diagnostics,
      finalAnswer: gateResult.finalAnswer
    });
  }

  fs.writeFileSync(
    path.join(root, 'repoguide_llm_adversarial_results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)
  );
  console.log(JSON.stringify(results.map(r => ({
    question: r.question,
    gateOutcome: r.gateOutcome,
    gaps: r.gaps,
    answerPreview: r.finalAnswer.slice(0, 500)
  })), null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
