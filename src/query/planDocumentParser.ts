import * as fs from 'fs';
import * as path from 'path';
export interface ParsedPlanDocument {
    plan_file: string;
    document_type: 'markdown' | 'txt' | 'pdf' | 'unknown';
    text: string;
    sections: Array<{
        heading: string;
        text: string;
        page_start?: number;
        page_end?: number;
    }>;
    warnings: string[];
}

export class PlanDocumentParser {
    async parse(planPath: string): Promise<ParsedPlanDocument> {
        const ext = path.extname(planPath).toLowerCase();
        
        if (ext === '.pdf') {
            return this.parsePdf(planPath);
        } else if (ext === '.md' || ext === '.txt') {
            return this.parseTextFile(planPath, ext === '.md' ? 'markdown' : 'txt');
        } else {
            return {
                plan_file: planPath,
                document_type: 'unknown',
                text: '',
                sections: [],
                warnings: [`Unsupported file extension: ${ext}`]
            };
        }
    }

    private async parseTextFile(planPath: string, type: 'markdown' | 'txt'): Promise<ParsedPlanDocument> {
        const content = await fs.promises.readFile(planPath, 'utf8');
        return {
            plan_file: planPath,
            document_type: type,
            text: content,
            sections: [
                { heading: 'Document', text: content }
            ],
            warnings: []
        };
    }

    private async parsePdf(planPath: string): Promise<ParsedPlanDocument> {
        const dataBuffer = await fs.promises.readFile(planPath);
        
        const pageTexts: { pageNum: number; text: string }[] = [];
        
        const render_page = async (pageData: any) => {
            const render_options = { normalizeWhitespace: false, disableCombineTextItems: false };
            const textContent = await pageData.getTextContent(render_options);
            let lastY, text = '';
            for (const item of textContent.items) {
                if (lastY === item.transform[5] || !lastY) {
                    text += item.str;
                } else {
                    text += '\n' + item.str;
                }
                lastY = item.transform[5];
            }
            // Fallback for page number if available, else sequential
            const pageNum = pageData.pageIndex !== undefined ? pageData.pageIndex + 1 : pageTexts.length + 1;
            pageTexts.push({ pageNum, text });
            return text;
        };

        const warnings: string[] = [];
        let data;
        try {
            const pdfParse = require('pdf-parse');
            data = await pdfParse(dataBuffer, { pagerender: render_page });
        } catch (e: any) {
            return {
                plan_file: planPath,
                document_type: 'pdf',
                text: '',
                sections: [],
                warnings: [`Failed to parse PDF: ${e.message || e}`]
            };
        }
        
        // Sort pages in case they resolved out of order
        pageTexts.sort((a, b) => a.pageNum - b.pageNum);
        
        const rawText = data.text.trim();
        const wordCount = rawText.split(/\s+/).length;
        if (data.numpages > 0 && (wordCount / data.numpages) < 20) {
            warnings.push(`Warning: Low text content detected (${wordCount} words across ${data.numpages} pages). This might be a scanned PDF or image-heavy document. Extracted text may be sparse.`);
        }

        const sections = pageTexts.map(pt => ({
            heading: `Page ${pt.pageNum}`,
            text: pt.text,
            page_start: pt.pageNum,
            page_end: pt.pageNum
        }));

        return {
            plan_file: planPath,
            document_type: 'pdf',
            text: rawText,
            sections: sections,
            warnings
        };
    }
}
