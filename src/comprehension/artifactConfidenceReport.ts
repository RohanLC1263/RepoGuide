import * as fs from 'fs';
import * as path from 'path';

export interface ConfidenceStats {
  avg: number;
  min: number;
  max: number;
  lowCount: number;
  totalSum: number;
  count: number;
}

export interface LowConfidenceItem {
  id: string;
  field: string;
  confidence: number;
  reason?: string;
}

export interface ArtifactConfidence {
  averageConfidence: number;
  fieldBreakdown: Record<string, ConfidenceStats>;
  lowConfidenceItems: LowConfidenceItem[];
}

export interface ConfidenceReport {
  generatedAt: string;
  artifacts: Record<string, ArtifactConfidence>;
}

export class ArtifactConfidenceReport {
  public static generate(understandingDir: string): void {
    const report: ConfidenceReport = {
      generatedAt: new Date().toISOString(),
      artifacts: {}
    };

    this.processFileUnderstandings(understandingDir, report);
    this.processModuleUnderstandings(understandingDir, report);
    this.processConceptMap(understandingDir, report);
    this.processBehavioralPaths(understandingDir, report);

    // Compute averages
    for (const artifact of Object.values(report.artifacts)) {
      let totalConfidence = 0;
      let totalFields = 0;

      for (const fieldName in artifact.fieldBreakdown) {
        const stats = artifact.fieldBreakdown[fieldName];
        if (stats.count > 0) {
          stats.avg = stats.totalSum / stats.count;
          totalConfidence += stats.totalSum;
          totalFields += stats.count;
        } else {
          stats.avg = 0;
        }
      }
      artifact.averageConfidence = totalFields > 0 ? totalConfidence / totalFields : 0;
    }

    const reportPath = path.join(understandingDir, 'confidence_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }

  private static initArtifact(report: ConfidenceReport, artifactName: string) {
    if (!report.artifacts[artifactName]) {
      report.artifacts[artifactName] = {
        averageConfidence: 0,
        fieldBreakdown: {},
        lowConfidenceItems: []
      };
    }
  }

  private static recordConfidence(
    report: ConfidenceReport,
    artifactName: string,
    id: string,
    field: string,
    confidence: number | undefined,
    reason?: string
  ) {
    if (typeof confidence !== 'number') return;

    this.initArtifact(report, artifactName);
    const artifact = report.artifacts[artifactName];

    if (!artifact.fieldBreakdown[field]) {
      artifact.fieldBreakdown[field] = { avg: 0, min: 1.0, max: 0.0, lowCount: 0, totalSum: 0, count: 0 };
    }

    const stats = artifact.fieldBreakdown[field];
    stats.count += 1;
    stats.totalSum += confidence;
    stats.min = Math.min(stats.min, confidence);
    stats.max = Math.max(stats.max, confidence);

    if (confidence < 0.5) {
      stats.lowCount += 1;
      artifact.lowConfidenceItems.push({ id, field, confidence, reason });
    }
  }

  private static processFileUnderstandings(understandingDir: string, report: ConfidenceReport) {
    const filesDir = path.join(understandingDir, 'files');
    if (!fs.existsSync(filesDir)) return;

    for (const file of fs.readdirSync(filesDir)) {
      if (!file.endsWith('.json')) continue;
      const data = this.readJson(path.join(filesDir, file));
      if (!data || !data.confidence) continue;

      const conf = data.confidence;
      const id = data.filePath || file;
      for (const [field, val] of Object.entries(conf)) {
        this.recordConfidence(report, 'file_understanding', id, field, val as number);
      }
    }
  }

  private static processModuleUnderstandings(understandingDir: string, report: ConfidenceReport) {
    const modulesDir = path.join(understandingDir, 'modules');
    if (!fs.existsSync(modulesDir)) return;

    for (const file of fs.readdirSync(modulesDir)) {
      if (!file.endsWith('.json')) continue;
      const data = this.readJson(path.join(modulesDir, file));
      if (!data || !data.confidence) continue;

      const conf = data.confidence;
      const id = data.modulePath || file;
      for (const [field, val] of Object.entries(conf)) {
        this.recordConfidence(report, 'module_understanding', id, field, val as number);
      }
    }
  }

  private static processConceptMap(understandingDir: string, report: ConfidenceReport) {
    const conceptMapPath = path.join(understandingDir, 'concept_map.json');
    const data = this.readJson(conceptMapPath);
    if (!data || !Array.isArray(data.concepts)) return;

    for (const concept of data.concepts) {
      if (!concept.confidence) continue;
      const id = concept.concept;
      for (const [field, val] of Object.entries(concept.confidence)) {
        this.recordConfidence(report, 'concept_map', id, field, val as number);
      }
    }
  }

  private static processBehavioralPaths(understandingDir: string, report: ConfidenceReport) {
    const pathsPath = path.join(understandingDir, 'behavioral_paths.json');
    const data = this.readJson(pathsPath);
    if (!data || !Array.isArray(data.paths)) return;

    for (const bPath of data.paths) {
      if (!bPath.confidence) continue;
      const id = bPath.id;
      for (const [field, val] of Object.entries(bPath.confidence)) {
        this.recordConfidence(report, 'behavioral_paths', id, field, val as number);
      }
    }
  }

  private static readJson(filePath: string): any {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }
}
