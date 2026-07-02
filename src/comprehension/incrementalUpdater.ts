export class IncrementalUpdater {
    constructor(a?: any, b?: any) {}
    async update(filePath: string, state: any) {
        return {
            result: { filePath, structureChanged: false },
            fileStructures: state.fileStructures,
            fileUnderstandings: state.fileUnderstandings,
            moduleUnderstandings: state.moduleUnderstandings,
            callGraph: state.callGraph
        };
    }
}
