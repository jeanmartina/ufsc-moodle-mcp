import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMoodleHttpServer, type MoodleHttpServerInstance } from '../src/http-app.js';
import type { MoodleConfig } from '../src/moodle.js';
import {
  validatePdfBuffer,
  resolveSourceFile,
  MoodleResourceError,
} from '../src/resource-manager.js';

const SECRET_MOODLE_TOKEN = 'SECRET_TEST_TOKEN_RESOURCE_11223344';
const MCP_BEARER_TOKEN = 'MCP_TEST_BEARER_RESOURCE_55667788';

function createValidPdf(text: string): Buffer {
  const contentStream = `BT /F1 14 Tf 72 720 Td (${text.replace(/[\(\)\\]/g, '\\$&')}) Tj ET`;
  const objects: Buffer[] = [];
  function addObj(s: string | Buffer): number {
    objects.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'));
    return objects.length;
  }

  const fontObjId = addObj(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  );
  const pagesTreeObjId = 2;
  const contentObjId = addObj(
    `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`
  );
  const pageObjId = addObj(
    `<< /Type /Page /Parent ${pagesTreeObjId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`
  );
  // Pages tree
  const pagesTree = Buffer.from(
    `<< /Type /Pages /Kids [${pageObjId} 0 R] /Count 1 >>`,
    'latin1'
  );
  objects.splice(1, 0, pagesTree);

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
  const xrefBuf = Buffer.from(xrefLines.join(''), 'latin1');
  const trailerBuf = Buffer.from(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    'latin1'
  );

  chunks.push(xrefBuf, trailerBuf);
  return Buffer.concat(chunks);
}

describe('UFSC Moodle MCP v1.3.0 — Atualização de Recursos PDF (mod_resource)', () => {
  let serverTempDir: string;
  let auditLogPath: string;
  let mockMoodleServer: http.Server;
  let mockMoodleBaseUrl: string;
  let externalDocServer: http.Server;
  let externalDocBaseUrl: string;
  let mcpApp: MoodleHttpServerInstance;
  let mcpClient: Client;

  // State in Mock Moodle
  let currentTeacherRole = 'editingteacher';
  let currentResourceFile: {
    filename: string;
    buffer: Buffer;
    timemodified: number;
  };
  let uploadCallCount = 0;
  let modeditPostCallCount = 0;

  const initialPdf = createValidPdf('DeFi and On Chain Finance - Slide Version July 2026');
  const updatedPdf = createValidPdf('DeFi and On Chain Finance - Updated Version November 2026');

  beforeAll(async () => {
    serverTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-resource-test-'));
    auditLogPath = path.join(serverTempDir, 'resource-audit.jsonl');

    currentResourceFile = {
      filename: 'INE5458 -  DeFi and On Chain Finance.pdf',
      buffer: initialPdf,
      timemodified: 1720878457,
    };

    // 1. External Server simulating Google Drive export endpoint with 302 redirect
    externalDocServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname === '/export-presentation') {
        // Redirect to /download-pdf-target
        res.writeHead(302, { Location: `${externalDocBaseUrl}/download-pdf-target` });
        res.end();
        return;
      }
      if (url.pathname === '/download-pdf-target') {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': updatedPdf.length,
          'Content-Disposition': 'attachment; filename="INE5458 - DeFi and On Chain Finance.pdf"',
        });
        res.end(updatedPdf);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      externalDocServer.listen(0, '127.0.0.1', () => {
        const addr = externalDocServer.address() as any;
        externalDocBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 2. Mock Moodle Server
    mockMoodleServer = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks);
      const postParams = new URLSearchParams(rawBody.toString('utf-8'));

      // Web service upload endpoint: /webservice/upload.php
      if (parsedUrl.pathname === '/webservice/upload.php') {
        uploadCallCount++;
        const body = rawBody.toString('latin1');
        const filenameMatch = body.match(/filename=["']([^"']+)["']/i);
        const uploadedName = filenameMatch ? filenameMatch[1] : 'uploaded.pdf';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              component: 'user',
              filearea: 'draft',
              itemid: 88776655,
              filename: uploadedName,
              filepath: '/',
              filesize: updatedPdf.length,
              url: `${mockMoodleBaseUrl}/draftfile.php/88776655/${uploadedName}`,
            },
          ])
        );
        return;
      }

      // modedit controller GET: /course/modedit.php?update=1564872
      if (parsedUrl.pathname === '/course/modedit.php' && req.method === 'GET') {
        const updateId = parsedUrl.searchParams.get('update');
        const courseId = parsedUrl.searchParams.get('course') || '49476';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <form id="mform1" class="mform" action="/course/modedit.php" method="post">
              <input type="hidden" name="sesskey" value="MOCK_RESOURCE_SESSKEY_123">
              <input type="hidden" name="course" value="${courseId}">
              <input type="hidden" name="coursemodule" value="${updateId}">
              <input type="hidden" name="update" value="${updateId}">
              <input type="hidden" name="module" value="17">
              <input type="hidden" name="modulename" value="resource">
              <input type="hidden" name="instance" value="84210">
              <input type="hidden" name="name" value="INE5458 -  DeFi and On Chain Finance">
              <input type="hidden" name="files" value="112233">
              <input type="hidden" name="_qf__mod_resource_mod_form" value="1">
              <button type="submit" name="submitbutton">Salvar e voltar ao curso</button>
            </form>
          </body>
          </html>
        `);
        return;
      }

      // modedit controller POST: /course/modedit.php
      if (parsedUrl.pathname === '/course/modedit.php' && req.method === 'POST') {
        modeditPostCallCount++;
        const filesDraft = postParams.get('files');
        if (filesDraft === '88776655') {
          // Updated! Update in-memory file
          currentResourceFile = {
            filename: 'INE5458 -  DeFi and On Chain Finance.pdf',
            buffer: updatedPdf,
            timemodified: Math.floor(Date.now() / 1000),
          };
        }
        // Redirect back to course page
        res.writeHead(303, { Location: `${mockMoodleBaseUrl}/course/view.php?id=49476` });
        res.end();
        return;
      }

      // Serving pluginfile.php
      if (parsedUrl.pathname.startsWith('/webservice/pluginfile.php')) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': currentResourceFile.buffer.length,
          'Last-Modified': new Date(currentResourceFile.timemodified * 1000).toUTCString(),
        });
        res.end(currentResourceFile.buffer);
        return;
      }

      // Mock login for MoodleWebSession
      if (parsedUrl.pathname.startsWith('/login/index.php')) {
        res.writeHead(302, {
          Location: `${mockMoodleBaseUrl}/my/`,
          'Set-Cookie': 'MoodleSession=mock_valid_session_123; Path=/',
        });
        res.end();
        return;
      }

      if (parsedUrl.pathname.startsWith('/my/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body>Dashboard Logged In <span name="sesskey">MOCK_RESOURCE_SESSKEY_123</span></body></html>');
        return;
      }

      // Web service calls: /webservice/rest/server.php
      if (parsedUrl.pathname === '/webservice/rest/server.php') {
        const wsfunction = postParams.get('wsfunction') || parsedUrl.searchParams.get('wsfunction');

        if (wsfunction === 'core_webservice_get_site_info') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              sitename: 'UFSC Moodle Test',
              siteurl: mockMoodleBaseUrl,
              username: 'jeanmartina',
              firstname: 'Jean',
              lastname: 'Martina',
              fullname: 'Jean Everson Martina',
              userid: 9001,
              usercanmanageownfiles: true,
              usermaxuploadfilesize: 52428800,
              version: '2022112805.00',
              release: '4.1.5+ (Build: 20230914)',
              functions: [
                { name: 'core_course_get_contents', version: '2022112805.00' },
                { name: 'core_enrol_get_enrolled_users', version: '2022112805.00' },
              ],
            })
          );
          return;
        }

        if (wsfunction === 'core_enrol_get_enrolled_users') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify([
              {
                id: 9001,
                username: 'jeanmartina',
                fullname: 'Jean Everson Martina',
                roles: [
                  {
                    roleid: 3,
                    name: 'Professor',
                    shortname: currentTeacherRole,
                  },
                ],
              },
            ])
          );
          return;
        }

        if (wsfunction === 'core_course_get_contents') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify([
              {
                id: 101,
                name: 'Semana 1 - Apresentação',
                section: 1,
                visible: 1,
                modules: [
                  {
                    id: 1564872,
                    name: 'INE5458 -  DeFi and On Chain Finance',
                    modname: 'resource',
                    instance: 84210,
                    visible: 1,
                    url: `${mockMoodleBaseUrl}/mod/resource/view.php?id=1564872`,
                    contents: [
                      {
                        type: 'file',
                        filename: currentResourceFile.filename,
                        filepath: '/',
                        filesize: currentResourceFile.buffer.length,
                        fileurl: `${mockMoodleBaseUrl}/webservice/pluginfile.php/1564872/mod_resource/content/0/${encodeURIComponent(
                          currentResourceFile.filename
                        )}`,
                        timecreated: 1720878400,
                        timemodified: currentResourceFile.timemodified,
                        mimetype: 'application/pdf',
                      },
                    ],
                  },
                  {
                    id: 1564899,
                    name: 'Tarefa 1 - Entrega',
                    modname: 'assign',
                    instance: 9911,
                    visible: 1,
                    contents: [],
                  },
                ],
              },
            ])
          );
          return;
        }
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      mockMoodleServer.listen(0, '127.0.0.1', () => {
        const addr = mockMoodleServer.address() as any;
        mockMoodleBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 3. Start MCP Server Instance
    const config: MoodleConfig = {
      siteUrl: mockMoodleBaseUrl,
      restEndpoint: `${mockMoodleBaseUrl}/webservice/rest/server.php`,
      token: SECRET_MOODLE_TOKEN,
      username: 'jeanmartina',
      password: 'test_password',
      mcpAuthToken: MCP_BEARER_TOKEN,
      tempDir: serverTempDir,
      resourceAuditLogPath: auditLogPath,
    };

    mcpApp = createMoodleHttpServer({ config, authToken: MCP_BEARER_TOKEN });
    await new Promise<void>((resolve) => {
      mcpApp.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (mcpApp.httpServer.address() as any).port;
    const mcpUrl = new URL(`http://127.0.0.1:${port}/${MCP_BEARER_TOKEN}`);

    // 4. MCP Client
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    mcpClient = new Client({ name: 'moodle-resource-test-client', version: '1.0.0' });
    await mcpClient.connect(transport);
  });

  afterAll(async () => {
    await mcpClient?.close().catch(() => {});
    await mcpApp?.close().catch(() => {});
    await new Promise<void>((resolve) => externalDocServer?.close(() => resolve()));
    await new Promise<void>((resolve) => mockMoodleServer?.close(() => resolve()));
    fs.rmSync(serverTempDir, { recursive: true, force: true });
  });

  function parseToolJson(result: any): any {
    const text = result?.content?.[0]?.text;
    if (!text) return {};
    return JSON.parse(text);
  }

  describe('1. Validações de integridade e resolução de origem (Unitárias)', () => {
    it('valida PDF íntegro com sucesso e extrai metadados', async () => {
      const res = await validatePdfBuffer(new Uint8Array(initialPdf));
      expect(res.isValid).toBe(true);
      expect(res.pageCount).toBe(1);
      expect(res.isEncrypted).toBe(false);
      expect(res.sizeBytes).toBe(initialPdf.length);
      expect(res.sha256).toBe(crypto.createHash('sha256').update(initialPdf).digest('hex'));
    });

    it('rejeita arquivo não-PDF (ex.: HTML ou texto plano)', async () => {
      const invalidBuf = Buffer.from('<!DOCTYPE html><html><body>Error</body></html>', 'utf-8');
      const res = await validatePdfBuffer(new Uint8Array(invalidBuf));
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('Cabeçalho inválido');
    });

    it('rejeita PDF truncado sem marcador de término %%EOF', async () => {
      const truncatedBuf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1');
      const res = await validatePdfBuffer(new Uint8Array(truncatedBuf));
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('truncado');
    });

    it('rejeita PDF criptografado por senha', async () => {
      const encryptedLike = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Encrypt 2 0 R >>\nendobj\n%%EOF\n',
        'latin1'
      );
      const res = await validatePdfBuffer(new Uint8Array(encryptedLike));
      expect(res.isValid).toBe(false);
      expect(res.isEncrypted).toBe(true);
      expect(res.error).toContain('protegido por senha');
    });

    it('resolve fonte via data URI (data:application/pdf;base64,...)', async () => {
      const dataUri = `data:application/pdf;base64,${initialPdf.toString('base64')}`;
      const resolved = await resolveSourceFile({ sourceFileUri: dataUri });
      expect(resolved.buffer.length).toBe(initialPdf.length);
      expect(resolved.mimeType).toBe('application/pdf');
    });

    it('resolve fonte via sourceBase64 direto', async () => {
      const resolved = await resolveSourceFile({
        sourceBase64: initialPdf.toString('base64'),
        newFilename: 'teste.pdf',
      });
      expect(resolved.buffer.length).toBe(initialPdf.length);
      expect(resolved.filename).toBe('teste.pdf');
    });

    it('resolve arquivo local file://', async () => {
      const tmpFile = path.join(serverTempDir, 'local-doc.pdf');
      fs.writeFileSync(tmpFile, initialPdf);
      const resolved = await resolveSourceFile({ sourceFileUri: `file://${tmpFile}` });
      expect(resolved.buffer.length).toBe(initialPdf.length);
      expect(resolved.filename).toBe('local-doc.pdf');
    });

    it('resolve URL HTTP remota com redirecionamento (simulação Google Drive)', async () => {
      const resolved = await resolveSourceFile({
        sourceFileUri: `${externalDocBaseUrl}/export-presentation`,
      });
      expect(resolved.buffer.length).toBe(updatedPdf.length);
      expect(resolved.filename).toBe('INE5458 - DeFi and On Chain Finance.pdf');
    });
  });

  describe('2. Ferramentas MCP replace_course_resource_file e verify_course_resource_file', () => {
    it('bloqueia operação se usuário não tiver permissão docente de edição', async () => {
      currentTeacherRole = 'student'; // Simulate non-editing role

      const res = await mcpClient.callTool({
        name: 'replace_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564872,
          sourceBase64: updatedPdf.toString('base64'),
        },
      });

      expect(res.isError).toBe(true);
      const payload = parseToolJson(res);
      expect(payload.errorCode).toBe('insufficient_permissions');

      currentTeacherRole = 'editingteacher'; // Restore
    });

    it('rejeita quando módulo do recurso não é encontrado no curso', async () => {
      const res = await mcpClient.callTool({
        name: 'replace_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 999999,
          sourceBase64: updatedPdf.toString('base64'),
        },
      });

      expect(res.isError).toBe(true);
      const payload = parseToolJson(res);
      expect(payload.errorCode).toBe('module_not_found');
    });

    it('rejeita quando módulo encontrado não é do tipo mod_resource (ex.: mod_assign)', async () => {
      const res = await mcpClient.callTool({
        name: 'replace_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564899, // modname: 'assign'
          sourceBase64: updatedPdf.toString('base64'),
        },
      });

      expect(res.isError).toBe(true);
      const payload = parseToolJson(res);
      expect(payload.errorCode).toBe('not_a_resource');
    });

    it('rejeita se expectedCurrentFilename não coincidir com o arquivo real no Moodle', async () => {
      const res = await mcpClient.callTool({
        name: 'replace_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564872,
          expectedCurrentFilename: 'NomeCompletamenteErrado.pdf',
          sourceBase64: updatedPdf.toString('base64'),
        },
      });

      expect(res.isError).toBe(true);
      const payload = parseToolJson(res);
      expect(payload.errorCode).toBe('filename_mismatch');
    });

    it('executa simulação em dryRun=true sem modificar o recurso no Moodle', async () => {
      const beforeUploads = uploadCallCount;
      const beforeModedits = modeditPostCallCount;

      const res = await mcpClient.callTool({
        name: 'replace_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564872,
          expectedCurrentFilename: 'INE5458 -  DeFi and On Chain Finance.pdf',
          sourceFileUri: `${externalDocBaseUrl}/export-presentation`,
          dryRun: true,
        },
      });

      expect(res.isError).toBeFalsy();
      const payload = parseToolJson(res);
      expect(payload.status).toBe('dry_run_success');
      expect(payload.dryRun).toBe(true);
      expect(payload.success).toBe(true);
      expect(payload.courseModuleId).toBe(1564872);
      expect(payload.newFile.sizeBytes).toBe(updatedPdf.length);

      // Verify no upload or controller modification was executed
      expect(uploadCallCount).toBe(beforeUploads);
      expect(modeditPostCallCount).toBe(beforeModedits);
    });

    it('executa a substituição completa do arquivo PDF com verificação pós-gravação e auditoria', async () => {
      const opId = 'op-replace-test-001';

      const res = await mcpClient.callTool({
        name: 'replace_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564872,
          expectedCurrentFilename: 'INE5458 -  DeFi and On Chain Finance.pdf',
          sourceFileUri: `${externalDocBaseUrl}/export-presentation`,
          operationId: opId,
          dryRun: false,
        },
      });

      expect(res.isError).toBeFalsy();
      const payload = parseToolJson(res);

      expect(payload.status).toBe('completed');
      expect(payload.success).toBe(true);
      expect(payload.verification?.verified).toBe(true);
      expect(payload.courseModuleId).toBe(1564872);
      expect(payload.operationId).toBe(opId);
      expect(payload.newFile.sizeBytes).toBe(updatedPdf.length);
      expect(payload.newFile.sha256).toBe(
        crypto.createHash('sha256').update(updatedPdf).digest('hex')
      );

      // Confirm upload and modedit controllers were invoked
      expect(uploadCallCount).toBeGreaterThan(0);
      expect(modeditPostCallCount).toBeGreaterThan(0);

      // Check audit log
      expect(fs.existsSync(auditLogPath)).toBe(true);
      const auditLines = fs
        .readFileSync(auditLogPath, 'utf-8')
        .split('\n')
        .filter(Boolean);
      expect(auditLines.length).toBeGreaterThan(0);
      const lastAudit = JSON.parse(auditLines[auditLines.length - 1]);
      expect(lastAudit.courseId).toBe(49476);
      expect(lastAudit.courseModuleId).toBe(1564872);
      expect(lastAudit.operationId).toBe(opId);
      expect(lastAudit.verified).toBe(true);
    });

    it('retorna resultado idêntico e idempotente ao reutilizar o mesmo operationId', async () => {
      const opId = 'op-replace-test-001';
      const beforeUploads = uploadCallCount;

      const res = await mcpClient.callTool({
        name: 'replace_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564872,
          sourceFileUri: `${externalDocBaseUrl}/export-presentation`,
          operationId: opId,
        },
      });

      expect(res.isError).toBeFalsy();
      const payload = parseToolJson(res);
      expect(payload.status).toBe('idempotent_replay');
      expect(payload.success).toBe(true);
      expect(payload.operationId).toBe(opId);

      // No new uploads performed on idempotency cache hit
      expect(uploadCallCount).toBe(beforeUploads);
    });

    it('ferramenta verify_course_resource_file confere com sucesso o recurso atualizado', async () => {
      const expectedSha256 = crypto.createHash('sha256').update(updatedPdf).digest('hex');

      const res = await mcpClient.callTool({
        name: 'verify_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564872,
          expectedFilename: 'INE5458 -  DeFi and On Chain Finance.pdf',
          expectedSha256,
          expectedSizeBytes: updatedPdf.length,
        },
      });

      expect(res.isError).toBeFalsy();
      const payload = parseToolJson(res);

      expect(payload.verified).toBe(true);
      expect(payload.courseModuleId).toBe(1564872);
      expect(payload.checks.filenameMatches).toBe(true);
      expect(payload.checks.sha256Matches).toBe(true);
      expect(payload.checks.sizeMatches).toBe(true);
      expect(payload.checks.pdfIntegrityValid).toBe(true);
    });

    it('ferramenta verify_course_resource_file detecta divergência de hash', async () => {
      const wrongSha256 = '0000000000000000000000000000000000000000000000000000000000000000';

      const res = await mcpClient.callTool({
        name: 'verify_course_resource_file',
        arguments: {
          courseId: 49476,
          courseModuleId: 1564872,
          expectedSha256: wrongSha256,
        },
      });

      expect(res.isError).toBeFalsy();
      const payload = parseToolJson(res);

      expect(payload.verified).toBe(false);
      expect(payload.checks.sha256Matches).toBe(false);
      expect(payload.failureReasons?.[0]).toContain('Hash SHA-256');
    });
  });
});
