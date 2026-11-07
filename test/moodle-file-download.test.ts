import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMoodleHttpServer, type MoodleHttpServerInstance } from '../src/http-app.js';
import type { MoodleConfig } from '../src/moodle.js';

const SECRET_MOODLE_TOKEN = 'SECRET_MOODLE_WSTOKEN_998877665544332211';
const MCP_BEARER_TOKEN = 'MCP_TEST_AUTH_TOKEN_112233445566';

/**
 * Builds a valid PDF 1.4 binary with one or more pages. Each page can have optional native text
 * or an optional raw RGB bitmap image XObject (for genuine image-only PDFs with zero text layer).
 */
function buildTestPdf(
  pages: Array<{
    text?: string;
    bitmapBanner?: boolean;
  }>
): Buffer {
  const objects: Buffer[] = [];
  const addObj = (body: string | Buffer): number => {
    const buf = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    objects.push(buf);
    return objects.length; // 1-based object number
  };

  const fontObjId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // Tiny 5x7 pixel font for rendering "UFSC OCR 2026" purely as a raster image (no PDF text layer)
  const glyphs: Record<string, string[]> = {
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  };

  function buildBannerRgbImageObject(label: string): { id: number; width: number; height: number } {
    const scale = 6;
    const margin = 36;
    const charW = 7 * scale;
    const width = margin * 2 + label.length * charW;
    const height = margin * 2 + 7 * scale;
    const rgb = Buffer.alloc(width * height * 3, 255); // white background

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
  objects.push(Buffer.alloc(0)); // reserve slot for /Pages
  const pagesTreeObjId = pagesTreePlaceholderIdx + 1;

  for (const spec of pages) {
    let xObjectDict = '';
    const streamOps: string[] = [];

    if (spec.bitmapBanner) {
      const img = buildBannerRgbImageObject('OCR TEST 2026');
      xObjectDict = `/XObject << /Im1 ${img.id} 0 R >>`;
      const ptW = Math.round(img.width * 0.6);
      const ptH = Math.round(img.height * 0.6);
      streamOps.push(`q ${ptW} 0 0 ${ptH} 72 620 cm /Im1 Do Q`);
    }

    if (spec.text) {
      const escaped = spec.text
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
      streamOps.push(`BT /F1 14 Tf 72 720 Td (${escaped}) Tj ET`);
    }

    const contentStream = streamOps.join('\n');
    const contentObjId = addObj(
      `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`
    );

    const pageObjId = addObj(
      `<< /Type /Page /Parent ${pagesTreeObjId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjId} 0 R >> ${xObjectDict} >> /Contents ${contentObjId} 0 R >>`
    );
    pageObjIds.push(pageObjId);
  }

  objects[pagesTreePlaceholderIdx] = Buffer.from(
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>`,
    'latin1'
  );

  const catalogObjId = addObj(`<< /Type /Catalog /Pages ${pagesTreeObjId} 0 R >>`);

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
  const trailer =
    xrefLines.join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, 'latin1'));

  return Buffer.concat(chunks);
}

function sha256Hex(buf: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseToolJson(result: any): any {
  const firstText = result?.content?.find((c: any) => c.type === 'text')?.text;
  expect(firstText).toBeTruthy();
  // Ensure secret Moodle token NEVER leaks into any tool response
  expect(firstText).not.toContain(SECRET_MOODLE_TOKEN);
  return JSON.parse(firstText);
}

describe('UFSC Moodle MCP v1.1.0 — Download Original, OCR/Renderização, Grupos e Segurança', () => {
  let mockMoodleServer: http.Server;
  let mockMoodleBaseUrl: string;
  let externalEvilServer: http.Server;
  let externalEvilUrl: string;
  let externalServerHitCount = 0;

  let mcpApp: MoodleHttpServerInstance;
  let mcpBaseUrl: string;
  let mcpClient: Client;
  let serverTempDir: string;
  let agentWorkspaceDir: string;

  // Test fixtures
  const nativePdfBytes = buildTestPdf([
    {
      text: 'Trabalho de Seguranca em Computacao INE5429 UFSC Semestre 20262 Analise Completa',
    },
  ]);
  const imageOnlyPdfBytes = buildTestPdf([{ bitmapBanner: true }]);
  const multiPagePdfBytes = buildTestPdf([
    { text: 'Pagina 1 Introducao e Modelo de Ameacas do Sistema Distribuido' },
    { bitmapBanner: true }, // Page 2 has no native text layer (diagram/image only)
    { text: 'Pagina 3 Conclusoes e Mitigacoes Criptograficas Propostas' },
  ]);
  const groupSubmissionPdfBytes = buildTestPdf([
    {
      text: 'Entrega em Grupo Equipe Blockchain PD1 Business Model Canvas UFSC',
    },
  ]);
  const corruptedPdfWithHeader = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<<CORRUPTED_UNPARSEABLE_STREAM_WITHOUT_XREF_OR_EOF',
    'latin1'
  );

  beforeAll(async () => {
    serverTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-mcp-srv-test-'));
    agentWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-env-test-'));

    // 1. Spin up external "evil" server to verify zero SSRF & zero credential forwarding on redirects
    externalEvilServer = http.createServer((_req, res) => {
      externalServerHitCount++;
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(nativePdfBytes);
    });
    await new Promise<void>((resolve) => externalEvilServer.listen(0, '127.0.0.1', resolve));
    const evilAddr = externalEvilServer.address() as { port: number };
    externalEvilUrl = `http://127.0.0.1:${evilAddr.port}`;

    // 2. Spin up Mock Moodle Server (REST Web Services + pluginfile endpoints)
    mockMoodleServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host}`);

      // Moodle REST Web Service endpoint
      if (reqUrl.pathname === '/webservice/rest/server.php' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const wstoken = params.get('wstoken');
        const wsfunction = params.get('wsfunction');

        if (wstoken !== SECRET_MOODLE_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Token inválido' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (wsfunction === 'core_webservice_get_site_info') {
          res.end(
            JSON.stringify({
              sitename: 'Moodle UFSC Teste',
              username: 'professor.exemplo',
              firstname: 'Professor',
              lastname: 'Exemplo',
              fullname: 'Prof. Exemplo Moodle',
              userid: 999,
              siteurl: mockMoodleBaseUrl,
              release: '4.5',
            })
          );
          return;
        }

        if (wsfunction === 'core_enrol_get_users_courses') {
          res.end(
            JSON.stringify([
              {
                id: 49476,
                shortname: 'INE5458-20262',
                fullname: 'INE5458 - Tópicos Especiais em Aplicações (20262)',
                visible: 1,
                startdate: 1754000000,
              },
            ])
          );
          return;
        }

        if (wsfunction === 'core_enrol_get_enrolled_users') {
          res.end(
            JSON.stringify([
              {
                id: 1001,
                fullname: 'Alice Silva',
                email: 'alice@grad.ufsc.br',
                username: 'alice.silva',
                roles: [{ shortname: 'student' }],
                groups: [
                  { id: 50001, name: 'Turma 08208' },
                  { id: 67772, name: 'Grupo 04 - Blockchain' },
                ],
              },
              {
                id: 1002,
                fullname: 'Bruno Souza',
                email: 'bruno@grad.ufsc.br',
                username: 'bruno.souza',
                roles: [{ shortname: 'student' }],
                groups: [{ id: 67772, name: 'Grupo 04 - Blockchain' }],
              },
              {
                id: 1003,
                fullname: 'Carla Individual',
                email: 'carla@grad.ufsc.br',
                username: 'carla.ind',
                roles: [{ shortname: 'student' }],
                groups: [],
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
                  fullname: 'INE5458 - Tópicos Especiais em Aplicações (20262)',
                  assignments: [
                    {
                      id: 125208,
                      cmid: 5501,
                      course: 49476,
                      name: 'Project Specification (PD1 - Em Grupo)',
                      grade: 10,
                      teamsubmission: 1,
                      duedate: 1760000000,
                      intro: '<p>Entregue o PDF do Canvas em grupo.</p>',
                      introattachments: [
                        {
                          filename: 'Enunciado PD1.pdf',
                          filesize: nativePdfBytes.length,
                          mimetype: 'application/pdf',
                          fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/99/mod_assign/introattachment/0/Enunciado%20PD1.pdf?token=${SECRET_MOODLE_TOKEN}`,
                        },
                      ],
                    },
                    {
                      id: 125463,
                      cmid: 5502,
                      course: 49476,
                      name: 'Análise de Segurança (Individual)',
                      grade: 10,
                      teamsubmission: 0,
                      duedate: 1760500000,
                      intro: '<p>Entrega individual.</p>',
                      introattachments: [],
                    },
                  ],
                },
              ],
            })
          );
          return;
        }

        if (wsfunction === 'mod_assign_get_grades') {
          res.end(
            JSON.stringify({
              assignments: [
                {
                  assignmentid: 125208,
                  grades: [
                    { userid: 1001, grade: '9.50000', timemodified: 1760100000 },
                    { userid: 1002, grade: '9.50000', timemodified: 1760100000 },
                  ],
                },
              ],
            })
          );
          return;
        }

        if (wsfunction === 'mod_assign_get_submissions') {
          const requestedAssignId = Number(params.get('assignmentids[0]'));
          if (requestedAssignId === 125208) {
            res.end(
              JSON.stringify({
                assignments: [
                  {
                    assignmentid: 125208,
                    submissions: [
                      // Individual member record with NO files (classic Moodle behavior on team assignments!)
                      {
                        id: 9001,
                        userid: 1001,
                        groupid: 0,
                        status: 'new',
                        gradingstatus: 'graded',
                        timemodified: 1760000100,
                        plugins: [
                          { type: 'file', fileareas: [{ area: 'submission_files', files: [] }] },
                        ],
                      },
                      // Collective group submission record with userid = 0 and groupid = 67772
                      {
                        id: 9000,
                        userid: 0,
                        groupid: 67772,
                        status: 'submitted',
                        gradingstatus: 'notgraded',
                        timemodified: 1760050000,
                        plugins: [
                          {
                            type: 'file',
                            fileareas: [
                              {
                                area: 'submission_files',
                                files: [
                                  {
                                    filename: 'Entrega Grupo 04 - Blockchain.pdf',
                                    filesize: groupSubmissionPdfBytes.length,
                                    mimetype: 'application/pdf',
                                    timemodified: 1760050000,
                                    fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/101/assignsubmission_file/submission_files/9000/Entrega%20Grupo%2004%20-%20Blockchain.pdf`,
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

          // Assignment 125463: Individual submissions (native PDF, image-only PDF, multi-page PDF, accented filename)
          res.end(
            JSON.stringify({
              assignments: [
                {
                  assignmentid: 125463,
                  submissions: [
                    {
                      id: 9101,
                      userid: 1003,
                      groupid: 0,
                      status: 'submitted',
                      gradingstatus: 'notgraded',
                      timemodified: 1760060000,
                      plugins: [
                        {
                          type: 'file',
                          fileareas: [
                            {
                              area: 'submission_files',
                              files: [
                                {
                                  filename: 'relatorio_nativo.pdf',
                                  filesize: nativePdfBytes.length,
                                  mimetype: 'application/pdf',
                                  timemodified: 1760060000,
                                  fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/9101/relatorio_nativo.pdf`,
                                },
                                {
                                  filename: 'trabalho_escaneado_imagens.pdf',
                                  filesize: imageOnlyPdfBytes.length,
                                  mimetype: 'application/pdf',
                                  timemodified: 1760060000,
                                  fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/9101/trabalho_escaneado_imagens.pdf`,
                                },
                                {
                                  filename: 'artigo_3_paginas.pdf',
                                  filesize: multiPagePdfBytes.length,
                                  mimetype: 'application/pdf',
                                  timemodified: 1760060000,
                                  fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/9101/artigo_3_paginas.pdf`,
                                },
                                {
                                  // Decomposed NFD accents + spaces (exact pattern seen in macOS/Moodle UFSC uploads)
                                  filename: 'Avaliac\u0327a\u0303o Final - Joa\u0303o & Maria (Sa\u0303o Jose\u0301).pdf',
                                  filesize: nativePdfBytes.length,
                                  mimetype: 'application/pdf',
                                  timemodified: 1760060000,
                                  fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/9101/Avaliac%CC%A7a%CC%83o%20Final%20-%20Joa%CC%83o%20%26%20Maria%20%28Sa%CC%83o%20Jose%CC%81%29.pdf`,
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

        if (wsfunction === 'mod_assign_get_submission_status') {
          const assignid = Number(params.get('assignid'));
          const userid = Number(params.get('userid'));
          if (assignid === 125208 && (userid === 1001 || userid === 1002)) {
            // Exact real Moodle structure: `submission` is truthy with empty files[], while `teamsubmission` has the PDF!
            res.end(
              JSON.stringify({
                lastattempt: {
                  gradingstatus: 'graded',
                  submissiongroup: { id: 67772, name: 'Grupo 04 - Blockchain' },
                  submission: {
                    id: 9001,
                    userid,
                    groupid: 0,
                    status: 'new',
                    timemodified: 1760000100,
                    plugins: [
                      { type: 'file', fileareas: [{ area: 'submission_files', files: [] }] },
                    ],
                  },
                  teamsubmission: {
                    id: 9000,
                    userid: 0,
                    groupid: 67772,
                    status: 'submitted',
                    timemodified: 1760050000,
                    plugins: [
                      {
                        type: 'file',
                        fileareas: [
                          {
                            area: 'submission_files',
                            files: [
                              {
                                filename: 'Entrega Grupo 04 - Blockchain.pdf',
                                filesize: groupSubmissionPdfBytes.length,
                                mimetype: 'application/pdf',
                                timemodified: 1760050000,
                                fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/101/assignsubmission_file/submission_files/9000/Entrega%20Grupo%2004%20-%20Blockchain.pdf`,
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
                feedback: {
                  grade: { grade: '9.50000' },
                  gradefordisplay: '9,50 / 10,00',
                  gradeddate: 1760100000,
                  plugins: [
                    {
                      type: 'comments',
                      editorfields: [{ text: '<p>Excelente modelagem do grupo!</p>' }],
                    },
                  ],
                },
              })
            );
            return;
          }
          res.end(JSON.stringify({ exception: 'dml_missing_record_exception', errorcode: 'invalidrecord', message: 'Not found' }));
          return;
        }

        res.end(JSON.stringify({}));
        return;
      }

      // Moodle File Delivery Endpoint: /webservice/pluginfile.php/...
      if (reqUrl.pathname.startsWith('/webservice/pluginfile.php/')) {
        const token = reqUrl.searchParams.get('token');
        if (token !== SECRET_MOODLE_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Token inválido', errorcode: 'invalidtoken' }));
          return;
        }

        const decodedPath = decodeURIComponent(reqUrl.pathname).normalize('NFC');

        if (decodedPath.endsWith('/relatorio_nativo.pdf') || decodedPath.endsWith('/Enunciado PD1.pdf')) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(nativePdfBytes.length),
          });
          res.end(nativePdfBytes);
          return;
        }

        if (decodedPath.endsWith('/trabalho_escaneado_imagens.pdf')) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(imageOnlyPdfBytes.length),
          });
          res.end(imageOnlyPdfBytes);
          return;
        }

        if (decodedPath.endsWith('/artigo_3_paginas.pdf')) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(multiPagePdfBytes.length),
          });
          res.end(multiPagePdfBytes);
          return;
        }

        if (decodedPath.endsWith('/Entrega Grupo 04 - Blockchain.pdf')) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(groupSubmissionPdfBytes.length),
          });
          res.end(groupSubmissionPdfBytes);
          return;
        }

        if (decodedPath.includes('Avaliação Final - João & Maria (São José).pdf')) {
          // Simulate Moodle PHP sending raw UTF-8 bytes in Content-Disposition filename="..."
          const rawUtf8AsLatin1 = Buffer.from(
            'Avaliac\u0327a\u0303o Final - Joa\u0303o & Maria (Sa\u0303o Jose\u0301).pdf',
            'utf8'
          ).toString('latin1');
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${rawUtf8AsLatin1}"`,
            'Content-Length': String(nativePdfBytes.length),
          });
          res.end(nativePdfBytes);
          return;
        }

        if (decodedPath.endsWith('/denied_403.pdf')) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }

        if (decodedPath.endsWith('/denied_moodle_json.pdf')) {
          // Moodle commonly returns HTTP 200 with JSON error payload when capability is missing!
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: `Desculpe, mas você não tem permissão para ver este arquivo (token=${SECRET_MOODLE_TOKEN})`,
              errorcode: 'nopermissions',
            })
          );
          return;
        }

        if (decodedPath.endsWith('/expired_session_json.pdf')) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: `Sessão expirada para ${SECRET_MOODLE_TOKEN}`,
              errorcode: 'requireloginerror',
            })
          );
          return;
        }

        if (decodedPath.endsWith('/html_disguised_as_pdf.pdf')) {
          const fakeHtml =
            '<!DOCTYPE html><html><head><title>Login CAS UFSC</title></head><body><form action="https://sistemas.ufsc.br/login">Faça login</form></body></html>';
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(fakeHtml);
          return;
        }

        if (decodedPath.endsWith('/redirect_to_login.pdf')) {
          res.writeHead(302, { Location: `${mockMoodleBaseUrl}/login/index.php` });
          res.end();
          return;
        }

        if (decodedPath.endsWith('/redirect_external_evil.pdf')) {
          res.writeHead(302, { Location: `${externalEvilUrl}/steal.pdf` });
          res.end();
          return;
        }

        if (decodedPath.endsWith('/corrupted_parser.pdf')) {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(corruptedPdfWithHeader);
          return;
        }

        if (decodedPath.endsWith('/slow_timeout.pdf')) {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'application/pdf' });
              res.end(nativePdfBytes);
            }
          }, 2500);
          return;
        }

        if (decodedPath.endsWith('/too_large_header.pdf')) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(50 * 1024 * 1024),
          });
          res.end(Buffer.alloc(1024));
          return;
        }

        if (decodedPath.endsWith('/too_large_stream.pdf')) {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.write(Buffer.from('%PDF-1.4\n', 'latin1'));
          res.write(Buffer.alloc(16 * 1024, 0x41));
          res.end();
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => mockMoodleServer.listen(0, '127.0.0.1', resolve));
    const moodleAddr = mockMoodleServer.address() as { port: number };
    mockMoodleBaseUrl = `http://127.0.0.1:${moodleAddr.port}`;

    // 3. Spin up the real UFSC Moodle MCP HTTP Server
    const testConfig: MoodleConfig = {
      siteUrl: mockMoodleBaseUrl,
      restEndpoint: `${mockMoodleBaseUrl}/webservice/rest/server.php`,
      token: SECRET_MOODLE_TOKEN,
      tempDir: serverTempDir,
      fileTtlSeconds: 600,
      maxDownloadBytes: 10 * 1024 * 1024,
      downloadTimeoutMs: 10_000,
    };

    mcpApp = createMoodleHttpServer({
      config: testConfig,
      authToken: MCP_BEARER_TOKEN,
    });

    await new Promise<void>((resolve) => mcpApp.httpServer.listen(0, '127.0.0.1', resolve));
    const mcpAddr = mcpApp.httpServer.address() as { port: number };
    mcpBaseUrl = `http://127.0.0.1:${mcpAddr.port}`;

    // 4. Connect a real MCP Client over Streamable HTTP (simulating remote agent environment)
    mcpClient = new Client({ name: 'acceptance-test-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${mcpBaseUrl}/${MCP_BEARER_TOKEN}`)
    );
    await mcpClient.connect(transport);
  });

  afterAll(async () => {
    await mcpClient?.close().catch(() => {});
    await mcpApp?.close().catch(() => {});
    await new Promise<void>((resolve) => mockMoodleServer?.close(() => resolve()));
    await new Promise<void>((resolve) => externalEvilServer?.close(() => resolve()));
    fs.rmSync(serverTempDir, { recursive: true, force: true });
    fs.rmSync(agentWorkspaceDir, { recursive: true, force: true });
  });

  it('Teste 1: PDF com texto nativo — lista entrega, baixa arquivo original no ambiente do agente, confere SHA-256/tamanho e abre localmente', async () => {
    const subsRes = await mcpClient.callTool({
      name: 'get_submissions',
      arguments: { assignmentId: 125463, courseId: 49476 },
    });
    const subsData = parseToolJson(subsRes);
    const carlaSub = subsData.assignments[0].submissions.find((s: any) => s.userid === 1003);
    expect(carlaSub).toBeTruthy();

    const nativeFileRef = carlaSub.files.find((f: any) => f.filename === 'relatorio_nativo.pdf');
    expect(nativeFileRef).toBeTruthy();
    expect(nativeFileRef.fileurl).not.toContain(SECRET_MOODLE_TOKEN);

    // Verify separated read_moodle_file state: downloaded_with_text
    const readRes = await mcpClient.callTool({
      name: 'read_moodle_file',
      arguments: { fileurl: nativeFileRef.fileurl },
    });
    expect(readRes.isError).toBeFalsy();
    const readData = parseToolJson(readRes);
    expect(readData.downloadStatus).toBe('downloaded');
    expect(readData.extractionStatus).toBe('downloaded_with_text');
    expect(readData.extractionMethod).toBe('native_pdf');
    expect(readData.needsOcr).toBe(false);
    expect(readData.extractedText).toContain('Seguranca em Computacao INE5429');

    // Call download_moodle_file
    const dlRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: { fileurl: nativeFileRef.fileurl },
    });
    expect(dlRes.isError).toBeFalsy();
    const dlData = parseToolJson(dlRes);

    expect(dlData.status).toBe('downloaded');
    expect(dlData.mimeType).toBe('application/pdf');
    expect(dlData.sizeBytes).toBe(nativePdfBytes.length);
    expect(dlData.sha256).toBe(sha256Hex(nativePdfBytes));
    expect(dlData.downloadUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/files\/dl_[0-9a-f]{64}\//);
    expect(dlData.downloadUrl).not.toContain(SECRET_MOODLE_TOKEN);
    expect(dlData.downloadUrl).not.toContain(MCP_BEARER_TOKEN);
    expect(dlData.expiresAt).toBeTruthy();

    // Agent fetches the PDF into its own isolated local workspace via HTTP GET (no auth header needed)
    const httpResp = await fetch(dlData.downloadUrl);
    expect(httpResp.status).toBe(200);
    expect(httpResp.headers.get('content-type')).toBe('application/pdf');
    expect(httpResp.headers.get('x-content-sha256')).toBe(dlData.sha256);
    const agentBytes = Buffer.from(await httpResp.arrayBuffer());
    expect(agentBytes.length).toBe(nativePdfBytes.length);
    expect(sha256Hex(agentBytes)).toBe(dlData.sha256);

    const agentPdfPath = path.join(agentWorkspaceDir, dlData.safeFilename);
    fs.writeFileSync(agentPdfPath, agentBytes);

    // Open locally with unpdf in the agent's process
    const { getDocumentProxy } = await import('unpdf');
    const pdfDoc = await getDocumentProxy(new Uint8Array(fs.readFileSync(agentPdfPath)));
    expect(pdfDoc.numPages).toBe(1);
    await pdfDoc.destroy?.();

    // Also verify MCP Resource binary retrieval (`resources/read`)
    const mcpResource = await mcpClient.readResource({ uri: dlData.resourceUri });
    const blobB64 = (mcpResource.contents[0] as any).blob as string;
    const resourceBytes = Buffer.from(blobB64, 'base64');
    expect(resourceBytes.length).toBe(nativePdfBytes.length);
    expect(sha256Hex(resourceBytes)).toBe(dlData.sha256);
  });

  it('Teste 2: PDF composto apenas por imagens — detecta downloaded_needs_ocr, entrega PDF original ao agente e executa renderização + OCR local', async () => {
    const subsRes = await mcpClient.callTool({
      name: 'get_submissions',
      arguments: { assignmentId: 125463, courseId: 49476 },
    });
    const subsData = parseToolJson(subsRes);
    const scannedRef = subsData.assignments[0].submissions[0].files.find(
      (f: any) => f.filename === 'trabalho_escaneado_imagens.pdf'
    );
    expect(scannedRef).toBeTruthy();

    // 1. read_moodle_file must NOT treat image-only PDF as empty/missing or error:
    //    it must report downloaded_needs_ocr + needsOcr=true + downloadUrl!
    const readRes = await mcpClient.callTool({
      name: 'read_moodle_file',
      arguments: { fileurl: scannedRef.fileurl },
    });
    expect(readRes.isError).toBeFalsy();
    const readData = parseToolJson(readRes);
    expect(readData.downloadStatus).toBe('downloaded');
    expect(readData.extractionStatus).toBe('downloaded_needs_ocr');
    expect(readData.needsOcr).toBe(true);
    expect(readData.pageCount).toBe(1);
    expect(readData.emptyPageNumbers).toEqual([1]);
    expect(readData.sha256).toBe(sha256Hex(imageOnlyPdfBytes));
    expect(readData.downloadUrl).toBeTruthy();

    // 2. Call download_moodle_file and materialize in the agent's local workspace
    const dlRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: { fileurl: scannedRef.fileurl },
    });
    const dlData = parseToolJson(dlRes);
    expect(dlData.status).toBe('downloaded');
    expect(dlData.sha256).toBe(sha256Hex(imageOnlyPdfBytes));

    const httpResp = await fetch(dlData.downloadUrl);
    expect(httpResp.status).toBe(200);
    const downloadedBuf = Buffer.from(await httpResp.arrayBuffer());
    expect(downloadedBuf.length).toBe(imageOnlyPdfBytes.length);
    expect(sha256Hex(downloadedBuf)).toBe(dlData.sha256);

    const localPdf = path.join(agentWorkspaceDir, 'scanned_from_moodle.pdf');
    fs.writeFileSync(localPdf, downloadedBuf);

    // 3. Render page 1 with pdftoppm and execute OCR with tesseract in the agent's environment!
    const pngPrefix = path.join(agentWorkspaceDir, 'rendered_page');
    execFileSync('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '1', localPdf, pngPrefix]);
    const renderedPng = `${pngPrefix}-1.png`;
    expect(fs.existsSync(renderedPng)).toBe(true);
    expect(fs.statSync(renderedPng).size).toBeGreaterThan(500);

    const ocrOutput = execFileSync('tesseract', [renderedPng, 'stdout', '--psm', '7'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    expect(ocrOutput.toUpperCase()).toContain('TEST');
    expect(ocrOutput).toContain('2026');
  });

  it('Teste 3: PDF de várias páginas (incluindo página mista sem camada de texto)', async () => {
    const fileUrl = `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/9101/artigo_3_paginas.pdf`;

    const readRes = await mcpClient.callTool({
      name: 'read_moodle_file',
      arguments: { fileurl: fileUrl },
    });
    expect(readRes.isError).toBeFalsy();
    const readData = parseToolJson(readRes);
    expect(readData.downloadStatus).toBe('downloaded');
    expect(readData.extractionStatus).toBe('downloaded_with_text');
    expect(readData.pageCount).toBe(3);
    expect(readData.pagesWithTextCount).toBe(2);
    expect(readData.emptyPageNumbers).toEqual([2]);
    expect(readData.needsOcr).toBe(true); // Page 2 has an image without native text
    expect(readData.extractedText).toContain('Pagina 1 Introducao');
    expect(readData.extractedText).toContain('Pagina 3 Conclusoes');

    const dlRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: { fileurl: fileUrl },
    });
    const dlData = parseToolJson(dlRes);
    const bytes = Buffer.from(await (await fetch(dlData.downloadUrl)).arrayBuffer());
    expect(bytes.length).toBe(multiPagePdfBytes.length);
    expect(sha256Hex(bytes)).toBe(sha256Hex(multiPagePdfBytes));

    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    expect(pdf.numPages).toBe(3);
    await pdf.destroy?.();
  });

  it('Teste 4: Entrega em grupo (userid=0, groupid=67772) — preserva vínculos, não confunde registro individual vazio com ausência de entrega e deduplica arquivos compartilhados', async () => {
    // 1. Listing all submissions on team assignment (even WITHOUT passing courseId!)
    const allSubsRes = await mcpClient.callTool({
      name: 'get_submissions',
      arguments: { assignmentId: 125208 },
    });
    const allSubsData = parseToolJson(allSubsRes);
    const assignEntry = allSubsData.assignments[0];
    expect(assignEntry.isTeamSubmission).toBe(true);
    expect(assignEntry.submissionCount).toBe(1); // Empty individual row was not duplicated
    expect(assignEntry.uniqueFilesCount).toBe(1);

    const groupSub = assignEntry.submissions[0];
    expect(groupSub.userid).toBe(0);
    expect(groupSub.groupid).toBe(67772);
    expect(groupSub.submissionScope).toBe('group');
    expect(groupSub.grade).toBe('9.50000');
    expect(groupSub.group.name).toBe('Grupo 04 - Blockchain');
    expect(groupSub.group.members).toHaveLength(2);
    expect(groupSub.files).toHaveLength(1);

    // 2. Querying get_submission_content for individual group member Alice (1001)
    //    even though Alice's `lastattempt.submission.files` is []!
    const aliceContentRes = await mcpClient.callTool({
      name: 'get_submission_content',
      arguments: { assignmentId: 125208, studentId: 1001 },
    });
    expect(aliceContentRes.isError).toBeFalsy();
    const aliceData = parseToolJson(aliceContentRes);
    expect(aliceData.isTeamSubmission).toBe(true);
    expect(aliceData.individualHasFiles).toBe(false);
    expect(aliceData.groupHasFiles).toBe(true);
    expect(aliceData.effectiveSubmissionSource).toBe('group_submission');
    expect(aliceData.group.id).toBe(67772);
    expect(aliceData.group.members.map((m: any) => m.id)).toEqual([1001, 1002]);
    expect(aliceData.filesCount).toBe(1); // Deduplicated across teamsubmission & mod_assign_get_submissions!
    expect(aliceData.files[0].source).toBe('group_submission');
    expect(aliceData.files[0].extractedText).toContain('Equipe Blockchain PD1');
    expect(aliceData.files[0].downloadUrl).toBeTruthy();

    // 3. Querying Bruno (1002) and querying directly by groupId (67772 without studentId)
    //    must yield the exact same fileKey for deduplication!
    const brunoData = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, studentId: 1002, extractFiles: false },
      })
    );
    const byGroupData = parseToolJson(
      await mcpClient.callTool({
        name: 'get_submission_content',
        arguments: { assignmentId: 125208, groupId: 67772, extractFiles: false },
      })
    );
    expect(brunoData.files[0].fileKey).toBe(aliceData.files[0].fileKey);
    expect(byGroupData.files[0].fileKey).toBe(aliceData.files[0].fileKey);

    // 4. Download the group file via download_moodle_file and verify SHA-256
    const dlGroup = parseToolJson(
      await mcpClient.callTool({
        name: 'download_moodle_file',
        arguments: { fileurl: groupSub.files[0].fileurl },
      })
    );
    const groupBytes = Buffer.from(await (await fetch(dlGroup.downloadUrl)).arrayBuffer());
    expect(sha256Hex(groupBytes)).toBe(sha256Hex(groupSubmissionPdfBytes));
  });

  it('Teste 5: Nome de arquivo com espaços, acentos (NFD -> NFC) e proteção contra path traversal', async () => {
    const accentedUrl = `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/9101/Avaliac%CC%A7a%CC%83o%20Final%20-%20Joa%CC%83o%20%26%20Maria%20%28Sa%CC%83o%20Jose%CC%81%29.pdf`;

    const dlRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: { fileurl: accentedUrl },
    });
    expect(dlRes.isError).toBeFalsy();
    const dlData = parseToolJson(dlRes);
    expect(dlData.originalFilename).toBe('Avaliação Final - João & Maria (São José).pdf');

    const resp = await fetch(dlData.downloadUrl);
    expect(resp.status).toBe(200);
    const contentDisposition = resp.headers.get('content-disposition') || '';
    expect(contentDisposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(contentDisposition.split("UTF-8''")[1])).toBe(
      'Avaliação Final - João & Maria (São José).pdf'
    );
    const bytes = Buffer.from(await resp.arrayBuffer());
    expect(sha256Hex(bytes)).toBe(sha256Hex(nativePdfBytes));

    // Path traversal attempt via custom filename parameter
    const traversalRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: accentedUrl,
        filename: '../../../../etc/shadow/../../malicioso.pdf',
      },
    });
    const traversalData = parseToolJson(traversalRes);
    expect(traversalData.safeFilename).toBe('malicioso.pdf');
    expect(traversalData.originalFilename).toBe('malicioso.pdf');
    expect(traversalData.safeFilename).not.toContain('..');
    expect(traversalData.safeFilename).not.toContain('/');
  });

  it('Teste 6: Acesso negado (HTTP 403 / JSON nopermissions) e sessão inválida sem expor wstoken', async () => {
    // Case A: HTTP 403
    const res403 = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/denied_403.pdf`,
      },
    });
    expect(res403.isError).toBe(true);
    const data403 = parseToolJson(res403);
    expect(data403.status).toBe('failed');
    expect(data403.errorCode).toBe('access_denied');

    // Case B: Moodle HTTP 200 JSON error (nopermissions) containing the secret token in upstream message
    const resNoPerm = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/denied_moodle_json.pdf`,
      },
    });
    expect(resNoPerm.isError).toBe(true);
    const dataNoPerm = parseToolJson(resNoPerm);
    expect(dataNoPerm.errorCode).toBe('access_denied');
    expect(dataNoPerm.errorMessage).toContain('[REDACTED]');
    expect(dataNoPerm.errorMessage).not.toContain(SECRET_MOODLE_TOKEN);

    // Case C: Expired session / redirect to /login/index.php
    const resLoginRedirect = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/redirect_to_login.pdf`,
      },
    });
    expect(resLoginRedirect.isError).toBe(true);
    expect(parseToolJson(resLoginRedirect).errorCode).toBe('auth_failed');

    const resSessionJson = await mcpClient.callTool({
      name: 'read_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/expired_session_json.pdf`,
      },
    });
    expect(resSessionJson.isError).toBe(true);
    const sessionJsonData = parseToolJson(resSessionJson);
    expect(sessionJsonData.downloadStatus).toBe('failed');
    expect(sessionJsonData.extractionStatus).toBe('not_attempted');
    expect(sessionJsonData.errorCode).toBe('auth_failed');
  });

  it('Teste 7: Página HTML de login/erro disfarçada de PDF, bloqueio de SSRF/redirecionamento externo e separação de erro de parser', async () => {
    // 1. HTML login page returned with HTTP 200 + Content-Type: application/pdf
    const htmlDisguisedRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/html_disguised_as_pdf.pdf`,
      },
    });
    expect(htmlDisguisedRes.isError).toBe(true);
    expect(parseToolJson(htmlDisguisedRes).errorCode).toBe('html_error_page');

    // 2. Arbitrary external URL (SSRF prevention)
    const ssrfRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${externalEvilUrl}/webservice/pluginfile.php/1/secret.pdf`,
      },
    });
    expect(ssrfRes.isError).toBe(true);
    expect(parseToolJson(ssrfRes).errorCode).toBe('invalid_origin');
    expect(externalServerHitCount).toBe(0);

    // 3. Unauthorized route on the Moodle host itself
    const badRouteRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/admin/settings.php`,
      },
    });
    expect(badRouteRes.isError).toBe(true);
    expect(parseToolJson(badRouteRes).errorCode).toBe('unauthorized_route');

    // 4. Redirect from Moodle to external origin (must block and never forward token!)
    const extRedirectRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/redirect_external_evil.pdf`,
      },
    });
    expect(extRedirectRes.isError).toBe(true);
    expect(parseToolJson(extRedirectRes).errorCode).toBe('redirect_blocked');
    expect(externalServerHitCount).toBe(0);

    // 5. PDF with valid %PDF- header but broken xref/stream: download succeeds AND file remains accessible even when parser fails!
    const brokenPdfRes = await mcpClient.callTool({
      name: 'read_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/corrupted_parser.pdf`,
      },
    });
    expect(brokenPdfRes.isError).toBeFalsy();
    const brokenData = parseToolJson(brokenPdfRes);
    expect(brokenData.downloadStatus).toBe('downloaded');
    expect(brokenData.extractionStatus).toBe('downloaded_parser_error');
    expect(brokenData.parserError).toBeTruthy();
    expect(brokenData.downloadUrl).toBeTruthy();
    const brokenFetch = await fetch(brokenData.downloadUrl);
    expect(brokenFetch.status).toBe(200);
    expect(sha256Hex(Buffer.from(await brokenFetch.arrayBuffer()))).toBe(
      sha256Hex(corruptedPdfWithHeader)
    );
  });

  it('Teste 8: Timeout, limite de tamanho excedido (Content-Length e streaming) e expiração de arquivos temporários', async () => {
    // 1. Timeout
    const timeoutRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/slow_timeout.pdf`,
        timeoutMs: 1000,
      },
    });
    expect(timeoutRes.isError).toBe(true);
    expect(parseToolJson(timeoutRes).errorCode).toBe('timeout');

    // 2. Max size exceeded via Content-Length header
    const tooLargeHeaderRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/too_large_header.pdf`,
        maxBytes: 4096,
      },
    });
    expect(tooLargeHeaderRes.isError).toBe(true);
    expect(parseToolJson(tooLargeHeaderRes).errorCode).toBe('too_large');

    // 3. Max size exceeded mid-stream (without Content-Length) + verify no leftover .part files
    const tooLargeStreamRes = await mcpClient.callTool({
      name: 'download_moodle_file',
      arguments: {
        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/102/assignsubmission_file/submission_files/1/too_large_stream.pdf`,
        maxBytes: 4096,
      },
    });
    expect(tooLargeStreamRes.isError).toBe(true);
    expect(parseToolJson(tooLargeStreamRes).errorCode).toBe('too_large');
    const leftoverParts = fs.readdirSync(serverTempDir).filter((f) => f.endsWith('.part'));
    expect(leftoverParts).toEqual([]);

    // 4. Invalid/expired capability token returns HTTP 404
    const fakeTokenResp = await fetch(
      `${mcpBaseUrl}/files/dl_${'0'.repeat(64)}/relatorio_nativo.pdf`
    );
    expect(fakeTokenResp.status).toBe(404);
  });
});
