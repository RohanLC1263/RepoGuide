export interface UnderstandingQualityMetricsReport {
    summaryLine: string;
    [key: string]: any;
}
export class UnderstandingQualityMetrics {
    constructor(a?:any, b?:any) {}
    compute(): UnderstandingQualityMetricsReport {
        return { summaryLine: "Quality is OK" } as any;
    }
    getSummaryLine(report: any): string {
        return report?.summaryLine || "OK";
    }
    calculate() { return {}; }
}
