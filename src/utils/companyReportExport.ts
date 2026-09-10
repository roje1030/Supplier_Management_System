import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import html2canvas from 'html2canvas';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { SurveyType } from '../types/survey';
import { CompanyComposite } from './scoring';
import { logExport } from './exportHistory';
import { formatCompositeScore } from '../data/questionWeights';

/** What graph sections the person chose to include, plus the captured chart images (if any). */
export interface CompanyReportGraphSelection {
  bar: boolean;
  radar: boolean;
  trend: boolean;
  perQuestion: boolean;
}

export interface CompanyReportQuestionRow {
  question: string;
  average: number;
  responses: number;
}

export interface CompanyReportChartImages {
  bar?: string | null; // PNG data URL
  radar?: string | null;
  trend?: string | null;
}

export interface CompanyReportData {
  company: string;
  surveyType: SurveyType;
  composite: CompanyComposite | null;
  generatedOn: string;
  graphs?: CompanyReportGraphSelection;
  includeComments: boolean;
  questionRows: CompanyReportQuestionRow[];
  chartImages?: CompanyReportChartImages;
  selectedCommentsList?: { responseId: string; comment: string; respondentType: string; department?: string; submissionDate: string }[];
}

const BRAND = [0, 99, 169] as const;
const BRAND_HEX = '0063A9';
const INK_HEX = '1E293B';
const MUTED_HEX = '64748B';
const RULE_HEX = 'E2E8F0';

const LOGO_URL = '/microgenesis_logo.png';
const LOGO_ASPECT = 498 / 1921; // height / width, from the source asset

/** Renders one DOM node (a chart wrapper) to a PNG data URL for embedding in PDF/DOCX exports. */
export async function captureChartImage(node: HTMLElement | null): Promise<string | null> {
  if (!node) return null;
  try {
    const canvas = await html2canvas(node, { backgroundColor: '#ffffff', scale: 2, logging: false });
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function dataUrlDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 600, height: img.naturalHeight || 300 });
    img.onerror = () => resolve({ width: 600, height: 300 });
    img.src = dataUrl;
  });
}

/** Fetches the Microgenesis wordmark from /public and returns it as a data URL for embedding. */
async function fetchLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch(LOGO_URL);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('logo read failed'));
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* PDF export                                                          */
/* ------------------------------------------------------------------ */

export async function exportCompanyReportAsPDF(
  data: CompanyReportData,
  customFilename?: string,
  previewOnly?: boolean,
  asDataUri?: boolean
): Promise<string | undefined> {
  const composite = data.composite ?? {
    company: data.company,
    surveyType: data.surveyType,
    compositeScore: 0,
    band: { label: 'No Score Yet', min: -1, hex: '#94a3b8' },
    sections: [],
    ratedQuestionCount: 0,
    evaluationCount: 0,
    hasScore: false,
    stdDev: 0,
    naRate: 0,
    rankScore: 0,
  };
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginLeft = 48;
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;
  const contentWidth = pageWidth - marginLeft * 2;
  const logoDataUrl = await fetchLogoDataUrl();

  /* ---------------- Cover page ---------------- */
  if (logoDataUrl) {
    const coverLogoWidth = 190;
    const coverLogoHeight = coverLogoWidth * LOGO_ASPECT;
    doc.addImage(logoDataUrl, 'PNG', (pageWidth - coverLogoWidth) / 2, 168, coverLogoWidth, coverLogoHeight);
  }

  doc.setDrawColor(...BRAND);
  doc.setLineWidth(1.1);
  doc.line(pageWidth / 2 - 70, 258, pageWidth / 2 + 70, 258);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(23);
  doc.setTextColor(30, 30, 30);
  doc.text('Company Performance Report', pageWidth / 2, 312, { align: 'center' });

  doc.setFontSize(16);
  doc.setTextColor(...BRAND);
  doc.text(data.company, pageWidth / 2, 338, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(100);
  doc.text(`${data.surveyType} Evaluation  \u00b7  Generated ${data.generatedOn}`, pageWidth / 2, 358, { align: 'center' });

  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.75);
  doc.line(pageWidth / 2 - 90, 400, pageWidth / 2 + 90, 400);

  doc.setFontSize(9.5);
  doc.setTextColor(140);
  doc.text('Prepared for internal review by the', pageWidth / 2, pageHeight - 96, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.text('Procurement Group', pageWidth / 2, pageHeight - 82, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.text('This document is confidential and intended solely for the named recipient.', pageWidth / 2, pageHeight - 62, {
    align: 'center',
  });

  doc.addPage();

  const HEADER_BOTTOM = 74;
  let cursorY = HEADER_BOTTOM + 22;

  const drawHeader = () => {
    if (logoDataUrl) {
      const hw = 84;
      const hh = hw * LOGO_ASPECT;
      doc.addImage(logoDataUrl, 'PNG', marginLeft, 22, hw, hh);
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(30, 30, 30);
    doc.text(data.company, pageWidth - marginLeft, 36, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(140);
    doc.text('Company Performance Report', pageWidth - marginLeft, 48, { align: 'right' });
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.75);
    doc.line(marginLeft, HEADER_BOTTOM, pageWidth - marginLeft, HEADER_BOTTOM);
  };

  const ensureSpace = (needed: number) => {
    if (cursorY + needed > pageHeight - 56) {
      doc.addPage();
      drawHeader();
      cursorY = HEADER_BOTTOM + 22;
    }
  };

  drawHeader();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14.5);
  doc.setTextColor(20, 20, 20);
  doc.text('Executive Summary', marginLeft, cursorY);
  cursorY += 16;

  // Score summary strip
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(marginLeft, cursorY, contentWidth, 48, 5, 5, 'S');
  doc.setFontSize(8.5);
  doc.setTextColor(100);
  doc.text('COMPOSITE SCORE', marginLeft + 12, cursorY + 17);
  doc.text('RATING BAND', marginLeft + 190, cursorY + 17);
  doc.text('EVALUATIONS', marginLeft + 340, cursorY + 17);
  doc.setFontSize(13.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...BRAND);
  doc.text(formatCompositeScore(data.surveyType, composite.compositeScore).text, marginLeft + 12, cursorY + 35);
  doc.setTextColor(20, 20, 20);
  doc.text(composite.band.label, marginLeft + 190, cursorY + 35);
  doc.text(String(composite.evaluationCount), marginLeft + 340, cursorY + 35);
  doc.setFont('helvetica', 'normal');
  cursorY += 72;

  const addImageSection = async (title: string, dataUrl: string | null | undefined, widthScale: number) => {
    if (!dataUrl) return;
    const { width, height } = await dataUrlDimensions(dataUrl);
    const drawWidth = contentWidth * widthScale;
    const drawHeight = (height / width) * drawWidth;
    ensureSpace(drawHeight + 30);
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20, 20, 20);
    doc.text(title, marginLeft, cursorY);
    cursorY += 11;
    const x = marginLeft + (contentWidth - drawWidth) / 2;
    doc.addImage(dataUrl, 'PNG', x, cursorY, drawWidth, drawHeight);
    cursorY += drawHeight + 18;
  };

  // Bar/radar: compact, roughly half the content width so both sit comfortably on one A4 page.
  // Trend: wider and shorter, spanning most of the content width so the x-axis has room to breathe.
  if (data.graphs?.bar) await addImageSection('Section Scores \u2014 Bar Graph', data.chartImages?.bar, 0.9);
  if (data.graphs?.radar) await addImageSection('Section Scores \u2014 Radar Graph', data.chartImages?.radar, 0.9);
  if (data.graphs?.trend) await addImageSection('Score Trend', data.chartImages?.trend, 0.9);

  if (data.graphs?.perQuestion) {
    ensureSpace(180);
    doc.setFontSize(11.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20, 20, 20);
    doc.text('Per-Question Average Rating', marginLeft, cursorY);
    cursorY += 8;
    autoTable(doc, {
      startY: cursorY,
      head: [['Question', 'Average Rating', 'Responses']],
      body: data.questionRows.map((row) => [row.question, `${row.average.toFixed(1)}`, String(row.responses)]),
      margin: { left: marginLeft, right: marginLeft, top: HEADER_BOTTOM + 16 },
      styles: { fontSize: 9, cellPadding: 6 },
      headStyles: { fillColor: BRAND as unknown as [number, number, number], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      theme: 'striped',
      didDrawPage: () => drawHeader(),
    });
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
  }

  if (data.includeComments) {
    const comments = data.selectedCommentsList || [];
    ensureSpace(150);
    doc.setFontSize(11.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20, 20, 20);
    doc.text('Stakeholder Comments', marginLeft, cursorY);
    cursorY += 8;

    if (comments.length === 0) {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(120);
      doc.text('No comments selected for display.', marginLeft, cursorY, {
        maxWidth: contentWidth,
      });
      cursorY += 26;
    } else {
      autoTable(doc, {
        startY: cursorY,
        head: [['#', 'Feedback / Comments']],
        body: comments.map((c, idx) => [String(idx + 1), `"${c.comment}"`]),
        margin: { left: marginLeft, right: marginLeft, top: HEADER_BOTTOM + 16 },
        styles: { fontSize: 9, cellPadding: 6, fontStyle: 'italic' },
        columnStyles: {
          0: { fontStyle: 'normal', halign: 'center' as const },
          1: { fontStyle: 'italic' }
        },
        headStyles: { fillColor: BRAND as unknown as [number, number, number], textColor: 255, fontStyle: 'bold', fontSize: 9 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        theme: 'striped',
        didDrawPage: () => drawHeader(),
      });
      cursorY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
    }
  }

  // Footer on every content page (cover page excluded)
  const pageCount = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  for (let i = 2; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.5);
    doc.line(marginLeft, pageHeight - 34, pageWidth - marginLeft, pageHeight - 34);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(150);
    doc.text('Microgenesis Supplier Management System \u2014 Confidential', marginLeft, pageHeight - 20);
    doc.text(`Page ${i - 1} of ${pageCount - 1}`, pageWidth - marginLeft, pageHeight - 20, { align: 'right' });
  }

  const companyClean = data.company.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = customFilename || `${companyClean}_Feedback_Report_${dateStr}.pdf`;
  if (asDataUri) {
    // Used for email attachments (see graphMailService.ts) - no object URL/
    // blob lifecycle to manage, just a base64 string ready to embed.
    return doc.output('datauristring') as unknown as string;
  }
  if (previewOnly) {
    const blob = doc.output('blob');
    const blobUrl = URL.createObjectURL(blob);
    return blobUrl;
  }
  doc.save(filename);
  logExport({ title: `Company Report - ${data.company}`, format: 'pdf', filename });
}

/* ------------------------------------------------------------------ */
/* DOCX export                                                         */
/* ------------------------------------------------------------------ */

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function imageParagraph(dataUrl: string | null | undefined, title: string, maxWidth: number): Promise<Paragraph[]> {
  if (!dataUrl) return [];
  const { width, height } = await dataUrlDimensions(dataUrl);
  const drawWidth = Math.min(maxWidth, width);
  const drawHeight = (height / width) * drawWidth;

  return [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 19, color: INK_HEX })],
      spacing: { before: 240, after: 90 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          type: 'png',
          data: dataUrlToUint8Array(dataUrl),
          transformation: { width: drawWidth, height: drawHeight },
        }),
      ],
    }),
  ];
}

export async function exportCompanyReportAsDocx(data: CompanyReportData) {
  const composite = data.composite ?? {
    company: data.company,
    surveyType: data.surveyType,
    compositeScore: 0,
    band: { label: 'No Score Yet', min: -1, hex: '#94a3b8' },
    sections: [],
    ratedQuestionCount: 0,
    evaluationCount: 0,
    hasScore: false,
    stdDev: 0,
    naRate: 0,
    rankScore: 0,
  };
  const logoDataUrl = await fetchLogoDataUrl();
  const logoBytes = logoDataUrl ? dataUrlToUint8Array(logoDataUrl) : null;

  /* ---------------- Cover page (its own section, no header/footer) ---------------- */
  const coverChildren: Paragraph[] = [
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    ...(logoBytes
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: 'png',
                data: logoBytes,
                transformation: { width: 230, height: 230 * LOGO_ASPECT },
              }),
            ],
          }),
        ]
      : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { bottom: { color: BRAND_HEX, space: 8, style: BorderStyle.SINGLE, size: 10 } },
      spacing: { before: 500, after: 500 },
      children: [new TextRun({ text: ' ', size: 2 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: 'Company Performance Report', bold: true, size: 40, color: INK_HEX })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: data.company, bold: true, size: 30, color: BRAND_HEX })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 2000 },
      children: [
        new TextRun({ text: `${data.surveyType} Evaluation  \u00b7  Generated ${data.generatedOn}`, size: 20, color: MUTED_HEX }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: 'Prepared for internal review by the', size: 16, color: MUTED_HEX })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: 'Procurement Group', bold: true, size: 17, color: INK_HEX })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: 'This document is confidential and intended solely for the named recipient.',
          italics: true,
          size: 15,
          color: MUTED_HEX,
        }),
      ],
    }),
  ];

  /* ---------------- Body content ---------------- */
  const bodyBlocks: (Paragraph | Table)[] = [];

  const scoreSummaryTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 8, color: RULE_HEX },
      bottom: { style: BorderStyle.SINGLE, size: 8, color: RULE_HEX },
      left: { style: BorderStyle.SINGLE, size: 8, color: RULE_HEX },
      right: { style: BorderStyle.SINGLE, size: 8, color: RULE_HEX },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE_HEX },
      insideHorizontal: { style: BorderStyle.NIL },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: 'F8FAFC' },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 220, bottom: 220, left: 200, right: 200 },
            children: [
              new Paragraph({
                spacing: { after: 80 },
                children: [new TextRun({ text: 'COMPOSITE SCORE', bold: true, size: 18, color: MUTED_HEX })],
              }),
              new Paragraph({
                children: [new TextRun({ text: formatCompositeScore(data.surveyType, composite.compositeScore).text, bold: true, size: 56, color: BRAND_HEX })],
              }),
            ],
          }),
          new TableCell({
            shading: { fill: 'F8FAFC' },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 220, bottom: 220, left: 200, right: 200 },
            children: [
              new Paragraph({
                spacing: { after: 80 },
                children: [new TextRun({ text: 'RATING BAND', bold: true, size: 18, color: MUTED_HEX })],
              }),
              new Paragraph({
                children: [new TextRun({ text: composite.band.label, bold: true, size: 36, color: INK_HEX })],
              }),
            ],
          }),
          new TableCell({
            shading: { fill: 'F8FAFC' },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 220, bottom: 220, left: 200, right: 200 },
            children: [
              new Paragraph({
                spacing: { after: 80 },
                children: [new TextRun({ text: 'EVALUATIONS', bold: true, size: 18, color: MUTED_HEX })],
              }),
              new Paragraph({
                children: [new TextRun({ text: String(composite.evaluationCount), bold: true, size: 36, color: INK_HEX })],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  bodyBlocks.push(
    new Paragraph({
      children: [new TextRun({ text: 'Executive Summary', bold: true, size: 26, color: INK_HEX })],
      spacing: { after: 160 },
    }),
    scoreSummaryTable,
    new Paragraph({ spacing: { before: 180, after: 180 } })
  );

  // Bar/radar: compact (~45% of the ~624px content width) so both fit cleanly on one page.
  // Trend: wider (~80%) with a short, wide aspect so the x-axis has room, mirroring the dashboard view.
  if (data.graphs?.bar) bodyBlocks.push(...(await imageParagraph(data.chartImages?.bar, 'Section Scores \u2014 Bar Graph', 500)));
  if (data.graphs?.radar) bodyBlocks.push(...(await imageParagraph(data.chartImages?.radar, 'Section Scores \u2014 Radar Graph', 500)));
  if (data.graphs?.trend) bodyBlocks.push(...(await imageParagraph(data.chartImages?.trend, 'Score Trend', 500)));

  if (data.graphs?.perQuestion) {
    bodyBlocks.push(
      new Paragraph({
        children: [new TextRun({ text: 'Per-Question Average Rating', bold: true, size: 24, color: INK_HEX })],
        spacing: { before: 280, after: 110 },
      }),
    );
    const headerRow = new TableRow({
      tableHeader: true,
      children: ['Question', 'Average Rating', 'Responses'].map(
        (label) =>
          new TableCell({
            shading: { fill: BRAND_HEX },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, color: 'FFFFFF', size: 18 })] })],
          }),
      ),
    });
    const rows = data.questionRows.map(
      (row, idx) =>
        new TableRow({
          children: [
            new TableCell({
              shading: { fill: idx % 2 === 0 ? 'F8FAFC' : 'FFFFFF' },
              margins: { top: 50, bottom: 50, left: 100, right: 100 },
              children: [new Paragraph({ children: [new TextRun({ text: row.question, size: 18 })] })],
            }),
            new TableCell({
              shading: { fill: idx % 2 === 0 ? 'F8FAFC' : 'FFFFFF' },
              margins: { top: 50, bottom: 50, left: 100, right: 100 },
              children: [new Paragraph({ children: [new TextRun({ text: row.average.toFixed(1), size: 18 })] })],
            }),
            new TableCell({
              shading: { fill: idx % 2 === 0 ? 'F8FAFC' : 'FFFFFF' },
              margins: { top: 50, bottom: 50, left: 100, right: 100 },
              children: [new Paragraph({ children: [new TextRun({ text: String(row.responses), size: 18 })] })],
            }),
          ],
        }),
    );
    bodyBlocks.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [headerRow, ...rows],
      }),
    );
  }

  if (data.includeComments) {
    bodyBlocks.push(
      new Paragraph({
        children: [new TextRun({ text: 'Stakeholder Comments', bold: true, size: 24, color: INK_HEX })],
        spacing: { before: 280, after: 110 },
      })
    );

    const comments = data.selectedCommentsList || [];
    if (comments.length === 0) {
      bodyBlocks.push(
        new Paragraph({
          children: [
            new TextRun({
              text: 'No stakeholder comments selected for display.',
              italics: true,
              size: 18,
              color: MUTED_HEX,
            }),
          ],
        })
      );
    } else {
      const commentsHeaderRow = new TableRow({
        tableHeader: true,
        children: [
          new TableCell({
            shading: { fill: BRAND_HEX },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            width: { size: 8, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: '#', bold: true, color: 'FFFFFF', size: 18 })] })],
          }),
          new TableCell({
            shading: { fill: BRAND_HEX },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            width: { size: 92, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: 'Feedback / Comments', bold: true, color: 'FFFFFF', size: 18 })] })],
          }),
        ]
      });

      const commentRows = comments.map(
        (c, idx) =>
          new TableRow({
            children: [
              new TableCell({
                shading: { fill: idx % 2 === 0 ? 'F8FAFC' : 'FFFFFF' },
                margins: { top: 50, bottom: 50, left: 100, right: 100 },
                children: [new Paragraph({ children: [new TextRun({ text: String(idx + 1), size: 18 })] })],
              }),
              new TableCell({
                shading: { fill: idx % 2 === 0 ? 'F8FAFC' : 'FFFFFF' },
                margins: { top: 50, bottom: 50, left: 100, right: 100 },
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: `"${c.comment}"`,
                        italics: true,
                        size: 18,
                        color: '1E293B'
                      })
                    ]
                  })
                ],
              })
            ]
          })
      );

      bodyBlocks.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [commentsHeaderRow, ...commentRows],
        })
      );
    }
  }

  /* ---------------- Running header / footer for content pages ---------------- */
  const header = new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: 9600 }],
        border: { bottom: { color: RULE_HEX, space: 6, style: BorderStyle.SINGLE, size: 6 } },
        children: [
          ...(logoBytes
            ? [new ImageRun({ type: 'png', data: logoBytes, transformation: { width: 96, height: 96 * LOGO_ASPECT } })]
            : []),
          new TextRun({ text: '\t' }),
          new TextRun({ text: `${data.company}\n`, bold: true, size: 15, color: INK_HEX }),
          new TextRun({ text: 'Company Performance Report', size: 13, color: MUTED_HEX }),
        ],
      }),
    ],
  });

  const footer = new Footer({
    children: [
      new Paragraph({
        border: { top: { color: RULE_HEX, space: 6, style: BorderStyle.SINGLE, size: 6 } },
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: 'Microgenesis Supplier Management System \u2014 Confidential   \u00b7   Page ', size: 14, color: '94A3B8' }),
          new TextRun({ children: [PageNumber.CURRENT], size: 14, color: '94A3B8' }),
          new TextRun({ text: ' of ', size: 14, color: '94A3B8' }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: '94A3B8' }),
        ],
      }),
    ],
  });

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: 'Arial',
          },
        },
      },
    },
    sections: [
      { properties: {}, children: coverChildren },
      { properties: {}, headers: { default: header }, footers: { default: footer }, children: bodyBlocks },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filenameSafe = data.company.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const filename = `company_report_${filenameSafe}_${new Date().toISOString().slice(0, 10)}.docx`;
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  logExport({ title: `Company Report - ${data.company}`, format: 'docx', filename });
}
