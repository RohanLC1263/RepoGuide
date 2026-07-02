import * as fs from 'fs';
import * as path from 'path';
import { GoldenQuestionSet } from './types';

const VALID_TYPES = new Set(['orientation', 'location', 'flow', 'explanation', 'uncertainty', 'staleness']);

export function loadGoldenQuestionSet(filePath: string): GoldenQuestionSet {
    const resolved = path.resolve(filePath);
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as GoldenQuestionSet;
    validateGoldenQuestionSet(parsed, resolved);
    return parsed;
}

function validateGoldenQuestionSet(set: GoldenQuestionSet, filePath: string): void {
    if (set.schemaVersion !== '1.0') {
        throw new Error(`Invalid golden question set schema in ${filePath}`);
    }
    if (!Array.isArray(set.questions) || set.questions.length === 0) {
        throw new Error(`Golden question set has no questions: ${filePath}`);
    }

    const ids = new Set<string>();
    for (const question of set.questions) {
        if (!question.id || ids.has(question.id)) {
            throw new Error(`Golden question has missing or duplicate id in ${filePath}`);
        }
        ids.add(question.id);
        if (!VALID_TYPES.has(question.type)) {
            throw new Error(`Golden question ${question.id} has invalid type: ${question.type}`);
        }
        if (!question.question?.trim()) {
            throw new Error(`Golden question ${question.id} has no question text`);
        }
        if (!question.expectedAnswer?.trim()) {
            throw new Error(`Golden question ${question.id} has no expected answer`);
        }
        if (question.requiresLocations && (!question.expectedLocations || question.expectedLocations.length === 0)) {
            throw new Error(`Golden question ${question.id} requires locations but has no expectedLocations`);
        }
        if (question.type === 'flow' && !question.expectedFlow) {
            throw new Error(`Flow question ${question.id} has no expectedFlow`);
        }
        if (question.type === 'uncertainty' && !question.uncertaintyExpectation) {
            throw new Error(`Uncertainty question ${question.id} has no uncertaintyExpectation`);
        }
    }
}
