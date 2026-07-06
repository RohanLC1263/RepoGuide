import test from 'node:test';
import * as assert from 'node:assert/strict';
import { MentorInsightRenderer } from '../../mentor/mentorInsightRenderer';
import { MentorExplanationContext, ArchitectureRecommendation, ChangeRecommendation, OnboardingRecommendation, RefactoringRecommendation } from '../../mentor/mentorTypes';

function context(recommendation: MentorExplanationContext['recommendation'], reasoningFactors: string[] = []): MentorExplanationContext {
    return { recommendation, reasoningFactors } as MentorExplanationContext;
}

test('MentorInsightRenderer suppresses Architecture Insights when every underlying list is empty (real dogfood reproduction)', () => {
    // Reproduces the exact case found dogfooding: a fixed narrative-summary template
    // ("Architecture revolves around core components, prioritizing 0 files as
    // structural entry points.") is non-empty text even with nothing substantive
    // behind it, so a naive "is the summary truthy" check always renders the block.
    const rec: ArchitectureRecommendation = {
        type: 'architecture',
        majorComponents: [],
        importantFiles: [],
        suggestedReadingOrder: [],
        architectureSummary: 'Architecture revolves around core components, prioritizing 0 files as structural entry points.'
    };
    const renderer = new MentorInsightRenderer();
    const result = renderer.render(context(rec));
    assert.equal(result, '');
});

test('MentorInsightRenderer renders Architecture Insights when there is real, structured content', () => {
    const rec: ArchitectureRecommendation = {
        type: 'architecture',
        majorComponents: ['Auth', 'Billing'],
        importantFiles: ['src/auth.ts'],
        suggestedReadingOrder: ['src/auth.ts', 'src/billing.ts'],
        architectureSummary: 'Architecture revolves around Auth, prioritizing 2 files as structural entry points.'
    };
    const renderer = new MentorInsightRenderer();
    const result = renderer.render(context(rec));
    assert.ok(result.includes('### Architecture Insights'));
    assert.ok(result.includes('Auth'));
});

test('MentorInsightRenderer suppresses Change Impact Analysis when there are no affected files/symbols', () => {
    const rec: ChangeRecommendation = {
        type: 'change',
        blastRadius: [],
        affectedFiles: [],
        affectedSymbols: [],
        riskLevel: 'LOW'
    };
    const renderer = new MentorInsightRenderer();
    const result = renderer.render(context(rec));
    assert.equal(result, '');
});

test('MentorInsightRenderer renders Change Impact Analysis when there are real affected files', () => {
    const rec: ChangeRecommendation = {
        type: 'change',
        blastRadius: [],
        affectedFiles: ['src/a.ts', 'src/b.ts'],
        affectedSymbols: [],
        riskLevel: 'HIGH'
    };
    const renderer = new MentorInsightRenderer();
    const result = renderer.render(context(rec));
    assert.ok(result.includes('### Change Impact Analysis'));
    assert.ok(result.includes('src/a.ts'));
});

test('MentorInsightRenderer suppresses Recommended Learning Path when there are no files or learning path', () => {
    const rec: OnboardingRecommendation = { type: 'onboarding', modules: [], learningPath: [], firstFiles: [] };
    const renderer = new MentorInsightRenderer();
    const result = renderer.render(context(rec));
    assert.equal(result, '');
});

test('MentorInsightRenderer suppresses Refactoring Opportunities when there are no hotspots/modules/warnings', () => {
    const rec: RefactoringRecommendation = { type: 'refactoring', dependencyRisks: [], largeModules: [], warnings: [], hotspots: [] };
    const renderer = new MentorInsightRenderer();
    const result = renderer.render(context(rec));
    assert.equal(result, '');
});

test('MentorInsightRenderer renders a block with only real reasoning factors, even with empty lists', () => {
    const rec: ArchitectureRecommendation = {
        type: 'architecture',
        majorComponents: [],
        importantFiles: [],
        suggestedReadingOrder: [],
        architectureSummary: ''
    };
    const renderer = new MentorInsightRenderer();
    const result = renderer.render(context(rec, ['This module has an unusually high fan-in from other packages.']));
    assert.ok(result.includes('### Architecture Insights'));
    assert.ok(result.includes('unusually high fan-in'));
});
