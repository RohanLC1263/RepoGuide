import { DatabaseSync } from 'node:sqlite';
import { RuntimeBaselineBuilder } from './runtimeBaselineBuilder';
import { RuntimeCalibrationBuilder } from './runtimeCalibrationBuilder';
import { RuntimeHealthBuilder } from './runtimeHealthBuilder';
import { RuntimePatternBuilder } from './runtimePatternBuilder';

export class RuntimeIntelligenceBuilder {
    constructor(private db: DatabaseSync) {}

    public async build(): Promise<void> {
        new RuntimeBaselineBuilder(this.db).build();
        new RuntimeCalibrationBuilder(this.db).build();
        new RuntimeHealthBuilder(this.db).build();
        new RuntimePatternBuilder(this.db).build();
    }
}
