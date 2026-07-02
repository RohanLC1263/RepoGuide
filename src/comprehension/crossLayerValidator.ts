
export class CrossLayerValidator {
    constructor(a?:any,b?:any,c?:any){}
    async run() { return { summary: { errors: 0, warnings: 0, infos: 0, checksRun: [], checksSkipped: [] } }; }
}
export class ValidationReporter {
    constructor(a?:any){}
    getSuggestedRepairs() { return []; }
    getCounts() { return { errors: 0, warnings: 0, infos: 0 }; }
    static loadFromDisk(a:any) { return new ValidationReporter(null); }
}
