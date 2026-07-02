import { DashboardRenderer } from './rendererContract';
import { EvaluationResult } from '../evaluationModels';

export class JsonRenderer implements DashboardRenderer {
    public readonly format = 'json';

    public render(result: EvaluationResult): string {
        return JSON.stringify(result, null, 2);
    }
}
