import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMoodleHttpServer, type MoodleHttpServerInstance } from '../src/http-app.js';
import type { MoodleConfig } from '../src/moodle.js';

const SECRET_MOODLE_TOKEN = 'SECRET_V120_MOODLE_WSTOKEN_ABCDEF0123456789';
const MCP_BEARER_TOKEN = 'MCP_V120_AUTH_TOKEN_987654321';

interface BannerSpec {
  label: string;
  xPt: number;
  yPt: number;
}

/**
 * Builds deterministic PDF 1.4 documents supporting:
 * - native text layers
 * - positioned RGB raster image banners (zero native PDF text layer)
 * - blank/illegible raster images
 * - optional PDF /Encrypt dictionary (simulating password-protected PDFs)
 */
function buildV120TestPdf(
  pages: Array<{
    nativeTexts?: Array<{ text: string; xPt: number; yPt: number }>;
    banners?: BannerSpec[];
    blankImage?: boolean;
  }>,
  options: { encrypted?: boolean } = {}
): Buffer {
  const objects: Buffer[] = [];
  const addObj = (body: string | Buffer): number => {
    const buf = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    objects.push(buf);
    return objects.length;
  };

  const fontObjId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const glyphs: Record<string, string[]> = {
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  };

  function buildRgbBanner(label: string): { id: number; width: number; height: number } {
    const scale = 6;
    const margin = 24;
    const charW = 7 * scale;
    const width = margin * 2 + Math.max(1, label.length) * charW;
    const height = margin * 2 + 7 * scale;
    const rgb = Buffer.alloc(width * height * 3, 255);

    for (let idx = 0; idx < label.length; idx++) {
      const pattern = glyphs[label[idx]] || glyphs[' '];
      const baseX = margin + idx * charW;
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (pattern[r][c] === '1') {
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                const px = baseX + c * scale + dx;
                const py = margin + r * scale + dy;
                const off = (py * width + px) * 3;
                rgb[off] = 0;
                rgb[off + 1] = 0;
                rgb[off + 2] = 0;
              }
            }
          }
        }
      }
    }

    const header = Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n`,
      'latin1'
    );
    const footer = Buffer.from('\nendstream', 'latin1');
    return { id: addObj(Buffer.concat([header, rgb, footer])), width, height };
  }

  const pageObjIds: number[] = [];
  const pagesTreePlaceholderIdx = objects.length;
  objects.push(Buffer.alloc(0));
  const pagesTreeObjId = pagesTreePlaceholderIdx + 1;

  for (const spec of pages) {
    const xObjectEntries: string[] = [];
    const streamOps: string[] = [];
    let imgCounter = 1;

    if (spec.blankImage) {
      const w = 160;
      const h = 80;
      const whiteRgb = Buffer.alloc(w * h * 3, 252);
      const id = addObj(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${whiteRgb.length} >>\nstream\n`,
            'latin1'
          ),
          whiteRgb,
          Buffer.from('\nendstream', 'latin1'),
        ])
      );
      const imName = `/Im${imgCounter++}`;
      xObjectEntries.push(`${imName} ${id} 0 R`);
      streamOps.push(`q 200 0 0 100 100 500 cm ${imName} Do Q`);
    }

    for (const b of spec.banners || []) {
      const img = buildRgbBanner(b.label);
      const imName = `/Im${imgCounter++}`;
      xObjectEntries.push(`${imName} ${img.id} 0 R`);
      const ptW = Math.round(img.width * 0.45);
      const ptH = Math.round(img.height * 0.45);
      streamOps.push(`q ${ptW} 0 0 ${ptH} ${b.xPt} ${b.yPt} cm ${imName} Do Q`);
    }

    for (const nt of spec.nativeTexts || []) {
      const escaped = nt.text
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
      streamOps.push(`BT /F1 13 Tf ${nt.xPt} ${nt.yPt} Td (${escaped}) Tj ET`);
    }

    const contentStream = streamOps.join('\n');
    const contentObjId = addObj(
      `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`
    );

    const xObjDict =
      xObjectEntries.length > 0 ? `/XObject << ${xObjectEntries.join(' ')} >>` : '';
    const pageObjId = addObj(
      `<< /Type /Page /Parent ${pagesTreeObjId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjId} 0 R >> ${xObjDict} >> /Contents ${contentObjId} 0 R >>`
    );
    pageObjIds.push(pageObjId);
  }

  objects[pagesTreePlaceholderIdx] = Buffer.from(
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>`,
    'latin1'
  );

  const catalogObjId = addObj(`<< /Type /Catalog /Pages ${pagesTreeObjId} 0 R >>`);
  const encryptObjId = options.encrypted
    ? addObj(
        '<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> /U <FEDCBA9876543210FEDCBA987654321000000000000000000000000000000000> >>'
      )
    : undefined;

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [0];
  let currentOffset = chunks[0].length;

  for (let i = 0; i < objects.length; i++) {
    offsets.push(currentOffset);
    const prefix = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const suffix = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(prefix, objects[i], suffix);
    currentOffset += prefix.length + objects[i].length + suffix.length;
  }

  const xrefStart = currentOffset;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i <= objects.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }

  const encryptTrailer = encryptObjId
    ? ` /Encrypt ${encryptObjId} 0 R /ID [<11223344556677889900AABBCCDDEEFF> <11223344556677889900AABBCCDDEEFF>]`
    : '';
  const trailer =
    xrefLines.join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjId} 0 R${encryptTrailer} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(chunks);
}

function parseToolJson(result: any): any {
  const firstText = result?.content?.find((c: any) => c.type === 'text')?.text;
  expect(firstText).toBeTruthy();
  expect(firstText).not.toContain(SECRET_MOODLE_TOKEN);
  expect(firstText).not.toContain(MCP_BEARER_TOKEN);
  return JSON.parse(firstText);
}

describe('UFSC Moodle MCP v1.2.0 — Grupos Definitivos, Avaliações em Lote, Publicação Controlada e OCR Local', () => {
  let mockMoodleServer: http.Server;
  let mockMoodleBaseUrl: string;
  let mcpApp: MoodleHttpServerInstance;
  let mcpBaseUrl: string;
  let mcpClient: Client;
  let tempRootDir: string;
  let auditLogPath: string;
  let gradingStateDir: string;

  // Mutable mock Moodle state for write/commit/verify/concurrency tests
  interface MockStudentGradeRecord {
    grade: string | null;
    feedbackHtml: string;
    workflowstate: string;
    mailed: number;
    locked: number;
    hidden: boolean;
    grader: number;
    timemodified: number;
  }

  const gradesState = new Map<number, MockStudentGradeRecord>();
  let saveGradeCalls: Array<{
    assignmentid: number;
    userid: number;
    grade: string;
    workflowstate: string;
    applytoall: string;
    feedbackHtml: string;
  }> = [];
  let setUserFlagsCalls: Array<{
    assignmentid: number;
    userid: number;
    mailed: string | null;
    workflowstate: string | null;
  }> = [];
  let failSaveGradeOnceForUserId: number | null = null;

  // Test PDFs
  const nativeCanvasPdf = buildV120TestPdf([
    {
      nativeTexts: [
        { text: 'Business Model Canvas Equipe UFSC Proposta de Valor', xPt: 45, yPt: 760 },
        { text: 'Estrutura de Custos e Fontes de Receita Blockchain', xPt: 300, yPt: 140 },
      ],
    },
  ]);

  // Positioned 2-block scanned Canvas PDF (zero native text!)
  // PDF coordinate Y=700 is near the top of an 842pt page (top-left); Y=110 is near the bottom (bottom-right)
  const scannedCanvasPdf = buildV120TestPdf([
    {
      banners: [
        { label: 'UFSC BMC 2026', xPt: 36, yPt: 700 },
        { label: 'TEST PD1', xPt: 290, yPt: 110 },
      ],
    },
  ]);

  // Mixed 3-page PDF: Page 1 native, Page 2 scanned image only, Page 3 native
  const mixedThreePagePdf = buildV120TestPdf([
    {
      nativeTexts: [
        { text: 'Pagina 1 Especificacao Arquitetural Nativa do Projeto PD1', xPt: 60, yPt: 720 },
      ],
    },
    {
      banners: [{ label: 'OCR PD2 2026', xPt: 60, yPt: 620 }],
    },
    {
      nativeTexts: [
        { text: 'Pagina 3 Consideracoes Finais e Analise de Seguranca Nativa', xPt: 60, yPt: 720 },
      ],
    },
  ]);

  // 2-page pure scanned PDF for v1.2.1 acceptance test
  const twoPageScannedPdf = buildV120TestPdf([
    { banners: [{ label: 'UFSC 1', xPt: 60, yPt: 650 }] },
    { banners: [{ label: 'UFSC 2', xPt: 60, yPt: 650 }] },
  ]);

  // 3-page pure scanned PDF for maxOcrPages resource capping test
  const threePageScannedPdf = buildV120TestPdf([
    { banners: [{ label: 'UFSC 1', xPt: 60, yPt: 650 }] },
    { banners: [{ label: 'UFSC 2', xPt: 60, yPt: 650 }] },
    { banners: [{ label: 'UFSC 3', xPt: 60, yPt: 650 }] },
  ]);

  // Blank / illegible image PDF
  const blankImagePdf = buildV120TestPdf([{ blankImage: true }]);

  // Corrupted PDF with %PDF header
  const corruptedPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<<BROKEN_STREAM_AND_MISSING_XREF',
    'latin1'
  );

  // Encrypted / password-protected PDF
  const passwordProtectedPdf = buildV120TestPdf(
    [{ nativeTexts: [{ text: 'Conteudo Secreto Criptografado', xPt: 72, yPt: 720 }] }],
    { encrypted: true }
  );

  function resetInitialAcademicState(): void {
    gradesState.clear();
    saveGradeCalls = [];
    setUserFlagsCalls = [];
    failSaveGradeOnceForUserId = null;

    // Group 67199 ("🐀", 5 members: 41049, 41050, 41051, 41052, 41053) -> ALL 5 graded 10.00000 with feedback
    for (const uid of [41049, 41050, 41051, 41052, 41053]) {
      gradesState.set(uid, {
        grade: '10.00000',
        feedbackHtml: '<p>Excelente Business Model Canvas e tokenomics bem fundamentada.</p>',
        workflowstate: '',
        mailed: 1,
        locked: 0,
        hidden: false,
        grader: 999,
        timemodified: 1761000000,
      });
    }

    // Group 68884 ("Os Bacanudos", 4 members: 85444, 85445, 85446, 85447) -> PARTIALLY graded (2 graded, 2 not graded, no comments)
    for (const uid of [85444, 85445]) {
      gradesState.set(uid, {
        grade: '9.00000',
        feedbackHtml: '',
        workflowstate: '',
        mailed: 1,
        locked: 0,
        hidden: false,
        grader: 999,
        timemodified: 1761000500,
      });
    }

    // Group 67336 ("Group 1", 4 members: 39186, 39187, 39188, 55001) -> DIVERGENT grades (8.00000 vs 9.50000)
    gradesState.set(39186, {
      grade: '9.50000',
      feedbackHtml: '<p>Boa apresentação individual.</p>',
      workflowstate: '',
      mailed: 1,
      locked: 0,
      hidden: false,
      grader: 999,
      timemodified: 1761001000,
    });
    gradesState.set(39187, {
      grade: '8.00000',
      feedbackHtml: '<p>Participação parcial.</p>',
      workflowstate: '',
      mailed: 1,
      locked: 0,
      hidden: false,
      grader: 999,
      timemodified: 1761001000,
    });
  }

  beforeAll(async () => {
    resetInitialAcademicState();
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufsc-moodle-v120-test-'));
    auditLogPath = path.join(tempRootDir, 'grading-audit.jsonl');
    gradingStateDir = path.join(tempRootDir, 'grading-state');

    const enrolledUsers = [
      // Teacher enrolled in general class group 62318! Must NEVER appear in assignmentGroupMembers!
      {
        id: 999,
        fullname: 'Prof. Exemplo Moodle',
        email: 'professor.exemplo@ufsc.br',
        roles: [{ shortname: 'editingteacher' }],
        groups: [{ id: 62318, name: 'INE5458-08208 (20262)' }],
      },
      // Group 67199 ("🐀", 5 student members; ALL also belong to general class group 62318 FIRST in groups[]!)
      ...[41049, 41050, 41051, 41052, 41053].map((id, idx) => ({
        id,
        fullname: `Integrante Rato ${idx + 1}`,
        email: `rato${idx + 1}@grad.ufsc.br`,
        roles: [{ shortname: 'student' }],
        groups: [
          { id: 62318, name: 'INE5458-08208 (20262)' },
          { id: 67199, name: '🐀' },
        ],
      })),
      // Group 68884 ("Os Bacanudos", 4 student members; also in general class group 62318 FIRST!)
      ...[85444, 85445, 85446, 85447].map((id, idx) => ({
        id,
        fullname: `Integrante Bacanudo ${idx + 1}`,
        email: `bacanudo${idx + 1}@grad.ufsc.br`,
        roles: [{ shortname: 'student' }],
        groups: [
          { id: 62318, name: 'INE5458-08208 (20262)' },
          { id: 68884, name: 'Os Bacanudos' },
        ],
      })),
      // Group 67336 ("Group 1", 3 exclusive student members + 1 multi-group student 55001)
      ...[39186, 39187, 39188].map((id, idx) => ({
        id,
        fullname: `Integrante Group1 ${idx + 1}`,
        email: `g1_${idx + 1}@grad.ufsc.br`,
        roles: [{ shortname: 'student' }],
        groups: [
          { id: 62318, name: 'INE5458-08208 (20262)' },
          { id: 67336, name: 'Group 1' },
        ],
      })),
      // Multi-group student 55001 enrolled in BOTH project group 67336 AND project group 69001!
      {
        id: 55001,
        fullname: 'Estudante MultiGrupo Ambiguo',
        email: 'ambiguo@grad.ufsc.br',
        roles: [{ shortname: 'student' }],
        groups: [
          { id: 62318, name: 'INE5458-08208 (20262)' },
          { id: 67336, name: 'Group 1' },
          { id: 69001, name: 'Equipe Sem Entrega' },
        ],
      },
      // Exclusive member of unsubmitted group 69001
      {
        id: 55003,
        fullname: 'Estudante Equipe Sem Entrega',
        email: 'sementrega@grad.ufsc.br',
        roles: [{ shortname: 'student' }],
        groups: [
          { id: 62318, name: 'INE5458-08208 (20262)' },
          { id: 69001, name: 'Equipe Sem Entrega' },
        ],
      },
      // Student without any project group (only general turma 62318)
      {
        id: 55002,
        fullname: 'Estudante Sem Grupo de Projeto',
        email: 'semgrupo@grad.ufsc.br',
        roles: [{ shortname: 'student' }],
        groups: [{ id: 62318, name: 'INE5458-08208 (20262)' }],
      },
    ];

    mockMoodleServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host}`);

      if (reqUrl.pathname === '/webservice/rest/server.php' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const wstoken = params.get('wstoken');
        const wsfunction = params.get('wsfunction');

        if (wstoken !== SECRET_MOODLE_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              exception: 'moodle_exception',
              errorcode: 'invalidtoken',
              message: 'Token inválido',
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (wsfunction === 'core_webservice_get_site_info') {
          res.end(
            JSON.stringify({
              sitename: 'Moodle UFSC Presencial',
              username: 'professor.exemplo',
              firstname: 'Professor',
              lastname: 'Exemplo',
              fullname: 'Prof. Exemplo Moodle',
              userid: 999,
              siteurl: mockMoodleBaseUrl,
              release: '4.1.5+ (Build: 20230920)',
              version: '2022112805.05',
            })
          );
          return;
        }

        if (wsfunction === 'core_enrol_get_users_courses') {
          res.end(
            JSON.stringify([
              {
                id: 49476,
                shortname: 'INE5458-08208 (20262)',
                fullname: 'INE5458-08208 (20262) - Tópicos Especiais em Aplicações',
                visible: 1,
              },
            ])
          );
          return;
        }

        if (wsfunction === 'core_enrol_get_enrolled_users') {
          res.end(JSON.stringify(enrolledUsers));
          return;
        }

        if (wsfunction === 'core_group_get_course_groupings') {
          res.end(
            JSON.stringify([
              { id: 14942, courseid: 49476, name: 'Agrupamento de turmas', idnumber: 'agrupamento_49476' },
              { id: 14970, courseid: 49476, name: 'Deliverables', idnumber: '' },
            ])
          );
          return;
        }

        if (wsfunction === 'core_group_get_groupings') {
          res.end(
            JSON.stringify([
              {
                id: 14942,
                name: 'Agrupamento de turmas',
                groups: [{ id: 62318, name: 'INE5458-08208 (20262)' }],
              },
              {
                id: 14970,
                name: 'Deliverables',
                groups: [
                  { id: 67199, name: '🐀' },
                  { id: 68884, name: 'Os Bacanudos' },
                  { id: 67336, name: 'Group 1' },
                  { id: 69001, name: 'Equipe Sem Entrega' },
                ],
              },
            ])
          );
          return;
        }

        if (wsfunction === 'mod_assign_get_assignments') {
          res.end(
            JSON.stringify({
              courses: [
                {
                  id: 49476,
                  fullname: 'INE5458-08208 (20262) - Tópicos Especiais em Aplicações',
                  assignments: [
                    {
                      id: 125208,
                      cmid: 1564832,
                      course: 49476,
                      name: 'Project Specification - Business Canvas and Blockchain/NFT Canvas (PD1)',
                      grade: 10,
                      teamsubmission: 1,
                      teamsubmissiongroupingid: 14970,
                      preventsubmissionnotingroup: 0,
                      markingworkflow: 0,
                      markingallocation: 0,
                      duedate: 1760500000,
                      intro: '<p>Entregue o BMC e Blockchain Canvas da equipe.</p>',
                      introattachments: [],
                    },
                    {
                      id: 125999,
                      cmid: 1564999,
                      course: 49476,
                      name: 'PD2 - Avaliação com Marking Workflow Habilitado',
                      grade: 10,
                      teamsubmission: 1,
                      teamsubmissiongroupingid: 14970,
                      preventsubmissionnotingroup: 0,
                      markingworkflow: 1,
                      markingallocation: 0,
                      duedate: 1762000000,
                      intro: '<p>Tarefa com workflow de revisão ativo.</p>',
                      introattachments: [],
                    },
                  ],
                },
              ],
            })
          );
          return;
        }

        if (wsfunction === 'mod_assign_get_submissions') {
          const requestedAssignId = Number(params.get('assignmentids[0]'));
          if (requestedAssignId === 125208 || requestedAssignId === 125999) {
            res.end(
              JSON.stringify({
                assignments: [
                  {
                    assignmentid: requestedAssignId,
                    submissions: [
                      // Empty individual row for 41049 with gradingstatus="graded" while collective row has "notgraded"
                      {
                        id: 1800001,
                        userid: 41049,
                        groupid: 0,
                        status: 'new',
                        gradingstatus: 'graded',
                        timemodified: 1760400000,
                        plugins: [{ type: 'file', fileareas: [{ area: 'submission_files', files: [] }] }],
                      },
                      // Collective submission for Group 67199 ("🐀") -> native Canvas PDF
                      {
                        id: 1801671,
                        userid: 0,
                        groupid: 67199,
                        status: 'submitted',
                        gradingstatus: 'notgraded', // Classic Moodle userid=0 quirk!
                        timemodified: 1760450000,
                        plugins: [
                          {
                            type: 'file',
                            fileareas: [
                              {
                                area: 'submission_files',
                                files: [
                                  {
                                    filename: 'PD1_Equipe_Rato_Nativo.pdf',
                                    filesize: nativeCanvasPdf.length,
                                    mimetype: 'application/pdf',
                                    timemodified: 1760450000,
                                    fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/1801671/PD1_Equipe_Rato_Nativo.pdf`,
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      // Collective submission for Group 68884 ("Os Bacanudos") -> scanned image Canvas PDF!
                      {
                        id: 1801672,
                        userid: 0,
                        groupid: 68884,
                        status: 'submitted',
                        gradingstatus: 'notgraded',
                        timemodified: 1760460000,
                        plugins: [
                          {
                            type: 'file',
                            fileareas: [
                              {
                                area: 'submission_files',
                                files: [
                                  {
                                    filename: 'PD1_Os_Bacanudos_Scanned.pdf',
                                    filesize: scannedCanvasPdf.length,
                                    mimetype: 'application/pdf',
                                    timemodified: 1760460000,
                                    fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/1801672/PD1_Os_Bacanudos_Scanned.pdf`,
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      // Collective submission for Group 67336 ("Group 1") -> mixed 3-page PDF
                      {
                        id: 1801673,
                        userid: 0,
                        groupid: 67336,
                        status: 'submitted',
                        gradingstatus: 'notgraded',
                        timemodified: 1760470000,
                        plugins: [
                          {
                            type: 'file',
                            fileareas: [
                              {
                                area: 'submission_files',
                                files: [
                                  {
                                    filename: 'PD1_Group1_Misto_3Paginas.pdf',
                                    filesize: mixedThreePagePdf.length,
                                    mimetype: 'application/pdf',
                                    timemodified: 1760470000,
                                    fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/1801673/PD1_Group1_Misto_3Paginas.pdf`,
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              })
            );
            return;
          }
          res.end(JSON.stringify({ assignments: [] }));
          return;
        }

        if (wsfunction === 'mod_assign_get_grades') {
          const requestedAssignId = Number(params.get('assignmentids[0]'));
          const gradeRows = Array.from(gradesState.entries())
            .filter(([, g]) => g.grade !== null)
            .map(([userid, g], i) => ({
              id: 5000 + i,
              userid,
              grade: g.grade,
              grader: g.grader,
              timemodified: g.timemodified,
            }));
          res.end(
            JSON.stringify({
              assignments: [{ assignmentid: requestedAssignId, grades: gradeRows }],
            })
          );
          return;
        }

        if (wsfunction === 'mod_assign_get_user_flags') {
          const requestedAssignId = Number(params.get('assignmentids[0]'));
          const flags = enrolledUsers
            .filter((u) => u.id !== 999)
            .map((u) => {
              const g = gradesState.get(u.id);
              return {
                id: u.id,
                userid: u.id,
                locked: g?.locked ?? 0,
                mailed: g?.mailed ?? 0,
                extensionduedate: 0,
                workflowstate: g?.workflowstate ?? '',
                allocatedmarker: 0,
              };
            });
          res.end(
            JSON.stringify({
              assignments: [{ assignmentid: requestedAssignId, userflags: flags }],
            })
          );
          return;
        }

        if (wsfunction === 'gradereport_user_get_grade_items') {
          const usergrades = enrolledUsers
            .filter((u) => u.id !== 999)
            .map((u) => {
              const g = gradesState.get(u.id);
              return {
                userid: u.id,
                userfullname: u.fullname,
                gradeitems: [
                  {
                    id: 9001,
                    itemmodule: 'assign',
                    iteminstance: 125208,
                    cmid: 1564832,
                    graderaw: g?.grade !== null && g?.grade !== undefined ? Number(g.grade) : null,
                    gradeformatted: g?.grade ?? '-',
                    gradeishidden: Boolean(g?.hidden),
                    gradeislocked: Boolean(g?.locked),
                    gradedategraded: g?.timemodified ?? null,
                    feedback: g?.feedbackHtml ?? '',
                    feedbackformat: 1,
                  },
                  {
                    id: 9002,
                    itemmodule: 'assign',
                    iteminstance: 125999,
                    cmid: 1564999,
                    graderaw: g?.grade !== null && g?.grade !== undefined ? Number(g.grade) : null,
                    gradeformatted: g?.grade ?? '-',
                    gradeishidden: g?.workflowstate !== 'released',
                    gradeislocked: Boolean(g?.locked),
                    gradedategraded: g?.timemodified ?? null,
                    feedback: g?.feedbackHtml ?? '',
                    feedbackformat: 1,
                  },
                ],
              };
            });
          res.end(JSON.stringify({ usergrades }));
          return;
        }

        if (wsfunction === 'mod_assign_get_submission_status') {
          const assignid = Number(params.get('assignid'));
          const userid = Number(params.get('userid'));
          const g = gradesState.get(userid);

          // Simulate EXACT Moodle 4.1.5+ numeric submissiongroup response!
          let numericSubGroup = 0;
          let teamSub: any = undefined;
          if ([41049, 41050, 41051, 41052, 41053].includes(userid)) {
            numericSubGroup = 67199;
            teamSub = {
              id: 1801671,
              userid: 0,
              groupid: 67199,
              status: 'submitted',
              timemodified: 1760450000,
              plugins: [
                {
                  type: 'file',
                  fileareas: [
                    {
                      area: 'submission_files',
                      files: [
                        {
                          filename: 'PD1_Equipe_Rato_Nativo.pdf',
                          filesize: nativeCanvasPdf.length,
                          mimetype: 'application/pdf',
                          timemodified: 1760450000,
                          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/1801671/PD1_Equipe_Rato_Nativo.pdf`,
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          } else if ([85444, 85445, 85446, 85447].includes(userid)) {
            numericSubGroup = 68884;
            teamSub = {
              id: 1801672,
              userid: 0,
              groupid: 68884,
              status: 'submitted',
              timemodified: 1760460000,
              plugins: [
                {
                  type: 'file',
                  fileareas: [
                    {
                      area: 'submission_files',
                      files: [
                        {
                          filename: 'PD1_Os_Bacanudos_Scanned.pdf',
                          filesize: scannedCanvasPdf.length,
                          mimetype: 'application/pdf',
                          timemodified: 1760460000,
                          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/1801672/PD1_Os_Bacanudos_Scanned.pdf`,
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          } else if ([39186, 39187, 39188].includes(userid)) {
            numericSubGroup = 67336;
          }

          res.end(
            JSON.stringify({
              lastattempt: {
                gradingstatus:
                  g?.workflowstate ||
                  (g?.grade !== null && g?.grade !== undefined ? 'graded' : 'notgraded'),
                // Numeric ID (exact Moodle 4.1.5+ schema that triggered the v1.1.0 bug!)
                ...(numericSubGroup > 0 ? { submissiongroup: numericSubGroup } : {}),
                submission: {
                  id: 1800000 + userid,
                  userid,
                  groupid: 0,
                  status: 'new',
                  timemodified: 1760400000,
                  plugins: [{ type: 'file', fileareas: [{ area: 'submission_files', files: [] }] }],
                },
                ...(teamSub ? { teamsubmission: teamSub } : {}),
              },
              ...(g && (g.grade !== null || g.feedbackHtml)
                ? {
                    feedback: {
                      grade: g.grade !== null ? { grade: g.grade } : null,
                      gradefordisplay: g.grade ? `${g.grade} / 10.00` : '',
                      gradeddate: g.timemodified,
                      plugins: [
                        {
                          type: 'comments',
                          editorfields: [{ text: g.feedbackHtml }],
                        },
                      ],
                    },
                  }
                : {}),
              assignmentId: assignid,
            })
          );
          return;
        }

        if (wsfunction === 'core_comment_get_comments') {
          const itemid = Number(params.get('itemid'));
          if (itemid === 1801671) {
            res.end(
              JSON.stringify({
                count: 1,
                comments: [
                  {
                    id: 7701,
                    userid: 41049,
                    fullname: 'Integrante Rato 1',
                    content: '<p>Professor, enviamos a versão revisada do Canvas da equipe!</p>',
                    timecreated: 1760450100,
                  },
                ],
              })
            );
            return;
          }
          res.end(JSON.stringify({ count: 0, comments: [] }));
          return;
        }

        if (wsfunction === 'mod_assign_set_user_flags') {
          const assignmentid = Number(params.get('assignmentid'));
          const userid = Number(params.get('userflags[0][userid]'));
          const mailed = params.get('userflags[0][mailed]');
          const wf = params.get('userflags[0][workflowstate]');
          setUserFlagsCalls.push({ assignmentid, userid, mailed, workflowstate: wf });
          const cur = gradesState.get(userid) ?? {
            grade: null,
            feedbackHtml: '',
            workflowstate: '',
            mailed: 0,
            locked: 0,
            hidden: false,
            grader: 999,
            timemodified: Math.floor(Date.now() / 1000),
          };
          if (mailed !== null) cur.mailed = Number(mailed);
          if (wf !== null) cur.workflowstate = wf;
          gradesState.set(userid, cur);
          res.end(JSON.stringify([{ id: userid, userid }]));
          return;
        }

        if (wsfunction === 'mod_assign_save_grade') {
          const assignmentid = Number(params.get('assignmentid'));
          const userid = Number(params.get('userid'));
          const rawGrade = params.get('grade') ?? '-1';
          const workflowstate = params.get('workflowstate') ?? '';
          const applytoall = params.get('applytoall') ?? '0';
          const feedbackHtml =
            params.get('plugindata[assignfeedbackcomments_editor][text]') ?? '';

          if (failSaveGradeOnceForUserId !== null && userid === failSaveGradeOnceForUserId) {
            failSaveGradeOnceForUserId = null; // Fail once, succeed on retry!
            res.end(
              JSON.stringify({
                exception: 'moodle_exception',
                errorcode: 'simul_transient_write_error',
                message: `Falha transitória simulada ao gravar avaliação de ${userid}`,
              })
            );
            return;
          }

          saveGradeCalls.push({
            assignmentid,
            userid,
            grade: rawGrade,
            workflowstate,
            applytoall,
            feedbackHtml,
          });

          const numGrade = Number(rawGrade);
          const prev = gradesState.get(userid);
          gradesState.set(userid, {
            grade: Number.isFinite(numGrade) && numGrade >= 0 ? numGrade.toFixed(5) : null,
            feedbackHtml,
            workflowstate,
            mailed: prev?.mailed ?? 1,
            locked: prev?.locked ?? 0,
            hidden: assignmentid === 125999 ? workflowstate !== 'released' : false,
            grader: 999,
            timemodified: Math.floor(Date.now() / 1000),
          });

          res.end(JSON.stringify(null));
          return;
        }

        res.end(JSON.stringify({}));
        return;
      }

      if (reqUrl.pathname.startsWith('/webservice/pluginfile.php/')) {
        const token = reqUrl.searchParams.get('token');
        if (token !== SECRET_MOODLE_TOKEN) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        const decoded = decodeURIComponent(reqUrl.pathname);
        const servePdf = (buf: Buffer) => {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(buf.length),
          });
          res.end(buf);
        };

        if (decoded.endsWith('/PD1_Equipe_Rato_Nativo.pdf')) return servePdf(nativeCanvasPdf);
        if (decoded.endsWith('/PD1_Os_Bacanudos_Scanned.pdf')) return servePdf(scannedCanvasPdf);
        if (decoded.endsWith('/PD1_Group1_Misto_3Paginas.pdf')) return servePdf(mixedThreePagePdf);
        if (decoded.endsWith('/Tres_Paginas_Scanned.pdf')) return servePdf(threePageScannedPdf);
        if (decoded.endsWith('/Two_Page_Scanned.pdf')) return servePdf(twoPageScannedPdf);
        if (decoded.endsWith('/Blank_Illegible.pdf')) return servePdf(blankImagePdf);
        if (decoded.endsWith('/Corrupted.pdf')) return servePdf(corruptedPdf);
        if (decoded.endsWith('/Protected_Encrypted.pdf')) return servePdf(passwordProtectedPdf);

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => mockMoodleServer.listen(0, '127.0.0.1', resolve));
    const mAddr = mockMoodleServer.address() as { port: number };
    mockMoodleBaseUrl = `http://127.0.0.1:${mAddr.port}`;

    const config: MoodleConfig = {
      siteUrl: mockMoodleBaseUrl,
      restEndpoint: `${mockMoodleBaseUrl}/webservice/rest/server.php`,
      token: SECRET_MOODLE_TOKEN,
      tempDir: path.join(tempRootDir, 'files'),
      gradingAuditLogPath: auditLogPath,
      gradingStateDir,
      fileTtlSeconds: 600,
      maxDownloadBytes: 20 * 1024 * 1024,
      downloadTimeoutMs: 15_000,
      ocrEnabled: true,
      ocrMaxPages: 30,
      ocrDpi: 200,
      ocrTimeoutMs: 30_000,
      ocrMaxConcurrency: 2,
      ocrDefaultLanguages: ['eng', 'por'],
    };

    mcpApp = createMoodleHttpServer({
      config,
      authToken: MCP_BEARER_TOKEN,
    });

    await new Promise<void>((resolve) => mcpApp.httpServer.listen(0, '127.0.0.1', resolve));
    const appAddr = mcpApp.httpServer.address() as { port: number };
    mcpBaseUrl = `http://127.0.0.1:${appAddr.port}`;

    mcpClient = new Client({ name: 'v120-e2e-mcp-client', version: '1.2.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${mcpBaseUrl}/${MCP_BEARER_TOKEN}`)
    );
    await mcpClient.connect(transport);
  });

  afterAll(async () => {
    await mcpClient?.close().catch(() => {});
    await mcpApp?.close().catch(() => {});
    await new Promise<void>((resolve) => mockMoodleServer?.close(() => resolve()));
    fs.rmSync(tempRootDir, { recursive: true, force: true });
  });

  it('1. Descoberta externa MCP, portabilidade de JSON Schema (sem format="uri") e get_moodle_capabilities v1.3.0', async () => {
    const toolsList = await mcpClient.listTools();
    const names = toolsList.tools.map((t) => t.name);

    expect(names.length).toBe(34);
    expect(names).toContain('download_moodle_file');
    expect(names).toContain('read_moodle_file');
    expect(names).toContain('get_moodle_capabilities');
    expect(names).toContain('get_assignment_grading_overview');
    expect(names).toContain('prepare_grading_batch');
    expect(names).toContain('commit_grading_batch');
    expect(names).toContain('verify_grading_batch');
    expect(names).toContain('replace_course_resource_file');
    expect(names).toContain('verify_course_resource_file');
    expect(names).toContain('get_assignment_details');
    expect(names).toContain('prepare_assignment_update');
    expect(names).toContain('commit_assignment_update');
    expect(names).toContain('verify_assignment_update');

    // Verify ChatGPT / OpenAI MCP connector compatibility: NO schema uses format: "uri"
    for (const tool of toolsList.tools) {
      const schemaStr = JSON.stringify(tool.inputSchema);
      expect(schemaStr).not.toContain('"format":"uri"');
    }

    // Verify groupId parameter is exposed on get_submissions and get_submission_content
    const subContentTool = toolsList.tools.find((t) => t.name === 'get_submission_content');
    expect((subContentTool?.inputSchema as any)?.properties?.groupId).toBeTruthy();
    expect((subContentTool?.inputSchema as any)?.properties?.ocrMode).toBeTruthy();

    // Call get_moodle_capabilities
    const capRes = await mcpClient.callTool({
      name: 'get_moodle_capabilities',
      arguments: { checkMoodleConnection: true },
    });
    expect(capRes.isError).toBeFalsy();
    const caps = parseToolJson(capRes);

    expect(caps.serverVersion).toBe('1.4.2');
    expect(caps.availableToolsCount).toBe(34);
    expect(caps.moodleSite.connected).toBe(true);
    expect(caps.moodleSite.release).toContain('4.1.5+');
    expect(caps.ocr.available).toBe(true);
    expect(caps.ocr.tesseractAvailable).toBe(true);
    expect(caps.ocr.pdftoppmAvailable).toBe(true);
    expect(caps.batchOperations.supported).toBe(true);
    expect(caps.batchOperations.prepareIsStrictlyReadOnly).toBe(true);
    expect(caps.controlledPublication.blocksSilentReleaseWhenWorkflowDisabled).toBe(true);
    expect(caps.resourceManagement.supported).toBe(true);
    expect(caps.resourceManagement.supportsGoogleDrivePdfExport).toBe(true);
  });

  it('2. Resolução definitiva de grupos: separa turma geral (62318 com professor) de grupos do projeto (67199, 68884, 67336), ambiguidade multi-grupo e alunos sem grupo', async () => {
    // Student 41049 -> MUST resolve to 67199 ("🐀", 5 student members), NEVER 62318!
    const s41049 = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, studentId: 41049, extractFiles: false },
      })
    );
    expect(s41049.groupResolutionStatus).toBe('resolved');
    expect(s41049.assignmentGroupId).toBe(67199);
    expect(s41049.assignmentGroupName).toBe('🐀');
    expect(s41049.groupId).toBe(67199);
    expect(s41049.assignmentGroupMembers).toHaveLength(5);
    // Teacher 999 must NEVER be in assignmentGroupMembers
    expect(s41049.assignmentGroupMembers.map((m: any) => m.id)).not.toContain(999);
    expect(s41049.courseGroupIds).toEqual([62318, 67199]);
    expect(s41049.generalCourseGroupIds).toContain(62318);
    expect(s41049.effectiveSubmissionSource).toBe('group_submission');
    expect(s41049.groupSubmissionId).toBe(1801671);

    // Student 85444 -> MUST resolve to 68884 ("Os Bacanudos", 4 student members), NEVER 62318!
    const s85444 = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, studentId: 85444, extractFiles: false },
      })
    );
    expect(s85444.assignmentGroupId).toBe(68884);
    expect(s85444.assignmentGroupName).toBe('Os Bacanudos');
    expect(s85444.assignmentGroupMembers).toHaveLength(4);
    expect(s85444.groupId).toBe(68884);

    // Student 39186 -> MUST resolve to 67336 ("Group 1", 4 student members)
    const s39186 = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, studentId: 39186, extractFiles: false },
      })
    );
    expect(s39186.assignmentGroupId).toBe(67336);
    expect(s39186.assignmentGroupName).toBe('Group 1');
    expect(s39186.assignmentGroupMembers).toHaveLength(4);

    // Query directly by groupId=67199 yields identical deduplicated fileKey
    const byGroup67199 = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, groupId: 67199, extractFiles: false },
      })
    );
    expect(byGroup67199.assignmentGroupId).toBe(67199);
    expect(byGroup67199.files[0].fileKey).toBe(s41049.files[0].fileKey);

    // Querying general course group 62318 directly MUST be rejected explicitly
    const reject62318Res = await mcpClient.callTool({
      name: 'get_submission_content',
      arguments: { assignmentId: 125208, groupId: 62318, extractFiles: false },
    });
    expect(reject62318Res.isError).toBe(true);
    expect(parseToolJson(reject62318Res).errorCode).toBe(
      'general_course_group_not_assignment_group'
    );

    // Multi-group student 55001 -> explicit ambiguity (NEVER silently chooses first group!)
    const ambRes = await mcpClient.callTool({
      name: 'get_submission_content',
      arguments: { assignmentId: 125208, studentId: 55001, extractFiles: false },
    });
    expect(ambRes.isError).toBeFalsy();
    const ambData = parseToolJson(ambRes);
    expect(ambData.groupResolutionStatus).toBe('ambiguous');
    expect(ambData.assignmentGroupId).toBeNull();
    expect(ambData.groupId).toBeNull();
    expect(ambData.ambiguousGroupCandidates.map((c: any) => c.id)).toEqual([67336, 69001]);

    // Explicit disambiguation by passing both studentId=55001 and groupId=67336 works cleanly
    const disambData = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, studentId: 55001, groupId: 67336, extractFiles: false },
      })
    );
    expect(disambData.groupResolutionStatus).toBe('resolved');
    expect(disambData.assignmentGroupId).toBe(67336);
    expect(disambData.filesCount).toBe(1);

    // Student 55002 without any project group (only in general turma 62318) -> no_assignment_group
    const noGroupData = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, studentId: 55002, extractFiles: false },
      })
    );
    expect(noGroupData.groupResolutionStatus).toBe('no_assignment_group');
    expect(noGroupData.assignmentGroupId).toBeNull();
    expect(noGroupData.groupId).toBeNull();
    expect(noGroupData.filesCount).toBe(0);
  });

  it('3. Visão consolidada (get_assignment_grading_overview), estados agregados (fully_graded, partially_graded, inconsistent, not_graded) e separação submissionComments vs gradingFeedbackComments', async () => {
    const overviewRes = await mcpClient.callTool({
      name: 'get_assignment_grading_overview',
      arguments: {
        assignmentId: 125208,
        includeGroups: true,
        includeMembers: true,
        includeGrades: true,
        includeFeedback: true,
        includeWorkflow: true,
        includeVisibility: true,
      },
    });
    expect(overviewRes.isError).toBeFalsy();
    const ov = parseToolJson(overviewRes);

    expect(ov.generalCourseGroupIdsExcluded).toContain(62318);
    expect(ov.summary.totalEnrolledStudents).toBe(15); // Teacher 999 excluded!
    expect(ov.summary.totalConfiguredGroups).toBe(4);
    expect(ov.summary.groupsWithSubmissionsCount).toBe(3);
    expect(ov.summary.groupsWithoutSubmissionsCount).toBe(1);
    expect(ov.summary.distinctFilesCount).toBe(3);
    expect(ov.summary.ambiguousStudentsCount).toBe(1);
    expect(ov.summary.studentsWithoutAssignmentGroupCount).toBe(1);

    const g67199 = ov.groups.find((g: any) => g.assignmentGroupId === 67199);
    expect(g67199.rawCollectiveGradingStatus).toBe('notgraded');
    expect(g67199.aggregatedGradingStatus).toBe('fully_graded');
    expect(g67199.commonGroupGrade).toBe('10.00000');
    expect(g67199.hasGradeDivergence).toBe(false);
    expect(g67199.membersWithFeedbackCount).toBe(5);
    expect(g67199.allVisibleToStudents).toBe(true);
    // Emails omitted by default (PII protection)
    expect(g67199.members[0].email).toBeUndefined();

    const g68884 = ov.groups.find((g: any) => g.assignmentGroupId === 68884);
    expect(g68884.aggregatedGradingStatus).toBe('partially_graded');
    expect(g68884.gradedMembersCount).toBe(2);
    expect(g68884.membersWithFeedbackCount).toBe(0);

    const g67336 = ov.groups.find((g: any) => g.assignmentGroupId === 67336);
    expect(g67336.aggregatedGradingStatus).toBe('inconsistent');
    expect(g67336.hasGradeDivergence).toBe(true);
    expect(g67336.distinctMemberGrades).toEqual(['9.50000', '8.00000']);

    const g69001 = ov.groups.find((g: any) => g.assignmentGroupId === 69001);
    expect(g69001.hasSubmitted).toBe(false);
    expect(g69001.aggregatedGradingStatus).toBe('not_graded');
    expect(ov.unsubmittedGroups.map((u: any) => u.assignmentGroupId)).toEqual([69001]);

    // Verify pagination cursor
    const page1 = parseToolJson(
      await mcpClient.callTool({
        name: 'get_assignment_grading_overview',
        arguments: { assignmentId: 125208, limit: 2 },
      })
    );
    expect(page1.groups).toHaveLength(2);
    expect(page1.pagination.nextCursor).toBe('2');

    // Verify strict separation between submissionComments and gradingFeedbackComments
    const detail67199 = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: {
          assignmentId: 125208,
          studentId: 41049,
          extractFiles: false,
          includeSubmissionComments: true,
        },
      })
    );
    expect(detail67199.submissionComments.count).toBe(1);
    expect(detail67199.submissionComments.comments[0].content).toContain(
      'versão revisada do Canvas'
    );
    expect(detail67199.gradingFeedbackComments.commentType).toBe('assignfeedback_comments');
    expect(detail67199.gradingFeedbackComments.sharedFeedbackComment).toContain(
      'Excelente Business Model Canvas'
    );
    expect(detail67199.gradingFeedbackComments.sharedFeedbackComment).not.toContain(
      'versão revisada do Canvas'
    );
  });

  it('4. Fluxo prepare_grading_batch -> commit_grading_batch -> verify_grading_batch: zero escrita na prévia, preservação de campos omitidos, bloqueios de segurança, falha parcial, retomada idempotente e auditoria redigida', async () => {
    resetInitialAcademicState();

    // 4.1 Conflicts detection: general group 62318, divergent group 67336 without override, and accidental empty feedback string
    const conflictPlan = parseToolJson(
      await mcpClient.callTool({
        name: 'prepare_grading_batch',
        arguments: {
          assignmentId: 125208,
          items: [
            { groupId: 62318, grade: 10 },
            { groupId: 67336, grade: 9.0, gradingFeedbackComment: 'Feedback em grupo divergente' },
            { studentId: 41049, gradingFeedbackComment: '   ' },
          ],
        },
      })
    );
    expect(conflictPlan.writesPerformed).toBe(0);
    expect(saveGradeCalls).toHaveLength(0);
    expect(conflictPlan.readyToCommit).toBe(false);
    const conflictCodes = conflictPlan.conflicts.map((c: any) => c.code);
    expect(conflictCodes).toContain('general_course_group_rejected');
    expect(conflictCodes).toContain('member_grade_divergence_conflict');
    expect(conflictCodes).toContain('accidental_feedback_clear_blocked');

    // 4.2 Valid feedback-only batch on Group 67199 (MUST preserve existing 10.00000 grade!)
    const prepRes = await mcpClient.callTool({
      name: 'prepare_grading_batch',
      arguments: {
        assignmentId: 125208,
        items: [
          {
            groupId: 67199,
            gradingFeedbackComment:
              'Feedback complementar revisado pelo professor: detalhar melhor custos de gas no PD2.',
          },
        ],
        proposedPublicationState: 'released',
        proposedNotificationPolicy: 'suppress',
      },
    });
    expect(prepRes.isError).toBeFalsy();
    const plan = parseToolJson(prepRes);
    expect(plan.readOnlyGuarantee).toBe(true);
    expect(plan.writesPerformed).toBe(0);
    expect(saveGradeCalls).toHaveLength(0);
    expect(plan.readyToCommit).toBe(true);
    expect(plan.summary.studentsAffectedCount).toBe(5);
    expect(plan.summary.studentsWithGradeChanges).toBe(0);
    expect(plan.summary.studentsWithFeedbackChanges).toBe(5);
    for (const sc of plan.studentChanges) {
      expect(sc.gradeAction).toBe('preserve');
      expect(sc.previousGrade).toBe(10);
      expect(sc.proposedGrade).toBe(10);
      expect(sc.gradeChanged).toBe(false);
    }

    // 4.3 Block commit without confirmedByReviewer=true
    const unconfirmedRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: plan.planId,
        approvedPlanHash: plan.planHash,
        confirmedByReviewer: false,
        operationId: 'op_blocked_unconfirmed',
        publicationState: 'released',
        notificationPolicy: 'suppress',
      },
    });
    expect(unconfirmedRes.isError).toBe(true);
    expect(parseToolJson(unconfirmedRes).errorCode).toBe('confirmation_required');
    expect(saveGradeCalls).toHaveLength(0);

    // 4.4 Block commit with mismatched approvedPlanHash
    const badHashRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: plan.planId,
        approvedPlanHash: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
        confirmedByReviewer: true,
        operationId: 'op_blocked_badhash',
        publicationState: 'released',
        notificationPolicy: 'suppress',
      },
    });
    expect(badHashRes.isError).toBe(true);
    expect(parseToolJson(badHashRes).errorCode).toBe('plan_hash_mismatch');
    expect(saveGradeCalls).toHaveLength(0);

    // 4.5 Block non-released publicationState when markingworkflow === 0 (no silent release!)
    const nonWorkflowRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: plan.planId,
        approvedPlanHash: plan.planHash,
        confirmedByReviewer: true,
        operationId: 'op_blocked_workflow_disabled',
        publicationState: 'inmarking',
        notificationPolicy: 'suppress',
      },
    });
    expect(nonWorkflowRes.isError).toBe(true);
    expect(parseToolJson(nonWorkflowRes).errorCode).toBe('workflow_not_enabled_on_assignment');
    expect(saveGradeCalls).toHaveLength(0);

    // 4.6 Simulate concurrent external grade modification in Moodle -> stale_plan_conflict!
    gradesState.get(41050)!.grade = '9.25000';
    const staleRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: plan.planId,
        approvedPlanHash: plan.planHash,
        confirmedByReviewer: true,
        operationId: 'op_blocked_stale',
        publicationState: 'released',
        notificationPolicy: 'suppress',
      },
    });
    expect(staleRes.isError).toBe(true);
    expect(parseToolJson(staleRes).errorCode).toBe('stale_plan_conflict');
    expect(saveGradeCalls).toHaveLength(0);

    // Restore 41050 grade to 10.00000 and inject transient failure on 41051 (3rd member)
    gradesState.get(41050)!.grade = '10.00000';
    failSaveGradeOnceForUserId = 41051;

    // 4.7 Partial failure during commit
    const partialRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: plan.planId,
        approvedPlanHash: plan.planHash,
        confirmedByReviewer: true,
        operationId: 'op_pd1_ratos_v1',
        publicationState: 'released',
        notificationPolicy: 'suppress',
        reviewerNote: 'Aprovado após revisão docente.',
      },
    });
    expect(partialRes.isError).toBe(true);
    const partialBody = parseToolJson(partialRes);
    expect(partialBody.status).toBe('partial_failure');
    expect(partialBody.updatedStudentsCount).toBe(4);
    expect(partialBody.failedStudentsCount).toBe(1);
    expect(partialBody.failedStudents[0].studentId).toBe(41051);
    expect(saveGradeCalls).toHaveLength(4);
    // Suppress policy pre-sets mailed=1 via mod_assign_set_user_flags
    expect(setUserFlagsCalls.some((c) => c.mailed === '1')).toBe(true);

    // 4.8 Recovery: re-running same operationId with resumeFailedOnly=true writes ONLY the 1 failed student!
    const recoveredRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: plan.planId,
        approvedPlanHash: plan.planHash,
        confirmedByReviewer: true,
        operationId: 'op_pd1_ratos_v1',
        publicationState: 'released',
        notificationPolicy: 'suppress',
        resumeFailedOnly: true,
      },
    });
    expect(recoveredRes.isError).toBeFalsy();
    const recoveredBody = parseToolJson(recoveredRes);
    expect(recoveredBody.status).toBe('succeeded');
    expect(recoveredBody.updatedStudentsCount).toBe(5);
    expect(recoveredBody.failedStudentsCount).toBe(0);
    expect(recoveredBody.commentTypeUpdated).toBe('gradingFeedbackComments');
    expect(saveGradeCalls).toHaveLength(5); // Only +1 write (student 41051)!

    // 4.9 Idempotent replay: calling commit a 3rd time with same operationId performs ZERO writes!
    const replayRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: plan.planId,
        approvedPlanHash: plan.planHash,
        confirmedByReviewer: true,
        operationId: 'op_pd1_ratos_v1',
        publicationState: 'released',
        notificationPolicy: 'suppress',
      },
    });
    expect(replayRes.isError).toBeFalsy();
    const replayBody = parseToolJson(replayRes);
    expect(replayBody.status).toBe('idempotent_replay');
    expect(replayBody.idempotentReplay).toBe(true);
    expect(saveGradeCalls).toHaveLength(5); // Still 5!

    // 4.10 Post-publication live verification (verify_grading_batch)
    const verifyRes = await mcpClient.callTool({
      name: 'verify_grading_batch',
      arguments: { operationId: 'op_pd1_ratos_v1' },
    });
    expect(verifyRes.isError).toBeFalsy();
    const verifyBody = parseToolJson(verifyRes);
    expect(verifyBody.status).toBe('verified');
    expect(verifyBody.groupsExpected).toBe(1);
    expect(verifyBody.groupsVerified).toBe(1);
    expect(verifyBody.studentsExpected).toBe(5);
    expect(verifyBody.studentsVerified).toBe(5);
    expect(verifyBody.gradeMismatches).toBe(0);
    expect(verifyBody.feedbackMismatches).toBe(0);
    expect(verifyBody.workflowMismatches).toBe(0);

    // 4.11 Grade-only update via provide_feedback preserves existing feedback comment!
    await mcpClient.callTool({
      name: 'provide_feedback',
      arguments: {
        assignmentId: 125208,
        studentId: 41049,
        grade: 9.8,
      },
    });
    expect(gradesState.get(41049)?.grade).toBe('9.80000');
    expect(gradesState.get(41049)?.feedbackHtml).toContain('custos de gas no PD2');

    // Verify mismatch detection when grade was altered after plan commit
    const mismatchVerifyRes = await mcpClient.callTool({
      name: 'verify_grading_batch',
      arguments: { operationId: 'op_pd1_ratos_v1' },
    });
    expect(mismatchVerifyRes.isError).toBe(true);
    const mismatchBody = parseToolJson(mismatchVerifyRes);
    expect(mismatchBody.status).toBe('mismatch_detected');
    expect(mismatchBody.gradeMismatches).toBe(1);

    // 4.12 Marking workflow enabled assignment (125999): commit with publicationState="inmarking" keeps visibleToStudents=false
    const wfPlan = parseToolJson(
      await mcpClient.callTool({
        name: 'prepare_grading_batch',
        arguments: {
          assignmentId: 125999,
          items: [{ studentId: 85444, grade: 9.5, gradingFeedbackComment: 'Em revisão interna.' }],
          proposedPublicationState: 'inmarking',
        },
      })
    );
    const wfCommit = parseToolJson(
      await mcpClient.callTool({
        name: 'commit_grading_batch',
        arguments: {
          planId: wfPlan.planId,
          approvedPlanHash: wfPlan.planHash,
          confirmedByReviewer: true,
          operationId: 'op_wf_inmarking_1',
          publicationState: 'inmarking',
          notificationPolicy: 'suppress',
        },
      })
    );
    expect(wfCommit.status).toBe('succeeded');
    expect(wfCommit.publicationState).toBe('inmarking');
    expect(wfCommit.visibleToStudents).toBe(false);

    // 4.13 Inspect persistent redacted audit log (grading-audit.jsonl)
    expect(fs.existsSync(auditLogPath)).toBe(true);
    const auditRaw = fs.readFileSync(auditLogPath, 'utf8');
    expect(auditRaw).not.toContain(SECRET_MOODLE_TOKEN);
    expect(auditRaw).not.toContain('custos de gas no PD2'); // Full academic feedback text is NOT dumped in audit log; only SHA-256!
    const auditEntries = auditRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(auditEntries.length).toBeGreaterThanOrEqual(6);
    expect(auditEntries.some((e) => e.operation === 'commit_grading_batch_blocked')).toBe(true);
    expect(auditEntries.some((e) => e.operation === 'verify_grading_batch')).toBe(true);
  });

  it('5. OCR local automático (off, status, auto, force), layout visual com coordenadas/regiões, PDF misto sem duplicação, reuso por fileId, limites, PDF corrompido/protegido e limpeza após timeout', async () => {
    // 5.1 Scanned Canvas PDF on Group 68884: first diagnose with ocrMode="status", then reprocess via fileId with ocrMode="auto" (0 extra downloads!)
    const statusSub = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: {
          assignmentId: 125208,
          groupId: 68884,
          extractFiles: true,
          ocrMode: 'status',
        },
      })
    );
    const scannedFileDiag = statusSub.files[0];
    expect(scannedFileDiag.extractionStatus).toBe('downloaded_needs_ocr');
    expect(scannedFileDiag.ocrStatus).toBe('diagnostic_only');
    expect(scannedFileDiag.needsOcr).toBe(true);
    expect(scannedFileDiag.unprocessedPages).toEqual([
      { pageNumber: 1, reason: 'ocr_mode_status' },
    ]);
    expect(scannedFileDiag.fileId).toBeTruthy();
    expect(scannedFileDiag.downloadUrl).toBeTruthy();

    // Reprocess stored file using fileId (without fileurl!) and ocrMode="auto"
    const ocrByFileId = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileId: scannedFileDiag.fileId,
          ocrMode: 'auto',
          ocrLanguages: ['eng', 'por'],
        },
      })
    );
    expect(ocrByFileId.reusedCachedFile).toBe(true);
    expect(ocrByFileId.metrics.fileDownloads).toBe(0);
    expect(ocrByFileId.downloadStatus).toBe('downloaded');
    expect(ocrByFileId.extractionStatus).toBe('downloaded_with_text');
    expect(ocrByFileId.extractionMethod).toBe('ocr_pdf');
    expect(ocrByFileId.ocrStatus).toBe('completed');
    expect(ocrByFileId.ocrProcessedPageNumbers).toEqual([1]);
    expect(ocrByFileId.ocrConfidence).toBeGreaterThan(50);
    expect(ocrByFileId.extractedText.toUpperCase()).toContain('UFSC');
    expect(ocrByFileId.extractedText.toUpperCase()).toContain('2026');
    expect(ocrByFileId.extractedText.toUpperCase()).toContain('TEST');

    // Verify structured visual blocks & spatial regions (top-left vs bottom-right/middle-right)
    expect(ocrByFileId.pages).toHaveLength(1);
    const p1Blocks = ocrByFileId.pages[0].blocks;
    expect(p1Blocks.length).toBeGreaterThanOrEqual(1);
    expect(p1Blocks[0].bbox.unit).toBe('px');
    expect(p1Blocks[0].bbox.pageWidth).toBeGreaterThan(100);
    expect(p1Blocks[0].readingOrder).toBe(1);
    const topBlock = p1Blocks.find((b: any) => b.text.toUpperCase().includes('UFSC'));
    const bottomBlock = p1Blocks.find((b: any) => b.text.toUpperCase().includes('TEST'));
    expect(topBlock).toBeTruthy();
    expect(bottomBlock).toBeTruthy();
    expect(topBlock.bbox.normY).toBeLessThan(0.35);
    expect(bottomBlock.bbox.normY).toBeGreaterThan(0.65);

    // 5.2 Mixed 3-page PDF (Group 67336): Page 1 native, Page 2 OCR, Page 3 native — ZERO duplication!
    const mixedSub = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: {
          assignmentId: 125208,
          groupId: 67336,
          extractFiles: true,
          ocrMode: 'auto',
        },
      })
    );
    const mixedFile = mixedSub.files[0];
    expect(mixedFile.extractionStatus).toBe('downloaded_with_text');
    expect(mixedFile.extractionMethod).toBe('hybrid_pdf_ocr');
    expect(mixedFile.pageCount).toBe(3);
    expect(mixedFile.nativeTextPageNumbers).toEqual([1, 3]);
    expect(mixedFile.ocrProcessedPageNumbers).toEqual([2]);
    expect(mixedFile.pages[0].pageNumber).toBe(1);
    expect(mixedFile.pages[0].textSource).toBe('native');
    expect(mixedFile.pages[1].pageNumber).toBe(2);
    expect(mixedFile.pages[1].textSource).toBe('ocr');
    expect(mixedFile.pages[1].text.toUpperCase()).toContain('OCR');
    expect(mixedFile.pages[2].pageNumber).toBe(3);
    expect(mixedFile.pages[2].textSource).toBe('native');
    // Verify Page 1 native text appears exactly once (no duplication)
    const occurrencesPage1 = mixedFile.extractedText.split('Especificacao Arquitetural Nativa').length - 1;
    expect(occurrencesPage1).toBe(1);

    // 5.3 Resource limit: maxOcrPages=1 on 3-page scanned PDF marks pages 2 & 3 as unprocessedPages
    const cappedOcr = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/999/Tres_Paginas_Scanned.pdf`,
          ocrMode: 'auto',
          maxOcrPages: 1,
        },
      })
    );
    expect(cappedOcr.ocrProcessedPageNumbers).toEqual([1]);
    expect(cappedOcr.unprocessedPages).toEqual([
      { pageNumber: 2, reason: 'max_ocr_pages_limit' },
      { pageNumber: 3, reason: 'max_ocr_pages_limit' },
    ]);

    // 5.4 Blank / illegible image PDF -> downloaded_ocr_no_text (original PDF still preserved!)
    const blankRes = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/999/Blank_Illegible.pdf`,
          ocrMode: 'auto',
        },
      })
    );
    expect(blankRes.downloadStatus).toBe('downloaded');
    expect(blankRes.extractionStatus).toBe('downloaded_ocr_no_text');
    expect(blankRes.downloadUrl).toBeTruthy();

    // 5.5 Corrupted PDF & Password-protected PDF
    const corruptRes = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/999/Corrupted.pdf`,
          ocrMode: 'auto',
        },
      })
    );
    expect(corruptRes.downloadStatus).toBe('downloaded');
    expect(corruptRes.extractionStatus).toBe('downloaded_parser_error');
    expect(corruptRes.parserErrorCode).toBe('pdf_corrupted_or_unreadable');

    const protectedRes = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/999/Protected_Encrypted.pdf`,
          ocrMode: 'auto',
        },
      })
    );
    expect(protectedRes.downloadStatus).toBe('downloaded');
    expect(protectedRes.extractionStatus).toBe('downloaded_parser_error');
    expect(protectedRes.parserErrorCode).toBe('pdf_password_protected');

    // 5.6 OCR timeout / partial failure NEVER claims document is empty + cleans up ocr_job_* temp dirs!
    // Force a fresh uncached run with ocrMode="force" and minimal ocrTimeoutMs=1 on 3-page scanned PDF
    const timeoutOcr = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/999/Tres_Paginas_Scanned.pdf`,
          ocrMode: 'force',
          ocrTimeoutMs: 500,
          maxOcrPages: 3,
        },
      })
    );
    // Note: settings.timeoutMs is clamped to >=500ms; if fast machine finishes or times out mid-way, check temp dir cleanup!
    expect(timeoutOcr.downloadStatus).toBe('downloaded');
    const filesTempDir = path.join(tempRootDir, 'files');
    const leftoverOcrDirs = fs
      .readdirSync(filesTempDir)
      .filter((entry) => entry.startsWith('ocr_job_'));
    expect(leftoverOcrDirs).toEqual([]);
  });

  it(
    '6. Timeout determinístico de OCR (com binário lento simulado) reporta downloaded_ocr_error + failedPages sem tratar falha como PDF vazio e limpa diretório temporário',
    async () => {
      // Create a tiny slow-tesseract wrapper script: replies instantly to probes (--version, --list-langs),
      // and executes exec sleep 2 only on actual OCR page processing
      const slowBinPath = path.join(tempRootDir, 'slow-tesseract.sh');
      fs.writeFileSync(
        slowBinPath,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tesseract 5.3.0"; exit 0; fi\nif [ "$1" = "--list-langs" ]; then echo "List of available languages"; echo "eng"; echo "por"; exit 0; fi\nexec sleep 2\n',
        { mode: 0o700 }
      );

    const slowApp = createMoodleHttpServer({
      config: {
        siteUrl: mockMoodleBaseUrl,
        restEndpoint: `${mockMoodleBaseUrl}/webservice/rest/server.php`,
        token: SECRET_MOODLE_TOKEN,
        tempDir: path.join(tempRootDir, 'slow-files'),
        ocrEnabled: true,
        ocrTimeoutMs: 600,
        ocrTesseractBin: slowBinPath,
      },
      authToken: MCP_BEARER_TOKEN,
    });
    await new Promise<void>((resolve) => slowApp.httpServer.listen(0, '127.0.0.1', resolve));
    const slowAddr = slowApp.httpServer.address() as { port: number };
    const slowClient = new Client({ name: 'slow-ocr-test-client', version: '1.2.0' });
    await slowClient.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${slowAddr.port}/${MCP_BEARER_TOKEN}`)
      )
    );

    try {
      const slowRes = parseToolJson(
        await slowClient.callTool({
          name: 'read_moodle_file',
          arguments: {
            fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/999/Blank_Illegible.pdf`,
            ocrMode: 'force',
            ocrTimeoutMs: 550,
          },
        })
      );
      expect(slowRes.downloadStatus).toBe('downloaded');
      // Must NOT report downloaded_ocr_no_text when OCR timed out!
      expect(slowRes.extractionStatus).toBe('downloaded_ocr_error');
      expect(slowRes.ocrStatus).toBe('failed');
      expect(slowRes.failedPages?.[0]?.errorCode).toBe('ocr_timeout');
      expect(slowRes.downloadUrl).toBeTruthy();

      const slowFilesDir = path.join(tempRootDir, 'slow-files');
      const leftover = fs
        .readdirSync(slowFilesDir)
        .filter((name) => name.startsWith('ocr_job_'));
      expect(leftover).toEqual([]);
    } finally {
      await slowClient.close().catch(() => {});
      await slowApp.close().catch(() => {});
    }
  }, 15000);

  it('7. v1.2.1: OCR dinâmico proporcional, fallback de idiomas em timeout e textExtractionComplete com cache e reuso de arquivo', async () => {
    // 7.1 PDF de 2 páginas escaneadas servido pelo mock Moodle em /Two_Page_Scanned.pdf
    const twoPageUrl = `${mockMoodleBaseUrl}/webservice/pluginfile.php/200/assignsubmission_file/submission_files/999/Two_Page_Scanned.pdf`;

    // 7.2 Executa OCR automático no PDF de 2 páginas com idiomas padrão ["eng", "por"]
    const ocrRes = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileurl: twoPageUrl,
          ocrMode: 'auto',
          ocrLanguages: ['eng', 'por'],
        },
      })
    );

    expect(ocrRes.downloadStatus).toBe('downloaded');
    expect(ocrRes.extractionStatus).toBe('downloaded_with_text');
    expect(ocrRes.extractionMethod).toBe('ocr_pdf');
    expect(ocrRes.ocrStatus).toBe('completed');
    expect(ocrRes.textExtractionComplete).toBe(true);
    expect(ocrRes.ocrProcessedPageNumbers).toEqual([1, 2]);
    expect(ocrRes.failedPages).toBeUndefined();
    expect(ocrRes.ocrBudgetMs).toBeGreaterThanOrEqual(120000);
    expect(ocrRes.ocrPageTimeoutMs).toBe(60000);
    expect(ocrRes.pages).toHaveLength(2);
    expect(ocrRes.fileId).toBeTruthy();

    // 7.3 Reuso pelo fileId sem novo download
    const reprocessRes = parseToolJson(
      await mcpClient.callTool({
        name: 'read_moodle_file',
        arguments: {
          fileId: ocrRes.fileId,
          ocrMode: 'auto',
        },
      })
    );
    expect(reprocessRes.reusedCachedFile).toBe(true);
    expect(reprocessRes.textExtractionComplete).toBe(true);
    expect(reprocessRes.ocrStatus).toBe('completed');

    // 7.4 Teste de retry com fallback de idioma em caso de falha de multi-idioma
    const fallbackScriptPath = path.join(tempRootDir, 'fallback-tesseract.sh');
    fs.writeFileSync(
      fallbackScriptPath,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo "tesseract 5.3.0"; exit 0; fi\n' +
        'if [ "$1" = "--list-langs" ]; then echo "List of available languages"; echo "eng"; echo "por"; exit 0; fi\n' +
        // If multi-language "-l eng+por" is requested, fail with timeout simulation or exit 1
        'echo "$@" | grep -q -- "-l eng+por"\n' +
        'if [ $? -eq 0 ]; then\n' +
        '  echo "Simulated multi-language timeout/failure" >&2\n' +
        '  exit 1\n' +
        'fi\n' +
        // If single language fallback is used ("-l eng"), succeed and produce minimal TSV!
        'outbase="$2"\n' +
        'printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n1\\t1\\t0\\t0\\t0\\t0\\t0\\t0\\t800\\t600\\t-1\\t\\n5\\t1\\t1\\t1\\t1\\t1\\t10\\t10\\t100\\t20\\t95\\tFALLBACK_SUCCESS\\n" > "${outbase}.tsv"\n' +
        'exit 0\n',
      { mode: 0o700 }
    );

    const fallbackApp = createMoodleHttpServer({
      config: {
        siteUrl: mockMoodleBaseUrl,
        restEndpoint: `${mockMoodleBaseUrl}/webservice/rest/server.php`,
        token: SECRET_MOODLE_TOKEN,
        tempDir: path.join(tempRootDir, 'fallback-files'),
        ocrEnabled: true,
        ocrTesseractBin: fallbackScriptPath,
      },
      authToken: MCP_BEARER_TOKEN,
    });
    await new Promise<void>((resolve) => fallbackApp.httpServer.listen(0, '127.0.0.1', resolve));
    const fbAddr = fallbackApp.httpServer.address() as { port: number };
    const fbClient = new Client({ name: 'fb-ocr-test-client', version: '1.2.1' });
    await fbClient.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${fbAddr.port}/${MCP_BEARER_TOKEN}`)
      )
    );

    try {
      const fbRes = parseToolJson(
        await fbClient.callTool({
          name: 'read_moodle_file',
          arguments: {
            fileurl: twoPageUrl,
            ocrMode: 'force',
            ocrLanguages: ['eng', 'por'],
          },
        })
      );
      expect(fbRes.downloadStatus).toBe('downloaded');
      expect(fbRes.ocrStatus).toBe('completed');
      expect(fbRes.ocrFallbackUsed).toBe(true);
      expect(fbRes.ocrRetryCount).toBeGreaterThanOrEqual(1);
      expect(fbRes.textExtractionComplete).toBe(true);
      expect(fbRes.extractedText).toContain('FALLBACK_SUCCESS');
    } finally {
      await fbClient.close().catch(() => {});
      await fallbackApp.close().catch(() => {});
    }
  }, 25000);

  it('8. v1.2.1: Avaliações sem alterações retornam prepared_no_changes, readyToCommit: false, ação preserve e commit sem escrita no Moodle', async () => {
    // 8.1 Consulta a avaliação existente dos integrantes do grupo 67199 (TerraLedger) na tarefa 125208
    const initialOverview = parseToolJson(
      await mcpClient.callTool({
        name: 'get_assignment_grading_overview',
        arguments: {
          assignmentId: 125208,
          includeFeedback: true,
          includeMembers: true,
        },
      })
    );
    const terraGroup = initialOverview.groups.find(
      (g: any) => g.assignmentGroupId === 67199
    );
    expect(terraGroup).toBeDefined();
    expect(terraGroup.memberCount).toBe(5);

    // Salva contagem inicial de chamadas a mod_assign_save_grade
    const initialSaveCalls = saveGradeCalls.length;

    // 8.2 Prepara lote com EXATAMENTE o feedback existente e omitindo grade
    const existingFeedback = terraGroup.memberEvaluations[0].gradingFeedbackComment;
    expect(existingFeedback).toBeTruthy();
    const prepNoChangesRes = await mcpClient.callTool({
      name: 'prepare_grading_batch',
      arguments: {
        assignmentId: 125208,
        items: [
          {
            groupId: 67199,
            gradingFeedbackComment: existingFeedback,
          },
        ],
        proposedPublicationState: 'released',
      },
    });
    expect(prepNoChangesRes.isError).toBeFalsy();
    const planNoChanges = parseToolJson(prepNoChangesRes);

    expect(planNoChanges.status).toBe('prepared_no_changes');
    expect(planNoChanges.readyToCommit).toBe(false);
    expect(planNoChanges.readOnlyGuarantee).toBe(true);
    expect(planNoChanges.writesPerformed).toBe(0);

    // Sumário com 0 alterações
    expect(planNoChanges.summary.studentsTargetedCount).toBe(5);
    expect(planNoChanges.summary.studentsWithGradeChanges).toBe(0);
    expect(planNoChanges.summary.studentsWithFeedbackChanges).toBe(0);
    expect(planNoChanges.summary.studentsUnchangedCount).toBe(5);
    expect(planNoChanges.summary.studentsWithEffectiveChangesCount).toBe(0);
    expect(planNoChanges.summary.hasEffectiveChanges).toBe(false);

    // Grupo com preserve em ambas as ações
    expect(planNoChanges.groupPreviews).toHaveLength(1);
    expect(planNoChanges.groupPreviews[0].gradeAction).toBe('preserve');
    expect(planNoChanges.groupPreviews[0].feedbackAction).toBe('preserve');

    // Integrantes individuais todos com preserve
    for (const sc of planNoChanges.studentChanges) {
      expect(sc.gradeAction).toBe('preserve');
      expect(sc.feedbackAction).toBe('preserve');
      expect(sc.gradeChanged).toBe(false);
      expect(sc.feedbackChanged).toBe(false);
      expect(sc.anyEffectiveChange).toBe(false);
    }

    // Garantia de 4 níveis de autorização humana
    expect(planNoChanges.humanApprovalRequired.required).toBe(true);
    expect(planNoChanges.humanApprovalRequired.levels.technicalValidation).toBeTruthy();
    expect(planNoChanges.humanApprovalRequired.levels.planIntegrity).toBeTruthy();
    expect(planNoChanges.humanApprovalRequired.levels.clientConfirmation).toBeTruthy();
    expect(planNoChanges.humanApprovalRequired.levels.humanAuthorization).toBeTruthy();

    // 8.3 Executa commit_grading_batch com este plano sem alterações
    const commitNoChangesRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: planNoChanges.planId,
        approvedPlanHash: planNoChanges.planHash,
        confirmedByReviewer: true,
        operationId: 'op_pd1_terra_no_changes_test',
        publicationState: 'released',
        notificationPolicy: 'suppress',
      },
    });
    expect(commitNoChangesRes.isError).toBeFalsy();
    const commitResult = parseToolJson(commitNoChangesRes);

    // Deve retornar explicitamente unchanged_no_action_required sem escritas no Moodle
    expect(commitResult.status).toBe('unchanged_no_action_required');
    expect(commitResult.writesPerformed).toBe(0);
    expect(commitResult.unchangedStudentsCount).toBe(5);
    expect(commitResult.updatedStudentsCount).toBe(0);
    expect(saveGradeCalls.length).toBe(initialSaveCalls); // Zero chamadas adicionadas a mod_assign_save_grade!

    // 8.4 Re-execução com o mesmo operationId retorna replay idempotente sem novas chamadas
    const replayRes = await mcpClient.callTool({
      name: 'commit_grading_batch',
      arguments: {
        planId: planNoChanges.planId,
        approvedPlanHash: planNoChanges.planHash,
        confirmedByReviewer: true,
        operationId: 'op_pd1_terra_no_changes_test',
        publicationState: 'released',
        notificationPolicy: 'suppress',
      },
    });
    expect(replayRes.isError).toBeFalsy();
    const replayBody = parseToolJson(replayRes);
    expect(replayBody.status).toBe('idempotent_replay');
    expect(saveGradeCalls.length).toBe(initialSaveCalls);
  }, 20000);
});
