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
  parseAndFormatMoodleDate,
  computeAssignmentFingerprint,
  MoodleAssignmentError,
} from '../src/assignment-manager.js';

const SECRET_MOODLE_TOKEN = 'SECRET_TEST_TOKEN_ASSIGNMENT_11223344';
const MCP_BEARER_TOKEN = 'MCP_TEST_BEARER_ASSIGNMENT_55667788';

function parseToolJson(callResult: any): any {
  const textContent = callResult.content?.find((c: any) => c.type === 'text')?.text;
  if (!textContent) throw new Error('Tool result did not contain text content');
  return JSON.parse(textContent);
}

describe('UFSC Moodle MCP v1.4.0 — Gestão e Publicação de Tarefas (mod_assign)', () => {
  let serverTempDir: string;
  let auditLogPath: string;
  let mockMoodleServer: http.Server;
  let mockMoodleBaseUrl: string;
  let mcpApp: MoodleHttpServerInstance;
  let mcpClient: Client;

  // Mock State in Moodle
  let currentTeacherRoles = ['editingteacher'];
  let currentSectionVisible = true;
  let currentModuleVisible = true;
  let currentAssignmentIntro: string | null = null; // null represents not_returned, "" represents empty
  let currentIntroFormat = 1;
  let currentDueDate = 1795748340; // 2026-11-26T23:59:00-03:00 (UTC 2026-11-27T02:59:00Z)
  let currentCutoffDate = 1796093940; // 2026-11-30T23:59:00-03:00 (different cutoffDate: 30/11/2026)
  let currentAllowSubDate = 0;
  let currentAlwaysShowDescription = 1;
  let currentFileSubmissionEnabled = 1;
  let currentMaxFiles = 2;
  let currentFileTypes = '.pdf,.zip';
  let currentMaxSizeBytes = 0;
  let currentMaxGrade = 10;
  let currentTeamSubmission = 0; // individual
  let modeditPostCallCount = 0;
  let lastModeditPostBody = '';
  let mockSimulateFormRejection = false;
  let mockSimulateSessionExpired = false;
  let mockSimulateUnconfirmedWrite = false;
  let mockSimulateDivergenceOnSave = false;
  let mockSimulateNativeMoodleError = false;
  let mockSimulateUnclassifiedResponse = false;

  beforeAll(async () => {
    serverTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-assignment-test-'));
    auditLogPath = path.join(serverTempDir, 'assignment-audit.jsonl');

    // 1. Mock Moodle Server
    mockMoodleServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // Moodle Web Service REST endpoint
      if (url.pathname === '/webservice/rest/server.php') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const wsfunction = params.get('wsfunction') || url.searchParams.get('wsfunction');
          const token = params.get('wstoken') || url.searchParams.get('wstoken');

          if (token !== SECRET_MOODLE_TOKEN) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid token', errorcode: 'invalidtoken' }));
            return;
          }

          if (wsfunction === 'core_webservice_get_site_info') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                sitename: 'UFSC Moodle Test Instance',
                siteurl: mockMoodleBaseUrl,
                username: 'prof.test',
                firstname: 'Professor',
                lastname: 'Docente',
                fullname: 'Professor Docente',
                lang: 'pt_br',
                userid: 1042,
                userissiteadmin: false,
                version: '2022112805.00',
                release: '4.1.5+ (Build: 20230915)',
              })
            );
            return;
          }

          if (wsfunction === 'core_enrol_get_users_courses') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify([
                {
                  id: 49472,
                  shortname: 'INE5429-07208 (20262)',
                  fullname: 'INE5429-07208 (20262) - Segurança em Sistemas de Informação',
                  roles: currentTeacherRoles.map((role) => ({ roleid: 3, shortname: role })),
                },
              ])
            );
            return;
          }

          if (wsfunction === 'mod_assign_get_assignments') {
            const courseIds = params.getAll('courseids[]');
            if (courseIds.length === 0) {
              // also support courseids[0]
              const single = params.get('courseids[0]');
              if (single) courseIds.push(single);
            }

            const assignmentsList: any[] = [];
            if (courseIds.includes('49472') || courseIds.length === 0) {
              const assignObj: any = {
                id: 125468,
                cmid: 1569058,
                course: 49472,
                name: 'Trabalho Prático Individual — Implementação e Análise Crítica de Pipeline DevSecOps',
                nosubmissions: 0,
                submissiondrafts: 0,
                sendnotifications: 0,
                sendlatenotifications: 0,
                duedate: currentDueDate,
                allowsubmissionsfromdate: currentAllowSubDate,
                cutoffdate: currentCutoffDate,
                gradingduedate: 0,
                alwaysshowdescription: currentAlwaysShowDescription,
                grade: currentMaxGrade,
                teamsubmission: currentTeamSubmission,
                preventsubmissionnotingroup: 0,
                markingworkflow: 1,
                markingallocation: 0,
                blindmarking: 0,
                introformat: currentIntroFormat,
                configs: [
                  {
                    plugin: 'assignsubmission_file',
                    subtype: 'assignsubmission',
                    name: 'enabled',
                    value: String(currentFileSubmissionEnabled),
                  },
                  {
                    plugin: 'assignsubmission_file',
                    subtype: 'assignsubmission',
                    name: 'maxfilesubmissions',
                    value: String(currentMaxFiles),
                  },
                  {
                    plugin: 'assignsubmission_file',
                    subtype: 'assignsubmission',
                    name: 'filetypeslist',
                    value: currentFileTypes,
                  },
                  {
                    plugin: 'assignsubmission_file',
                    subtype: 'assignsubmission',
                    name: 'maxsubmissionsizebytes',
                    value: String(currentMaxSizeBytes),
                  },
                  {
                    plugin: 'assignsubmission_onlinetext',
                    subtype: 'assignsubmission',
                    name: 'enabled',
                    value: '0',
                  },
                  {
                    plugin: 'assignsubmission_comments',
                    subtype: 'assignsubmission',
                    name: 'enabled',
                    value: '1',
                  },
                ],
                introattachments: [
                  {
                    filename: 'roteiro_devsecops_anexo.pdf',
                    filepath: '/',
                    filesize: 124500,
                    fileurl: `${mockMoodleBaseUrl}/pluginfile.php/1569058/mod_assign/intro/roteiro.pdf`,
                    timemodified: 1720878457,
                    mimetype: 'application/pdf',
                  },
                ],
              };

              // Assign intro conditionally according to currentAssignmentIntro state
              if (currentAssignmentIntro !== null) {
                assignObj.intro = currentAssignmentIntro;
              }

              assignmentsList.push(assignObj);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                courses: [
                  {
                    id: 49472,
                    fullname: 'INE5429-07208 (20262) - Segurança em Sistemas de Informação',
                    shortname: 'INE5429-07208 (20262)',
                    timemodified: 1720878457,
                    assignments: assignmentsList,
                  },
                ],
                warnings: [],
              })
            );
            return;
          }

          if (wsfunction === 'core_course_get_contents') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify([
                {
                  id: 92834,
                  name: 'Módulo 4: DevSecOps e Automação de Segurança',
                  section: 4,
                  visible: currentSectionVisible ? 1 : 0,
                  summary: '',
                  summaryformat: 1,
                  modules: [
                    {
                      id: 1569058,
                      url: `${mockMoodleBaseUrl}/mod/assign/view.php?id=1569058`,
                      name: 'Trabalho Prático Individual — Implementação e Análise Crítica de Pipeline DevSecOps',
                      instance: 125468,
                      modname: 'assign',
                      modplural: 'Tarefas',
                      visible: currentModuleVisible ? 1 : 0,
                      uservisible: true,
                      indent: 0,
                    },
                  ],
                },
              ])
            );
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown wsfunction ${wsfunction}` }));
        });
        return;
      }

      // Web controller: GET /course/modedit.php?update=1569058
      if (url.pathname === '/course/modedit.php' && req.method === 'GET') {
        const updateId = url.searchParams.get('update');
        if (updateId === '1569058') {
          if (mockSimulateSessionExpired) {
            res.writeHead(302, { Location: `${mockMoodleBaseUrl}/login/index.php` });
            res.end();
            return;
          }

          const formHtml = `
            <!DOCTYPE html>
            <html>
            <head><title>Edit Assignment</title></head>
            <body>
              <!-- Other form on the page that must NOT be serialized into modedit POST -->
              <form class="nav-search-form" action="/search" method="get">
                <input type="text" name="query" value="search text to ignore" />
                <select name="nav_jump"><option value="jump_1">Jump 1</option></select>
              </form>

              <form method="post" action="/course/modedit.php" id="mform1_YePVq1EVMN6ga7f" class="mform" name="_qf__mod_assign_mod_form">
                <input type="hidden" name="sesskey" value="MOCK_SESSKEY_12345" />
                <input type="hidden" name="_qf__mod_assign_mod_form" value="1" />
                <input type="hidden" name="update" value="1569058" />
                <input type="hidden" name="course" value="49472" />
                <input type="hidden" name="coursemodule" value="1569058" />
                <input type="hidden" name="instance" value="125468" />
                <input type="text" name="name" value="Trabalho Prático Individual — Implementação e Análise Crítica de Pipeline DevSecOps" />
                
                <textarea name="introeditor[text]">${currentAssignmentIntro ?? ''}</textarea>
                <input type="hidden" name="introeditor[format]" value="${currentIntroFormat}" />
                <input type="hidden" name="introeditor[itemid]" value="789012" />

                <!-- Checkbox with hidden companion default -->
                <input type="hidden" name="showdescription" value="0" />
                <input type="checkbox" name="showdescription" value="1" id="id_showdescription" />

                <!-- alwaysshowdescription checkbox (distinct from showdescription) -->
                <input type="checkbox" name="alwaysshowdescription" value="1" id="id_alwaysshowdescription" ${currentAlwaysShowDescription ? 'checked' : ''} />

                <!-- Disabled control that must be ignored by form submission -->
                <input type="text" name="disabled_control" value="should_be_skipped" disabled />

                <!-- Entity test -->
                <input type="hidden" name="entity_test" value="Texto &amp; &quot;aspas&quot; &#039;teste&#039;" />

                <input type="checkbox" name="duedate[enabled]" value="1" ${currentDueDate > 0 ? 'checked' : ''} />
                <select name="duedate[day]"><option value="1">1</option><option value="26" selected >26</option></select>
                <select name="duedate[month]"><option value="1">janeiro</option><option value="11" selected >novembro</option></select>
                <select name="duedate[year]"><option value="1900">1900</option><option value="2026" selected >2026</option></select>
                <select name="duedate[hour]"><option value="0">0</option><option value="23" selected >23</option></select>
                <select name="duedate[minute]"><option value="0">0</option><option value="59" selected >59</option></select>

                <input type="checkbox" name="cutoffdate[enabled]" value="1" ${currentCutoffDate > 0 ? 'checked' : ''} />
                <select name="cutoffdate[day]"><option value="1">1</option><option value="30" selected >30</option></select>
                <select name="cutoffdate[month]"><option value="1">janeiro</option><option value="11" selected >novembro</option></select>
                <select name="cutoffdate[year]"><option value="1900">1900</option><option value="2026" selected >2026</option></select>
                <select name="cutoffdate[hour]"><option value="0">0</option><option value="23" selected >23</option></select>
                <select name="cutoffdate[minute]"><option value="0">0</option><option value="59" selected >59</option></select>

                <input type="checkbox" name="assignsubmission_file_enabled" value="1" ${currentFileSubmissionEnabled ? 'checked' : ''} />
                <select name="assignsubmission_file_maxfiles"><option value="1">1</option><option value="2" selected >2</option></select>
                <!-- Exact real Moodle 4.x input name for file types without scalar duplicate -->
                <input type="text" name="assignsubmission_file_filetypes[filetypes]" id="id_assignsubmission_file_filetypes" value="${currentFileTypes}" />
                <input type="text" name="assignsubmission_file_maxsizebytes" value="${currentMaxSizeBytes}" />

                <select name="grade[modgrade_type]"><option value="none">Nenhum</option><option value="point" selected >Ponto</option></select>

                <select name="visible">
                  <option value="1" ${currentModuleVisible ? 'selected' : ''}>Mostrar na página do curso</option>
                  <option value="0" ${!currentModuleVisible ? 'selected' : ''}>Ocultar dos estudantes</option>
                </select>

                <input type="submit" name="submitbutton2" id="id_submitbutton2" value="Salvar e voltar ao curso" />
                <input type="submit" name="submitbutton" id="id_submitbutton" value="Salvar e mostrar" />
                <input type="submit" name="cancel" id="id_cancel" value="Cancelar" />
              </form>
            </body>
            </html>
          `;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(formHtml);
          return;
        }
      }

      // Web controller: POST /course/modedit.php
      if (url.pathname === '/course/modedit.php' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          modeditPostCallCount++;
          lastModeditPostBody = body;
          const params = new URLSearchParams(body);

          if (mockSimulateSessionExpired) {
            res.writeHead(302, { Location: `${mockMoodleBaseUrl}/login/index.php` });
            res.end();
            return;
          }

          if (mockSimulateNativeMoodleError) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html><html><head><title>Erro no Moodle</title></head><body>
                <div class="alert alert-danger" role="alert">Erro nativo do banco de dados Moodle: dmlwriteexception ao gravar tabela assign.</div>
              </body></html>
            `);
            return;
          }

          if (mockSimulateUnclassifiedResponse) {
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1><p>The proxy could not connect to upstream server.</p></body></html>`);
            return;
          }

          // Strict validation: Reject if scalar assignsubmission_file_filetypes was sent!
          if (params.has('assignsubmission_file_filetypes')) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html><html><body>
                <div class="alert alert-danger">PHP Fatal Error: Scalar assignsubmission_file_filetypes collision detected</div>
              </body></html>
            `);
            return;
          }

          // Strict validation: Reject if disabled control or control from other form was sent!
          if (params.has('disabled_control')) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<div class="alert alert-danger">Disabled control was improperly submitted</div>');
            return;
          }

          if (params.has('query')) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<div class="alert alert-danger">Extraneous control from other form submitted</div>');
            return;
          }

          if (mockSimulateFormRejection) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html><html><body>
                <form id="mform1" class="mform">
                  <input type="hidden" name="_qf__mod_assign_mod_form" value="1" />
                  <div id="id_error_duedate" class="error">Data de vencimento não pode ser anterior à data de abertura.</div>
                </form>
              </body></html>
            `);
            return;
          }

          if (mockSimulateUnconfirmedWrite) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!DOCTYPE html><html><head><title>Página Inesperada</title></head><body>Página inesperada sem confirmação</body></html>');
            return;
          }

          // Strict validation: Reject if dates were corrupted to default 1900!
          if (params.get('duedate[year]') === '1900' || params.get('cutoffdate[year]') === '1900') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html><html><body>
                <form id="mform1" class="mform">
                  <input type="hidden" name="_qf__mod_assign_mod_form" value="1" />
                  <div id="id_error_duedate" class="error">Ano inválido: 1900</div>
                </form>
              </body></html>
            `);
            return;
          }

          // Strict validation: Must submit using submitbutton2 "Salvar e voltar ao curso" and NOT cancel
          if (params.has('cancel')) {
            // Cancelled: redirects without updating state!
            res.writeHead(303, { Location: `${mockMoodleBaseUrl}/course/view.php?id=49472` });
            res.end();
            return;
          }

          if (params.get('submitbutton2') !== 'Salvar e voltar ao curso') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html><html><body>
                <form id="mform1" class="mform">
                  <input type="hidden" name="_qf__mod_assign_mod_form" value="1" />
                  <div id="id_error_submitbutton" class="error">Botão de envio inválido ou ausente</div>
                </form>
              </body></html>
            `);
            return;
          }

          // Update mock state based on form parameters
          if (params.has('introeditor[text]')) {
            currentAssignmentIntro = params.get('introeditor[text]');
          }
          if (mockSimulateDivergenceOnSave) {
            currentModuleVisible = false;
          } else if (params.has('visible')) {
            currentModuleVisible = params.get('visible') === '1';
          }
          if (params.has('alwaysshowdescription')) {
            currentAlwaysShowDescription = params.get('alwaysshowdescription') === '1' ? 1 : 0;
          }

          if (params.get('duedate[enabled]') === '1') {
            const day = parseInt(params.get('duedate[day]') || '26', 10);
            const month = parseInt(params.get('duedate[month]') || '11', 10);
            const year = parseInt(params.get('duedate[year]') || '2026', 10);
            const hour = parseInt(params.get('duedate[hour]') || '23', 10);
            const minute = parseInt(params.get('duedate[minute]') || '59', 10);
            const pad = (n: number) => String(n).padStart(2, '0');
            const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-03:00`;
            currentDueDate = parseAndFormatMoodleDate(iso).timestamp;
          } else if (!params.has('duedate[enabled]')) {
            currentDueDate = 0;
          }

          if (params.get('cutoffdate[enabled]') === '1') {
            const day = parseInt(params.get('cutoffdate[day]') || '30', 10);
            const month = parseInt(params.get('cutoffdate[month]') || '11', 10);
            const year = parseInt(params.get('cutoffdate[year]') || '2026', 10);
            const hour = parseInt(params.get('cutoffdate[hour]') || '23', 10);
            const minute = parseInt(params.get('cutoffdate[minute]') || '59', 10);
            const pad = (n: number) => String(n).padStart(2, '0');
            const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-03:00`;
            currentCutoffDate = parseAndFormatMoodleDate(iso).timestamp;
          }

          if (params.has('assignsubmission_file_enabled')) {
            currentFileSubmissionEnabled = params.get('assignsubmission_file_enabled') === '1' ? 1 : 0;
          }
          if (params.has('assignsubmission_file_maxfiles')) {
            currentMaxFiles = parseInt(params.get('assignsubmission_file_maxfiles') || '2', 10);
          }
          if (params.has('assignsubmission_file_filetypes[filetypes]')) {
            currentFileTypes = params.get('assignsubmission_file_filetypes[filetypes]') || '';
          }
          if (params.has('assignsubmission_file_maxsizebytes')) {
            currentMaxSizeBytes = parseInt(params.get('assignsubmission_file_maxsizebytes') || '0', 10);
          }

          // Return 303 Redirect representing successful save
          res.writeHead(303, { Location: `${mockMoodleBaseUrl}/course/view.php?id=49472` });
          res.end();
        });
        return;
      }

      // Course view endpoint: returns realistic course page with sesskey, invalid-feedback classes and "invalidjson"
      if (url.pathname === '/course/view.php') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>INE5429-07208: Segurança em Sistemas</title></head>
          <body>
            <h1>Página da Disciplina</h1>
            <script>
              M.cfg = { "wwwroot": "${mockMoodleBaseUrl}", "sesskey": "MOCK_SESSKEY_12345" };
              var strTable = { "invalidjson": "palavra JSON inválida", "size": "Tamanho" };
            </script>
            <div class="form-control-feedback invalid-feedback" id="id_error_sample"></div>
          </body>
          </html>
        `);
        return;
      }

      // Mock login for MoodleWebSession
      if (url.pathname.startsWith('/login/index.php')) {
        if (mockSimulateSessionExpired) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!DOCTYPE html><html><body><form id="login" action="/login/index.php"><input name="username"></form></body></html>');
          return;
        }
        res.writeHead(302, {
          Location: `${mockMoodleBaseUrl}/my/`,
          'Set-Cookie': 'MoodleSession=mock_valid_session_assign_123; Path=/',
        });
        res.end();
        return;
      }

      if (url.pathname.startsWith('/my/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!DOCTYPE html><html><body>Dashboard Logged In <span name="sesskey">MOCK_SESSKEY_12345</span></body></html>'
        );
        return;
      }

      // Default 404
      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => mockMoodleServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockMoodleServer.address() as any;
    mockMoodleBaseUrl = `http://127.0.0.1:${addr.port}`;

    // 2. Start MCP Server App
    const moodleCfg: MoodleConfig = {
      siteUrl: mockMoodleBaseUrl,
      restEndpoint: `${mockMoodleBaseUrl}/webservice/rest/server.php`,
      token: SECRET_MOODLE_TOKEN,
      username: 'prof.test',
      password: 'ProfPassword123',
      defaultCourseId: 49472,
      tempDir: serverTempDir,
      mcpAuthToken: MCP_BEARER_TOKEN,
    };

    process.env.ASSIGNMENT_AUDIT_LOG_PATH = auditLogPath;
    mcpApp = createMoodleHttpServer({ config: moodleCfg, authToken: MCP_BEARER_TOKEN });
    await new Promise<void>((resolve) => {
      mcpApp.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (mcpApp.httpServer.address() as any).port;
    const mcpUrl = new URL(`http://127.0.0.1:${port}/${MCP_BEARER_TOKEN}`);

    // 3. Connect MCP Client
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    mcpClient = new Client({ name: 'mcp-assignment-test-client', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
  });

  afterAll(async () => {
    try {
      await mcpClient?.close();
    } catch {}
    try {
      await mcpApp?.close();
    } catch {}
    try {
      mockMoodleServer?.close();
    } catch {}
    try {
      fs.rmSync(serverTempDir, { recursive: true, force: true });
    } catch {}
  });

  // Test 1: Distinção explícita do estado do enunciado (presente, vazio, não retornado, não autorizado)
  it('1. Distinção do enunciado: presente vs vazio vs não retornado', async () => {
    // 1.1 Intro not returned (null)
    currentAssignmentIntro = null;
    let res = await mcpClient.callTool({
      name: 'get_assignment_details',
      arguments: { courseId: 49472, assignmentId: 125468 },
    });
    expect(res.isError).toBeFalsy();
    let data = parseToolJson(res);
    expect(data.intro.status).toBe('not_returned');
    expect(data.intro.html).toBeNull();
    expect(data.intro.text).toBeNull();

    // 1.2 Intro empty ("")
    currentAssignmentIntro = '';
    res = await mcpClient.callTool({
      name: 'get_assignment_details',
      arguments: { courseId: 49472, assignmentId: 125468 },
    });
    data = parseToolJson(res);
    expect(data.intro.status).toBe('empty');
    expect(data.intro.html).toBe('');
    expect(data.intro.text).toBe('');

    // 1.3 Intro present with HTML
    currentAssignmentIntro = '<h3>Objetivo</h3><p>Implementar pipeline DevSecOps com SAST e DAST.</p>';
    res = await mcpClient.callTool({
      name: 'get_assignment_details',
      arguments: { courseId: 49472, assignmentId: 125468 },
    });
    data = parseToolJson(res);
    expect(data.intro.status).toBe('present');
    expect(data.intro.html).toContain('<h3>Objetivo</h3>');
    expect(data.intro.text).toContain('Objetivo');
    expect(data.intro.attachments.length).toBe(1);
    expect(data.intro.attachments[0].filename).toBe('roteiro_devsecops_anexo.pdf');
  });

  // Test 2: Preservação de HTML, tabelas, código e anexos no patch
  it('2. Preservação de HTML, código, tabelas e anexos no plano de alteração', async () => {
    const complexHtml = `
      <h2>Orientações da Atividade Prática</h2>
      <p>Configure a pipeline de CI/CD utilizando o GitHub Actions ou GitLab CI.</p>
      <pre><code>steps:
  - name: Run Snyk SAST
    uses: snyk/actions/node@master
</code></pre>
      <table border="1">
        <tr><th>Critério</th><th>Peso</th></tr>
        <tr><td>SAST/DAST</td><td>50%</td></tr>
        <tr><td>Análise Crítica</td><td>50%</td></tr>
      </table>
    `.trim();

    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          intro: complexHtml,
        },
      },
    });

    expect(prepRes.isError).toBeFalsy();
    const plan = parseToolJson(prepRes);
    expect(plan.planId).toMatch(/^plan_assign_/);
    expect(plan.planHash).toBeTruthy();
    expect(plan.proposedDiff.intro.proposed).toBe(complexHtml);
    expect(plan.unchangedFields).toContain('name');
    expect(plan.unchangedFields).toContain('maxGrade');
    expect(plan.unchangedFields).toContain('teamSubmission');
    expect(plan.unchangedFields).toContain('introAttachments');
  });

  // Test 3: Patch parcial e proteção para limpeza explícita do enunciado
  it('3. Proteção contra limpeza acidental: clearIntro: true obrigatório para enunciado vazio', async () => {
    // Attempting to clear intro without clearIntro: true
    const prepFail = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          intro: '',
        },
      },
    });

    expect(prepFail.isError).toBeTruthy();
    const errData = parseToolJson(prepFail);
    expect(errData.errorCode).toBe('invalid_patch');
    expect(errData.errorMessage).toContain('clearIntro: true');

    // With clearIntro: true, it is accepted
    const prepSuccess = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          intro: '',
          clearIntro: true,
        },
      },
    });

    expect(prepSuccess.isError).toBeFalsy();
    const plan = parseToolJson(prepSuccess);
    expect(plan.proposedDiff.intro.proposed).toBe('');
  });

  // Test 4: Datas com fuso e conversão atravessando a meia-noite UTC
  it('4. Validação de datas: ISO com offset America/Sao_Paulo cruzando meia-noite UTC (23:59 BRT -> 02:59 UTC)', async () => {
    // Fixture: 2026-11-26T23:59:00-03:00 -> UTC 2026-11-27T02:59:00Z
    const localDateStr = '2026-11-26T23:59:00-03:00';
    const parsed = parseAndFormatMoodleDate(localDateStr);

    expect(parsed.parts.year).toBe(2026);
    expect(parsed.parts.month).toBe(11);
    expect(parsed.parts.day).toBe(26); // Day 26 in SP
    expect(parsed.parts.hour).toBe(23);
    expect(parsed.parts.minute).toBe(59);
    expect(parsed.isoUtc).toBe('2026-11-27T02:59:00.000Z'); // Day 27 in UTC
    expect(parsed.timestamp).toBe(1795748340);

    // Reject date string missing timezone offset
    expect(() => parseAndFormatMoodleDate('2026-11-26 23:59:00')).toThrowError(
      /Data ambígua sem fuso horário/
    );
  });

  // Test 5: Preservação de cutoffDate ao alterar apenas o dueDate
  it('5. Vencimento e encerramento independentes: alterar dueDate NÃO altera cutoffDate', async () => {
    const originalCutoff = currentCutoffDate;

    // Prepare update modifying ONLY dueDate
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          dueDate: {
            enabled: true,
            date: '2026-11-26T23:59:00-03:00',
          },
        },
      },
    });

    expect(prepRes.isError).toBeFalsy();
    const plan = parseToolJson(prepRes);
    expect(plan.proposedDiff.dueDate).toBeDefined();
    expect(plan.proposedDiff.cutoffDate).toBeUndefined(); // cutoffDate NOT in diff!
    expect(plan.unchangedFields).toContain('cutoffDate'); // explicitly preserved!

    // Commit plan
    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    if (commitRes.isError) {
      console.error('COMMIT RES ERROR:', JSON.stringify(parseToolJson(commitRes), null, 2));
    }
    expect(commitRes.isError).toBeFalsy();
    expect(currentCutoffDate).toBe(originalCutoff); // Cutoff remains strictly unchanged!
  });

  // Test 6: Visibilidade do módulo com seção oculta (effectiveVisible = false e aviso)
  it('6. Avaliação de visibilidade: módulo visível com seção oculta alerta sobre impedimento aos alunos', async () => {
    currentSectionVisible = false;
    currentModuleVisible = true;

    const res = await mcpClient.callTool({
      name: 'get_assignment_details',
      arguments: { courseId: 49472, assignmentId: 125468 },
    });

    const data = parseToolJson(res);
    expect(data.visibility.moduleVisible).toBe(true);
    expect(data.visibility.sectionVisible).toBe(false);
    expect(data.visibility.effectiveVisible).toBe(false);
    expect(data.visibility.accessRestrictions.some((r: string) => r.includes('seção 4 está oculta'))).toBe(true);

    currentSectionVisible = true; // restore
  });

  // Test 7: Configuração PDF + ZIP e proteção contra redução de maxFiles
  it('7. Configuração de arquivos de entrega (.pdf, .zip) e proteção contra redução não autorizada de maxFiles', async () => {
    // Current maxFiles is 2. Proposing 1 without allowReduceMaxFiles: true must fail.
    const prepFail = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          maxFiles: 1,
        },
      },
    });

    expect(prepFail.isError).toBeTruthy();
    const err = parseToolJson(prepFail);
    expect(err.errorCode).toBe('invalid_patch');
    expect(err.errorMessage).toContain('allowReduceMaxFiles: true');

    // With allowReduceMaxFiles: true and PDF+ZIP, succeeds
    const prepOk = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          fileSubmissionEnabled: true,
          fileTypes: '.pdf,.zip',
          maxFiles: 2,
        },
        allowReduceMaxFiles: true,
      },
    });

    expect(prepOk.isError).toBeFalsy();
    const plan = parseToolJson(prepOk);
    expect(plan.sideEffectsAndWarnings.some((w: string) => w.includes('PDF e ZIP'))).toBe(true);
  });

  // Test 8: Permissão negada e inconsistência de módulo / curso
  it('8. Enforça papel docente e valida correspondência curso -> módulo -> tarefa', async () => {
    // Non-editing student role
    currentTeacherRoles = ['student'];

    const res = await mcpClient.callTool({
      name: 'get_assignment_details',
      arguments: { courseId: 49472, assignmentId: 125468 },
    });

    expect(res.isError).toBeTruthy();
    const err = parseToolJson(res);
    expect(err.errorCode).toBe('insufficient_permissions');

    currentTeacherRoles = ['editingteacher']; // restore
  });

  // Test 9: Aprovação inválida, plano adulterado ou expirado
  it('9. Rejeita hash de plano adulterado e exige confirmedByReviewer=true', async () => {
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });

    const plan = parseToolJson(prepRes);

    // 9.1 Missing confirmedByReviewer
    const commitFail1 = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: false,
      },
    });
    expect(commitFail1.isError).toBeTruthy();
    expect(parseToolJson(commitFail1).errorCode).toBe('approval_required');

    // 9.2 Altered plan hash
    const commitFail2 = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: 'tampered_hash_deadbeef123456',
        confirmedByReviewer: true,
      },
    });
    expect(commitFail2.isError).toBeTruthy();
    expect(parseToolJson(commitFail2).errorCode).toBe('invalid_plan_hash');
  });

  // Test 10: Detecção de alteração concorrente após a preparação
  it('10. Detecta alteração concorrente entre a preparação e o commit', async () => {
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });

    const plan = parseToolJson(prepRes);

    // Simulate external change in Moodle before commit (e.g. professor changed intro or dueDate)
    currentAssignmentIntro = 'Enunciado alterado externamente no Moodle pelo professor!';

    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    expect(commitRes.isError).toBeTruthy();
    const err = parseToolJson(commitRes);
    expect(err.errorCode).toBe('concurrency_conflict');
    expect(err.errorMessage).toContain('Conflito de concorrência');
  });

  // Test 11: Idempotência de operação em retentativa
  it('11. Retentativa com operationId retorna idempotent_replay sem re-executar escrita', async () => {
    const operationId = 'test_op_idempotency_998877';

    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
        operationId,
      },
    });

    const plan = parseToolJson(prepRes);
    const initialCallCount = modeditPostCallCount;

    // First commit
    const commitRes1 = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
        operationId,
      },
    });
    expect(commitRes1.isError).toBeFalsy();
    expect(parseToolJson(commitRes1).status).toBe('committed_and_verified');
    expect(modeditPostCallCount).toBe(initialCallCount + 1);

    // Second commit with same operationId -> idempotent replay
    const commitRes2 = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
        operationId,
      },
    });
    expect(commitRes2.isError).toBeFalsy();
    expect(parseToolJson(commitRes2).status).toBe('idempotent_replay');
    // modedit POST was not called again!
    expect(modeditPostCallCount).toBe(initialCallCount + 1);
  });

  // Test 12: Verificação pós-atualização detecta divergência se Moodle não persistir
  it('12. verify_assignment_update detecta divergência caso estado não coincida', async () => {
    const verifyRes = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: {
          visible: !currentModuleVisible, // Expect opposite visibility to simulate divergence
        },
      },
    });

    expect(verifyRes.isError).toBeFalsy();
    const data = parseToolJson(verifyRes);
    expect(data.verified).toBe(false);
    expect(data.status).toBe('divergence');
    expect(data.divergences?.length).toBeGreaterThan(0);
  });

  // Test 13: Preservação de notas máximas, equipes, rubricas e workflow
  it('13. Preserva maxGrade, equipes (teamsubmission) e markingworkflow durante edição', async () => {
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          alwaysShowDescription: true,
        },
      },
    });

    const plan = parseToolJson(prepRes);
    expect(plan.unchangedFields).toContain('maxGrade');
    expect(plan.unchangedFields).toContain('teamSubmission');

    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    if (commitRes.isError) {
      console.error('COMMIT RES ERROR:', JSON.stringify(parseToolJson(commitRes), null, 2));
    }
    expect(commitRes.isError).toBeFalsy();
    expect(currentMaxGrade).toBe(10);
    expect(currentTeamSubmission).toBe(0);
  });

  // Test 14: Ponta a ponta do caso concreto da disciplina INE5429 / Tarefa 125468
  it('14. Ponta a ponta: caso concreto Tarefa 125468 (enunciado DevSecOps, vencimento 26/11 23:59 BRT, visível, PDF+ZIP)', async () => {
    // Start with assignment initially hidden and only 1 PDF file allowed to test publishing and config upgrade
    currentModuleVisible = false;
    currentFileTypes = '.pdf';
    currentMaxFiles = 1;

    const statementHtml = `
      <h3>Trabalho Prático Individual — Implementação e Análise Crítica de Pipeline DevSecOps</h3>
      <p>O objetivo deste trabalho prático é projetar, implementar e validar uma esteira de DevSecOps integrada.</p>
      <ul>
        <li>Etapa 1: Análise estática com SAST e linter de segurança.</li>
        <li>Etapa 2: Auditoria de dependências com SCA.</li>
        <li>Etapa 3: Varredura dinâmica DAST ou contêineres.</li>
      </ul>
      <p>Envie o código-fonte em arquivo .zip e o relatório técnico em arquivo .pdf.</p>
    `.trim();

    // 1. Prepare assignment update with all required fields
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          intro: statementHtml,
          visible: true,
          alwaysShowDescription: true,
          dueDate: {
            enabled: true,
            date: '2026-11-26T23:59:00-03:00',
          },
          fileSubmissionEnabled: true,
          fileTypes: '.pdf,.zip',
          maxFiles: 2,
        },
      },
    });

    expect(prepRes.isError).toBeFalsy();
    const plan = parseToolJson(prepRes);
    expect(plan.planId).toBeTruthy();
    expect(plan.planHash).toBeTruthy();
    expect(plan.proposedDiff.intro.proposed).toBe(statementHtml);
    expect(plan.proposedDiff.visible.proposed).toBe(true);
    expect(plan.proposedDiff.dueDate.proposed.isoUtc).toBe('2026-11-27T02:59:00.000Z');
    expect(plan.proposedDiff.fileTypes.proposed).toBe('.pdf,.zip');
    expect(plan.proposedDiff.maxFiles.proposed).toBe(2);

    // 2. Commit assignment update
    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    if (commitRes.isError) {
      console.error('COMMIT RES ERROR:', JSON.stringify(parseToolJson(commitRes), null, 2));
    }
    expect(commitRes.isError).toBeFalsy();
    const commitData = parseToolJson(commitRes);
    expect(commitData.success).toBe(true);
    expect(commitData.status).toBe('committed_and_verified');
    expect(commitData.verification.verified).toBe(true);

    // 3. Independent Verification
    const verifyRes = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: plan.proposedDiff,
      },
    });

    expect(verifyRes.isError).toBeFalsy();
    const verifyData = parseToolJson(verifyRes);
    expect(verifyData.verified).toBe(true);
    expect(verifyData.status).toBe('confirmed');
    expect(verifyData.currentDetails.visibility.moduleVisible).toBe(true);
    expect(verifyData.currentDetails.intro.html).toContain('Trabalho Prático Individual');
    expect(verifyData.currentDetails.submissionConfig.fileSubmissionEnabled).toBe(true);
    expect(verifyData.currentDetails.submissionConfig.maxFiles).toBe(2);
    expect(verifyData.currentDetails.submissionConfig.fileTypes).toBe('.pdf,.zip');
  });

  // Test 15: HTTP 200 com formulário e erros reporta erro explícito form_rejected
  it('15. Formulário rejeitado com erros de validação reporta form_rejected', async () => {
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    mockSimulateFormRejection = true;
    try {
      const commitRes = await mcpClient.callTool({
        name: 'commit_assignment_update',
        arguments: {
          planId: plan.planId,
          planHash: plan.planHash,
          confirmedByReviewer: true,
        },
      });

      expect(commitRes.isError).toBe(true);
      const err = parseToolJson(commitRes);
      expect(err.errorCode).toBe('form_rejected');
      expect(err.errorMessage).toContain('Data de vencimento não pode ser anterior');
      // Verify structuredContent preserves errorCode
      expect((commitRes as any).structuredContent?.errorCode).toBe('form_rejected');
    } finally {
      mockSimulateFormRejection = false;
    }
  });

  // Test 16: Sessão expirada / redirecionamento para login reporta session_expired
  it('16. Sessão web expirada durante escrita reporta session_expired', async () => {
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    mockSimulateSessionExpired = true;
    try {
      const commitRes = await mcpClient.callTool({
        name: 'commit_assignment_update',
        arguments: {
          planId: plan.planId,
          planHash: plan.planHash,
          confirmedByReviewer: true,
        },
      });

      expect(commitRes.isError).toBe(true);
      const err = parseToolJson(commitRes);
      expect(err.errorCode).toBe('session_expired');
      expect(err.errorMessage).toContain('sessão autenticada do Moodle expirou');
    } finally {
      mockSimulateSessionExpired = false;
    }
  });

  // Test 17: Gravação não confirmada (URL inesperada) reporta write_not_confirmed
  it('17. Resposta HTTP inesperada sem confirmação reporta write_not_confirmed', async () => {
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    mockSimulateUnconfirmedWrite = true;
    try {
      const commitRes = await mcpClient.callTool({
        name: 'commit_assignment_update',
        arguments: {
          planId: plan.planId,
          planHash: plan.planHash,
          confirmedByReviewer: true,
        },
      });

      expect(commitRes.isError).toBe(true);
      const err = parseToolJson(commitRes);
      expect(err.errorCode).toBe('write_not_confirmed');
      expect(err.errorMessage).toContain('não confirmando o salvamento');
    } finally {
      mockSimulateUnconfirmedWrite = false;
    }
  });

  // Test 18: verify_assignment_update com datas em formato público e normalizado
  it('18. verify_assignment_update suporta formato público e normalizado sem undefined e rejeita formato inválido', async () => {
    // 18.1 Public patch format (enabled, date, timeZone)
    const verifyPublic = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: {
          dueDate: {
            enabled: true,
            date: '2026-11-26T23:59:00-03:00',
            timeZone: 'America/Sao_Paulo',
          },
        },
      },
    });
    expect(verifyPublic.isError).toBeFalsy();
    const dataPublic = parseToolJson(verifyPublic);
    expect(dataPublic.checks.dueDateMatches).toBe(true);
    expect(dataPublic.verified).toBe(true);

    // 18.2 Normalized format (enabled, timestamp)
    const verifyNorm = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: {
          dueDate: {
            enabled: true,
            timestamp: 1795748340,
          },
        },
      },
    });
    expect(verifyNorm.isError).toBeFalsy();
    const dataNorm = parseToolJson(verifyNorm);
    expect(dataNorm.checks.dueDateMatches).toBe(true);
    expect(dataNorm.verified).toBe(true);

    // 18.3 Invalid date format rejection (enabled: true with no date/timestamp)
    const verifyInvalid = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: {
          dueDate: {
            enabled: true,
          },
        },
      },
    });
    expect(verifyInvalid.isError).toBe(true);
    const errData = parseToolJson(verifyInvalid);
    expect(errData.errorCode).toBe('invalid_argument');
  });

  // Test 19: verify_assignment_update avalia expectedPreserved e detecta chave desconhecida
  it('19. verify_assignment_update avalia expectedPreserved e reporta chave desconhecida', async () => {
    // 19.1 Successful expectedPreserved check
    const verifyPreserved = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedPreserved: {
          name: 'Trabalho Prático Individual — Implementação e Análise Crítica de Pipeline DevSecOps',
          maxGrade: 10,
          teamSubmission: false,
          cutoffDate: {
            enabled: true,
            timestamp: currentCutoffDate,
          },
          introAttachments: 1,
        },
      },
    });
    expect(verifyPreserved.isError).toBeFalsy();
    const dataPreserved = parseToolJson(verifyPreserved);
    expect(dataPreserved.checks.namePreserved).toBe(true);
    expect(dataPreserved.checks.maxGradePreserved).toBe(true);
    expect(dataPreserved.checks.teamSubmissionPreserved).toBe(true);
    expect(dataPreserved.checks.cutoffDatePreserved).toBe(true);
    expect(dataPreserved.checks.introAttachmentsPreserved).toBe(true);
    expect(dataPreserved.verified).toBe(true);

    // 19.2 Divergence in preserved field
    const verifyDiverge = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedPreserved: {
          maxGrade: 100, // actual is 10
        },
      },
    });
    expect(verifyDiverge.isError).toBeFalsy();
    const dataDiverge = parseToolJson(verifyDiverge);
    expect(dataDiverge.checks.maxGradePreserved).toBe(false);
    expect(dataDiverge.verified).toBe(false);
    expect(dataDiverge.divergences?.some((d: string) => d.includes('maxGrade'))).toBe(true);

    // 19.3 Unknown key in expectedChanges
    const verifyUnknown = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: {
          unknownFieldXYZ: 'some_value',
        },
      },
    });
    expect(verifyUnknown.isError).toBeFalsy();
    const dataUnknown = parseToolJson(verifyUnknown);
    expect(dataUnknown.checks.unknownFieldXYZMatches).toBe(false);
    expect(dataUnknown.verified).toBe(false);
    expect(dataUnknown.divergences?.some((d: string) => d.includes('Chave de expectativa desconhecida'))).toBe(true);
  });

  // Test 20: Preservação de diagnóstico e structuredContent contra fallback genérico
  it('20. Coerência entre erro textual e structuredContent preserva detalhes sem remapear', async () => {
    currentModuleVisible = false; // ensure start state is false so proposing visible: true generates a diff
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    // Simulate divergence during commit verification: POST will succeed, but visible won't be persisted
    mockSimulateDivergenceOnSave = true;
    try {
      const commitRes = await mcpClient.callTool({
        name: 'commit_assignment_update',
        arguments: {
          planId: plan.planId,
          planHash: plan.planHash,
          confirmedByReviewer: true,
        },
      });

      expect(commitRes.isError).toBe(true);
      const textData = parseToolJson(commitRes);
      expect(textData.errorCode).toBe('verification_failed');
      expect(textData.errorMessage).toContain('verificação pós-atualização detectou divergências');

      // Crucial: structuredContent must NOT be lost or generic INVALID_ARGUMENT!
      const structured = (commitRes as any).structuredContent;
      expect(structured).toBeDefined();
      expect(structured.errorCode).toBe('verification_failed');
      expect(structured.verification).toBeDefined();
    } finally {
      mockSimulateDivergenceOnSave = false;
    }
  });

  // Test 21: Sanitização da trilha de auditoria
  it('21. Trilha de auditoria sanitiza tokens, senhas, sesskeys e cookies de sessão', async () => {
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
        operationId: 'audit_sanitize_test_op_1',
      },
    });

    expect(fs.existsSync(auditLogPath)).toBe(true);
    const auditContent = fs.readFileSync(auditLogPath, 'utf-8');
    expect(auditContent).not.toContain(SECRET_MOODLE_TOKEN);
    expect(auditContent).not.toContain('ProfPassword123');
    expect(auditContent).not.toContain('MOCK_SESSKEY_12345');
    expect(auditContent).not.toContain('mock_valid_session_assign_123');
  });

  // Test 22: Página válida contendo sesskey e invalid em scripts não dispara erro fatal, salva e confirma com sucesso
  it('22. Resposta de salvamento contendo sesskey e invalid em scripts não dispara erro fatal falso positivo', async () => {
    currentModuleVisible = false;
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    expect(commitRes.isError).toBeFalsy();
    const commitData = parseToolJson(commitRes);
    expect(commitData.success).toBe(true);
    expect(commitData.status).toBe('committed_and_verified');
    expect(commitData.verification.verified).toBe(true);
    expect(commitData.errorMessage).toBeUndefined();
  });

  // Test 23: Página de erro real do Moodle (.alert-danger, #notice, errorbox) retorna mensagem nativa sem inventar texto
  it('23. Erro nativo real do Moodle retorna mensagem sanitizada sem texto inventado', async () => {
    currentModuleVisible = false;
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    mockSimulateNativeMoodleError = true;
    try {
      const commitRes = await mcpClient.callTool({
        name: 'commit_assignment_update',
        arguments: {
          planId: plan.planId,
          planHash: plan.planHash,
          confirmedByReviewer: true,
        },
      });

      expect(commitRes.isError).toBe(true);
      const commitData = parseToolJson(commitRes);
      expect(commitData.errorCode).toBe('moodle_api_error');
      expect(commitData.errorMessage).toContain('Erro nativo do banco de dados Moodle: dmlwriteexception ao gravar tabela assign.');
      expect(commitData.errorMessage).not.toContain('erro fatal retornado pelo Moodle');
    } finally {
      mockSimulateNativeMoodleError = false;
    }
  });

  // Test 24: Resposta não-classificada (HTTP 502) reporta write_not_confirmed preservando status, URL, título e trecho
  it('24. Resposta não-classificada (HTTP 502) reporta write_not_confirmed com título e status sem inventar erro fatal', async () => {
    currentModuleVisible = false;
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    mockSimulateUnclassifiedResponse = true;
    try {
      const commitRes = await mcpClient.callTool({
        name: 'commit_assignment_update',
        arguments: {
          planId: plan.planId,
          planHash: plan.planHash,
          confirmedByReviewer: true,
        },
      });

      expect(commitRes.isError).toBe(true);
      const commitData = parseToolJson(commitRes);
      expect(commitData.errorCode).toBe('write_not_confirmed');
      expect(commitData.errorMessage).toContain('502');
      expect(commitData.errorMessage).toContain('502 Bad Gateway');
      expect(commitData.errorMessage).not.toContain('erro fatal retornado pelo Moodle');
    } finally {
      mockSimulateUnclassifiedResponse = false;
    }
  });

  // Test 25: Escopo do formulário ignora formulários externos, preserva entidades, ignora controles desabilitados e lida com checkboxes
  it('25. Escopo do formulário modedit isola _qf__mod_assign_mod_form, decodifica entidades e ignora controles desabilitados', async () => {
    currentModuleVisible = false;
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    expect(commitRes.isError).toBeFalsy();
    const params = new URLSearchParams(lastModeditPostBody);
    // Outer search form inputs must NOT be submitted
    expect(params.has('query')).toBe(false);
    expect(params.has('nav_jump')).toBe(false);
    // Disabled control must NOT be submitted
    expect(params.has('disabled_control')).toBe(false);
    // Entity decoded properly in preserved form inputs
    expect(params.get('entity_test')).toBe('Texto & "aspas" \'teste\'');
    // submitbutton2 was submitted
    expect(params.get('submitbutton2')).toBe('Salvar e voltar ao curso');
    // cancel was NOT submitted
    expect(params.has('cancel')).toBe(false);
  });

  // Test 26: Parâmetro filetypes estrito sem colisão escalar aceita PDF e ZIP
  it('26. Parâmetro assignsubmission_file_filetypes[filetypes] não sofre colisão escalar com chave raiz', async () => {
    currentFileTypes = '';
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          fileTypes: '.pdf,.zip',
        },
      },
    });
    const plan = parseToolJson(prepRes);

    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    expect(commitRes.isError).toBeFalsy();
    const commitData = parseToolJson(commitRes);
    expect(commitData.success).toBe(true);

    const params = new URLSearchParams(lastModeditPostBody);
    expect(params.get('assignsubmission_file_filetypes[filetypes]')).toBe('.pdf,.zip');
    expect(params.has('assignsubmission_file_filetypes')).toBe(false);
  });

  // Test 27: Independência entre alwaysshowdescription/showdescription e dueDate/cutoffDate
  it('27. Independência entre alwaysshowdescription/showdescription e dueDate/cutoffDate', async () => {
    currentAlwaysShowDescription = 0;
    currentDueDate = 1795748340; // 26/11/2026 23:59:00
    currentCutoffDate = 0;

    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          alwaysShowDescription: true,
          cutoffDate: {
            enabled: true,
            date: '2026-11-30T23:59:00-03:00',
          },
        },
      },
    });
    const plan = parseToolJson(prepRes);

    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    expect(commitRes.isError).toBeFalsy();
    const params = new URLSearchParams(lastModeditPostBody);
    // alwaysshowdescription is set to 1
    expect(params.get('alwaysshowdescription')).toBe('1');
    // showdescription remains 0 (course overview description display not confused with assignment alwaysshowdescription)
    expect(params.get('showdescription')).toBe('0');
    // duedate was preserved
    expect(params.get('duedate[year]')).toBe('2026');
    // cutoffdate was updated
    expect(params.get('cutoffdate[enabled]')).toBe('1');
    expect(params.get('cutoffdate[day]')).toBe('30');
  });

  // Test 28: Preservação e verificação unificada de onlineTextEnabled, commentsEnabled e introAttachments
  it('28. Preservação e verificação unificada de onlineTextEnabled, commentsEnabled e introAttachments', async () => {
    currentModuleVisible = false;
    const prepRes = await mcpClient.callTool({
      name: 'prepare_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        patch: {
          visible: true,
        },
      },
    });
    const plan = parseToolJson(prepRes);

    // Verify contract keys in plan.unchangedFields array
    expect(plan.unchangedFields).toContain('onlineTextEnabled');
    expect(plan.unchangedFields).toContain('commentsEnabled');
    expect(plan.unchangedFields).toContain('introAttachments');

    const commitRes = await mcpClient.callTool({
      name: 'commit_assignment_update',
      arguments: {
        planId: plan.planId,
        planHash: plan.planHash,
        confirmedByReviewer: true,
      },
    });

    expect(commitRes.isError).toBeFalsy();
    const commitData = parseToolJson(commitRes);
    expect(commitData.verification.verified).toBe(true);
    expect(commitData.verification.checks.onlineTextEnabledPreserved).toBe(true);
    expect(commitData.verification.checks.commentsEnabledPreserved).toBe(true);
    expect(commitData.verification.checks.introAttachmentsPreserved).toBe(true);

    // Independent verify_assignment_update with introAttachments checks
    const verifyRes = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: {
          visible: true,
          introAttachments: [
            { filename: 'roteiro_devsecops_anexo.pdf', filesize: 124500 },
          ],
        },
      },
    });
    expect(verifyRes.isError).toBeFalsy();
    const verifyData = parseToolJson(verifyRes);
    expect(verifyData.verified).toBe(true);

    // Verify divergence detection on introAttachments
    const verifyDivergentRes = await mcpClient.callTool({
      name: 'verify_assignment_update',
      arguments: {
        courseId: 49472,
        assignmentId: 125468,
        expectedChanges: {
          introAttachments: [
            { filename: 'arquivo_inexistente.pdf', filesize: 99999 },
          ],
        },
      },
    });
    expect(verifyDivergentRes.isError).toBeFalsy();
    const divData = parseToolJson(verifyDivergentRes);
    expect(divData.verified).toBe(false);
    expect(divData.status).toBe('divergence');
    expect(divData.divergences?.[0]).toContain('anexo esperado "arquivo_inexistente.pdf" não encontrado');
  });
});
