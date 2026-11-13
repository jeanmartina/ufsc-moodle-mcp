import fs from 'node:fs';
import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  MoodleClient,
  type MoodleConfig,
  htmlToText,
  stripTokenFromUrl,
  computeFileKey,
  type ExtractedFileResult,
} from './moodle.js';
import { sanitizeFilenames } from './file-store.js';
import { getOrCreateGroupManager, MoodleGroupError } from './group-manager.js';
import {
  buildAssignmentConsolidatedData,
  fetchSubmissionComments,
  getAssignmentGradingOverview,
  parseStatusSubmissionGroupId,
  sanitizeMemberEvalForOutput,
  sanitizeMemberForOutput,
  sha256Text,
} from './assignment-resolver.js';
import {
  getOrCreateGradingBatchManager,
  MoodleGradingError,
  type NotificationPolicyOption,
  type PublicationStateOption,
} from './grading-batch.js';
import {
  getOrCreateResourceManager,
  MoodleResourceError,
} from './resource-manager.js';
import {
  getOrCreateAssignmentManager,
  MoodleAssignmentError,
} from './assignment-manager.js';
import { withOperationMetrics } from './request-context.js';

export const SERVER_VERSION = '1.4.1';
export const MCP_PROTOCOL_VERSION = '2025-03-26';

export const REGISTERED_TOOL_NAMES = [
  'get_moodle_capabilities',
  'get_site_info',
  'get_courses',
  'get_course_contents',
  'get_students',
  'get_assignments',
  'get_submissions',
  'get_submission_content',
  'download_moodle_file',
  'read_moodle_file',
  'get_assignment_grading_overview',
  'prepare_grading_batch',
  'commit_grading_batch',
  'verify_grading_batch',
  'provide_feedback',
  'get_quizzes',
  'get_quiz_grade',
  'send_message',
  'get_messages',
  'get_forums',
  'get_forum_discussions',
  'post_forum_discussion',
  'get_course_groups',
  'get_group_members',
  'create_course_group',
  'add_group_member',
  'remove_group_member',
  'create_group_with_members',
  'replace_course_resource_file',
  'verify_course_resource_file',
  'get_assignment_details',
  'prepare_assignment_update',
  'commit_assignment_update',
  'verify_assignment_update',
] as const;

function jsonResponse(data: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data as any,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResponse(error: unknown, client?: MoodleClient): CallToolResult {
  const message = client
    ? client.sanitizeErrorMessage(error)
    : error instanceof Error
      ? error.message
      : String(error);

  if (
    error instanceof MoodleGroupError ||
    error instanceof MoodleGradingError ||
    error instanceof MoodleResourceError ||
    error instanceof MoodleAssignmentError
  ) {
    const errorBody = {
      status: 'failed',
      errorCode: error.code,
      errorMessage: message,
      ...(error.details ? error.details : {}),
    };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(errorBody, null, 2),
        },
      ],
      structuredContent: errorBody,
      isError: true,
    };
  }

  const fallbackBody = {
    status: 'failed',
    errorCode: 'internal_error',
    errorMessage: message,
  };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(fallbackBody, null, 2),
      },
    ],
    structuredContent: fallbackBody,
    isError: true,
  };
}

function formatDate(unixSeconds: number | undefined | null): string | null {
  if (!unixSeconds || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

interface RawPluginFile {
  filename: string;
  fileurl: string;
  filesize?: number;
  mimetype?: string;
  timemodified?: number;
}

function extractPluginsPayload(plugins: any[] | undefined): {
  onlineTexts: string[];
  files: RawPluginFile[];
} {
  const onlineTexts: string[] = [];
  const files: RawPluginFile[] = [];

  for (const plugin of plugins || []) {
    if (plugin.type === 'onlinetext') {
      for (const ef of plugin.editorfields || []) {
        const cleaned = htmlToText(ef.text);
        if (cleaned) onlineTexts.push(cleaned);
      }
    }
    if (plugin.type === 'file') {
      for (const fa of plugin.fileareas || []) {
        for (const f of fa.files || []) {
          if (f?.fileurl) {
            files.push({
              filename: String(f.filename || 'arquivo'),
              fileurl: stripTokenFromUrl(String(f.fileurl)),
              filesize: f.filesize !== undefined ? Number(f.filesize) : undefined,
              mimetype: f.mimetype ? String(f.mimetype) : undefined,
              timemodified: f.timemodified !== undefined ? Number(f.timemodified) : undefined,
            });
          }
        }
      }
    }
  }

  return { onlineTexts, files };
}

export function createServer(config?: MoodleConfig, sharedClient?: MoodleClient): McpServer {
  const client = sharedClient ?? new MoodleClient(config);
  const groupManager = getOrCreateGroupManager(client);
  const gradingBatchManager = getOrCreateGradingBatchManager(client);
  const resourceManager = getOrCreateResourceManager(client, config);
  const assignmentManager = getOrCreateAssignmentManager(client, config);

  const server = new McpServer(
    {
      name: 'ufsc-moodle-mcp',
      title: 'UFSC Moodle MCP Server',
      description:
        'Integração segura v1.4.1 para o Moodle da UFSC: consulta completa e segura de tarefas mod_assign (get_assignment_details), fluxo auditado em duas etapas de preparação e alteração (prepare_assignment_update / commit_assignment_update) com verificação pós-escrita (verify_assignment_update) para enunciado, prazos independentes (dueDate vs cutoffDate), visibilidade e arquivos de entrega (.pdf, .zip), resolução determinística de grupos de projeto, OCR local com layout estruturado, download binário preservado e atualização verificada de arquivos didáticos mod_resource.',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
      },
      instructions:
        'Use get_moodle_capabilities para inspecionar ferramentas expostas, limites, OCR e capacidades do servidor v1.4.1. ' +
        'Para gerenciar tarefas (mod_assign): (1) Chame get_assignment_details(courseId, assignmentId) para leitura completa (enunciado, status do enunciado, datas com timezone, visibilidade de módulo e seção e limites de arquivos de entrega); ' +
        '(2) Prepare a alteração com prepare_assignment_update (gera diff legível, hash criptográfico e validações sem escrever no Moodle); ' +
        '(3) Aplique o plano aprovado com commit_assignment_update (exige planId, planHash e confirmedByReviewer=true; detecta concorrência e grava via controlador oficial); ' +
        '(4) Valide o resultado com verify_assignment_update. ' +
        'Para avaliar tarefas em lote: use get_assignment_grading_overview, prepare_grading_batch, commit_grading_batch e verify_grading_batch. ' +
        'Para materiais didáticos: use replace_course_resource_file e verify_course_resource_file.',
    }
  );

  // Register MCP Resource Template for binary retrieval via `resources/read`
  server.registerResource(
    'moodle-downloaded-file',
    new ResourceTemplate('moodle-file://{fileId}/{filename}', {
      list: async () => {
        const entries = client.fileStore.listActiveEntries();
        return {
          resources: entries.map((entry) => ({
            uri: `moodle-file://${entry.fileId}/${encodeURIComponent(entry.safeFilename)}`,
            name: entry.originalFilename,
            mimeType: entry.mimeType,
            description: `Arquivo original do Moodle (${entry.sizeBytes} bytes, SHA-256 ${entry.sha256}, expira em ${new Date(entry.expiresAtMs).toISOString()})`,
          })),
        };
      },
    }),
    {
      title: 'Arquivo Original Baixado do Moodle',
      description:
        'Entrega binária (blob base64 no protocolo MCP) de arquivos baixados via download_moodle_file, read_moodle_file ou get_submission_content.',
      mimeType: 'application/octet-stream',
    },
    async (uri, variables) => {
      const fileId = String(variables.fileId || '');
      const entry = client.fileStore.getByFileId(fileId);
      if (!entry) {
        throw new ResourceNotFoundError(uri.href);
      }
      const bytes = await fs.promises.readFile(entry.diskPath);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: entry.mimeType,
            blob: bytes.toString('base64'),
          },
        ],
      };
    }
  );

  // 1. get_site_info
  server.registerTool(
    'get_site_info',
    {
      title: 'Informações da conta e do Moodle',
      description:
        'Retorna informações do usuário autenticado (userid, nome completo, username) e da instância do Moodle da UFSC.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const info = await client.getSiteInfo();
        return jsonResponse({
          userid: info.userid,
          fullname: info.fullname,
          username: info.username,
          firstname: info.firstname,
          lastname: info.lastname,
          sitename: info.sitename,
          siteurl: info.siteurl,
          release: info.release,
          defaultCourseId: client.getDefaultCourseId() ?? null,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 2. get_courses
  server.registerTool(
    'get_courses',
    {
      title: 'Listar disciplinas do professor/usuário',
      description:
        'Lista todas as disciplinas (cursos) em que o usuário está inscrito ou leciona no Moodle da UFSC. Permite filtrar por código/nome/semestre (ex: "20262" ou "INE5429") ou buscar um courseId específico.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID específico de uma disciplina para consultar detalhes.'),
        search: z
          .string()
          .optional()
          .describe(
            'Termo opcional para filtrar disciplinas pelo nome ou código (ex: "20262", "INE5429", "Segurança").'
          ),
        onlyVisible: z
          .boolean()
          .optional()
          .describe('Se true, retorna apenas disciplinas visíveis.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Número máximo de disciplinas retornadas (padrão: 50).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ courseId, search, onlyVisible, limit = 50 }) => {
      try {
        const info = await client.getSiteInfo();
        const rawCourses = await client.call<any[]>('core_enrol_get_users_courses', {
          userid: info.userid,
        });

        let courses = Array.isArray(rawCourses) ? rawCourses : [];
        if (courseId !== undefined) {
          courses = courses.filter((c) => c.id === courseId);
        }
        if (onlyVisible) {
          courses = courses.filter((c) => c.visible !== 0);
        }
        if (search && search.trim()) {
          const q = search.trim().toLowerCase();
          courses = courses.filter(
            (c) =>
              String(c.fullname || '').toLowerCase().includes(q) ||
              String(c.shortname || '').toLowerCase().includes(q) ||
              String(c.id).includes(q)
          );
        }

        courses.sort((a, b) => (b.startdate || b.id || 0) - (a.startdate || a.id || 0));

        const formatted = courses.slice(0, limit).map((c) => ({
          id: c.id,
          shortname: c.shortname,
          fullname: c.fullname,
          visible: Boolean(c.visible),
          startdate: formatDate(c.startdate),
          enddate: formatDate(c.enddate),
          enrolledusercount: c.enrolledusercount,
          summary: htmlToText(c.summary) || undefined,
        }));

        return jsonResponse({
          totalFound: courses.length,
          returned: formatted.length,
          courses: formatted,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 3. get_course_contents
  server.registerTool(
    'get_course_contents',
    {
      title: 'Listar tópicos, materiais e atividades da disciplina',
      description:
        'Retorna todas as seções/tópicos, materiais (arquivos PDF, slides, links) e atividades (tarefas, fóruns, questionários) de uma disciplina. As URLs de arquivos retornadas podem ser baixadas via download_moodle_file ou lidas via read_moodle_file.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle (use get_courses para descobrir).'),
        sectionNumber: z
          .number()
          .int()
          .optional()
          .describe('Filtra apenas uma seção específica pelo número da seção (0, 1, 2...).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ courseId, sectionNumber }) => {
      try {
        const resolvedCourseId = client.resolveCourseId(courseId);
        const sections = await client.call<any[]>('core_course_get_contents', {
          courseid: resolvedCourseId,
        });

        let filtered = Array.isArray(sections) ? sections : [];
        if (sectionNumber !== undefined) {
          filtered = filtered.filter((s) => s.section === sectionNumber);
        }

        const formatted = filtered.map((sec) => ({
          id: sec.id,
          section: sec.section,
          name: sec.name,
          visible: Boolean(sec.visible),
          summary: htmlToText(sec.summary) || undefined,
          modules: (sec.modules || []).map((m: any) => ({
            id: m.id,
            instance: m.instance,
            name: m.name,
            modname: m.modname,
            modplural: m.modplural,
            url: m.url,
            visible: Boolean(m.visible),
            description: htmlToText(m.description) || undefined,
            contents: (m.contents || []).map((ct: any) => {
              const cleanUrl = ct.fileurl ? stripTokenFromUrl(String(ct.fileurl)) : undefined;
              return {
                type: ct.type,
                filename: ct.filename ? sanitizeFilenames(String(ct.filename)).originalFilename : undefined,
                filesize: ct.filesize,
                mimetype: ct.mimetype,
                fileurl: cleanUrl,
                ...(cleanUrl ? { fileKey: computeFileKey(cleanUrl) } : {}),
                timemodified: formatDate(ct.timemodified),
              };
            }),
          })),
        }));

        return jsonResponse({
          courseId: resolvedCourseId,
          sectionCount: formatted.length,
          sections: formatted,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 4. get_students
  server.registerTool(
    'get_students',
    {
      title: 'Listar estudantes/participantes da disciplina',
      description:
        'Lista os participantes inscritos em uma disciplina (alunos, professores, monitores) com nome, e-mail, papéis (roles) e grupos.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle.'),
        search: z
          .string()
          .optional()
          .describe('Filtro opcional por nome, matrícula/username ou e-mail.'),
        role: z
          .string()
          .optional()
          .describe(
            'Filtra pelo shortname do papel (ex: "student" para apenas alunos, "editingteacher" para professores).'
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ courseId, search, role }) => {
      try {
        const resolvedCourseId = client.resolveCourseId(courseId);
        const users = await client.call<any[]>('core_enrol_get_enrolled_users', {
          courseid: resolvedCourseId,
        });

        let list = Array.isArray(users) ? users : [];
        if (role && role.trim()) {
          const rLower = role.trim().toLowerCase();
          list = list.filter((u) =>
            (u.roles || []).some(
              (r: any) =>
                String(r.shortname || '').toLowerCase() === rLower ||
                String(r.name || '').toLowerCase().includes(rLower)
            )
          );
        }
        if (search && search.trim()) {
          const q = search.trim().toLowerCase();
          list = list.filter(
            (u) =>
              String(u.fullname || '').toLowerCase().includes(q) ||
              String(u.email || '').toLowerCase().includes(q) ||
              String(u.username || '').toLowerCase().includes(q) ||
              String(u.id).includes(q)
          );
        }

        const formatted = list.map((u) => ({
          id: u.id,
          fullname: u.fullname,
          email: u.email,
          username: u.username,
          lastcourseaccess: formatDate(u.lastcourseaccess),
          roles: (u.roles || []).map((r: any) => r.shortname || r.name),
          groups: (u.groups || []).map((g: any) => ({ id: g.id, name: g.name })),
        }));

        return jsonResponse({
          courseId: resolvedCourseId,
          count: formatted.length,
          participants: formatted,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 5. get_assignments
  server.registerTool(
    'get_assignments',
    {
      title: 'Listar tarefas/trabalhos da disciplina',
      description:
        'Lista todas as tarefas (assignments) de uma disciplina, incluindo enunciado, anexos do enunciado (baixáveis via download_moodle_file), configuração de entrega em grupo (teamsubmission), prazos e nota máxima.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ courseId }) => {
      try {
        const resolvedCourseId = client.resolveCourseId(courseId);
        const res = await client.call<any>('mod_assign_get_assignments', {
          courseids: [resolvedCourseId],
        });

        const courseEntry = res?.courses?.[0];
        const rawAssignments = courseEntry?.assignments || [];

        const assignments = rawAssignments.map((a: any) => ({
          id: a.id,
          cmid: a.cmid,
          course: a.course,
          name: a.name,
          duedate: formatDate(a.duedate),
          allowsubmissionsfromdate: formatDate(a.allowsubmissionsfromdate),
          cutoffdate: formatDate(a.cutoffdate),
          maxGrade: a.grade,
          teamsubmission: Boolean(a.teamsubmission),
          teamSubmissionGroupingId: Number(a.teamsubmissiongroupingid || 0),
          preventSubmissionNotInGroup: Boolean(a.preventsubmissionnotingroup),
          markingWorkflowEnabled: Boolean(a.markingworkflow),
          intro: htmlToText(a.intro) || undefined,
          introAttachments: (a.introattachments || []).map((f: any) => {
            const cleanUrl = f.fileurl ? stripTokenFromUrl(String(f.fileurl)) : undefined;
            return {
              filename: f.filename ? sanitizeFilenames(String(f.filename)).originalFilename : undefined,
              filesize: f.filesize,
              mimetype: f.mimetype,
              fileurl: cleanUrl,
              ...(cleanUrl ? { fileKey: computeFileKey(cleanUrl) } : {}),
            };
          }),
        }));

        return jsonResponse({
          courseId: resolvedCourseId,
          courseName: courseEntry?.fullname,
          count: assignments.length,
          assignments,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 6. get_submissions
  server.registerTool(
    'get_submissions',
    {
      title: 'Listar entregas dos alunos e grupos em uma tarefa',
      description:
        'Lista as entregas individuais e coletivas (userid=0) de uma tarefa ou disciplina, diferenciando grupos gerais de turma de grupos efetivos do projeto (assignmentGroupId / assignmentGroupMembers sem professores), e separando o estado bruto da linha coletiva no Moodle (rawMoodleGradingStatus) do estado real agregado das avaliações dos integrantes (aggregatedGradingStatus: not_graded | partially_graded | fully_graded | inconsistent, commonGroupGrade e memberEvaluations).',
      inputSchema: z.object({
        assignmentId: z
          .number()
          .int()
          .optional()
          .describe('ID da tarefa (obtido via get_assignments).'),
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina (opcional; resolvido automaticamente quando assignmentId é informado).'),
        studentId: z
          .number()
          .int()
          .optional()
          .describe(
            'Filtra a entrega de um aluno específico pelo ID do usuário, resolvendo apenas o grupo efetivo do trabalho (nunca o grupo geral da turma).'
          ),
        groupId: z
          .number()
          .int()
          .optional()
          .describe('Filtra entregas associadas a um grupo específico (groupid).'),
        onlySubmitted: z
          .boolean()
          .optional()
          .describe(
            'Se true (padrão), retorna apenas entregas efetivamente enviadas (status="submitted"), com arquivos/texto ou já avaliadas, omitindo registros vazios.'
          ),
        includeFeedback: z
          .boolean()
          .optional()
          .describe(
            'Se true, carrega também a presença e o texto de comentários de feedback (gradingFeedbackComments) de cada integrante.'
          ),
        includePersonalData: z
          .boolean()
          .optional()
          .describe('Se true (padrão: false), inclui e-mails pessoais dos estudantes.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      assignmentId,
      courseId,
      studentId,
      groupId,
      onlySubmitted = true,
      includeFeedback = false,
      includePersonalData = false,
    }) => {
      try {
        const { result, metrics } = await withOperationMetrics(async () => {
          let targetAssignmentIds: number[] = [];
          let effectiveCourseId = courseId ?? client.getDefaultCourseId();

          if (assignmentId) {
            targetAssignmentIds = [assignmentId];
          } else if (effectiveCourseId) {
            const assignRes = await client.call<any>('mod_assign_get_assignments', {
              courseids: [effectiveCourseId],
            });
            const list = assignRes?.courses?.[0]?.assignments || [];
            targetAssignmentIds = list.map((a: any) => Number(a.id));
          }

          if (targetAssignmentIds.length === 0) {
            throw new Error('Informe assignmentId ou courseId para consultar entregas.');
          }

          const assignmentResults = [];

          for (const aId of targetAssignmentIds) {
            const consolidated = await buildAssignmentConsolidatedData(client, aId, {
              courseId: effectiveCourseId,
              includeFeedback,
            });
            effectiveCourseId = consolidated.ctx.courseId;

            if (groupId !== undefined && consolidated.generalCourseGroupIds.has(groupId)) {
              throw new Error(
                `O grupo ${groupId} corresponde a um grupo geral da turma/disciplina (generalCourseGroupIds) e não a um grupo de trabalho da tarefa ${aId}.`
              );
            }

            const uniqueFileKeysInAssignment = new Set<string>();
            const submissionsOut: Record<string, unknown>[] = [];

            if (consolidated.ctx.assignment.teamsubmission) {
              // Resolve student filter deterministically without ever matching general turma groups
              let resolvedStudentGroupId: number | null | undefined;
              if (studentId !== undefined) {
                const sRes = consolidated.studentResolutions.get(studentId);
                if (sRes?.groupResolutionStatus === 'ambiguous') {
                  assignmentResults.push({
                    assignmentId: aId,
                    courseId: consolidated.ctx.courseId,
                    assignmentName: consolidated.ctx.assignment.name,
                    isTeamSubmission: true,
                    maxGrade: consolidated.ctx.assignment.maxGrade,
                    groupResolutionStatus: 'ambiguous',
                    ambiguousGroupCandidates: sRes.ambiguousGroupCandidates,
                    submissionCount: 0,
                    uniqueFilesCount: 0,
                    submissions: [],
                  });
                  continue;
                }
                resolvedStudentGroupId = sRes?.assignmentGroupId ?? null;
              }

              for (const gRec of consolidated.groupRecords.values()) {
                if (groupId !== undefined && gRec.assignmentGroupId !== groupId) continue;
                if (studentId !== undefined && gRec.assignmentGroupId !== resolvedStudentGroupId) {
                  continue;
                }

                const hasContent =
                  gRec.hasSubmitted ||
                  gRec.filesCount > 0 ||
                  Boolean(gRec.onlineText) ||
                  gRec.gradedMembersCount > 0;
                if (onlySubmitted && !hasContent) continue;

                const files = gRec.files.map((f) => {
                  uniqueFileKeysInAssignment.add(f.fileKey);
                  return {
                    filename: f.filename,
                    originalFilename: f.originalFilename,
                    filesize: f.filesize,
                    mimetype: f.mimetype,
                    fileurl: f.fileurl,
                    fileKey: f.fileKey,
                    sharedWithGroupId: gRec.assignmentGroupId,
                    timemodified: f.timemodified,
                  };
                });

                const cleanMembers = gRec.members.map((m) =>
                  sanitizeMemberForOutput(m, includePersonalData)
                );
                const memberGrades = gRec.memberEvaluations.map((me) => ({
                  userid: me.userId,
                  fullname: me.fullname,
                  grade: me.grade,
                }));

                const queriedStudentEval =
                  studentId !== undefined
                    ? gRec.memberEvaluations.find((me) => me.userId === studentId)
                    : undefined;
                const legacyGrade =
                  studentId !== undefined
                    ? (queriedStudentEval?.grade ?? null)
                    : (gRec.commonGroupGrade ??
                      gRec.memberEvaluations.find((me) => me.grade !== null)?.grade ??
                      null);

                submissionsOut.push({
                  submissionId: gRec.groupSubmissionId ?? 0,
                  groupSubmissionId: gRec.groupSubmissionId,
                  submissionScope: 'group',
                  userid: 0,
                  ...(studentId !== undefined ? { queriedStudentId: studentId } : {}),
                  studentName: gRec.assignmentGroupName,
                  // Definitive v1.2.0 group fields
                  assignmentGroupId: gRec.assignmentGroupId,
                  assignmentGroupName: gRec.assignmentGroupName,
                  assignmentGroupMembers: cleanMembers,
                  // Corrected legacy group fields
                  groupid: gRec.assignmentGroupId,
                  groupName: gRec.assignmentGroupName,
                  group: {
                    id: gRec.assignmentGroupId,
                    name: gRec.assignmentGroupName,
                    members: cleanMembers,
                  },
                  groupMembers: cleanMembers,
                  status: gRec.submissionStatus,
                  // Separated collective submission state vs aggregated student evaluation state
                  collectiveSubmissionState: {
                    submissionId: gRec.groupSubmissionId,
                    status: gRec.submissionStatus,
                    rawMoodleGradingStatus: gRec.rawCollectiveGradingStatus,
                  },
                  gradingstatus:
                    gRec.aggregatedGradingStatus === 'fully_graded'
                      ? 'graded'
                      : (gRec.rawCollectiveGradingStatus ?? 'notgraded'),
                  rawCollectiveGradingStatus: gRec.rawCollectiveGradingStatus,
                  aggregatedGradingStatus: gRec.aggregatedGradingStatus,
                  commonGroupGrade: gRec.commonGroupGrade,
                  hasGradeDivergence: gRec.hasGradeDivergence,
                  gradedMembersCount: gRec.gradedMembersCount,
                  totalMembersCount: gRec.memberCount,
                  workflowState: gRec.workflowState,
                  publicationState: gRec.publicationState,
                  allVisibleToStudents: gRec.allVisibleToStudents,
                  grade: legacyGrade,
                  memberGrades,
                  memberEvaluations: gRec.memberEvaluations.map((ev) =>
                    sanitizeMemberEvalForOutput(ev, {
                      includeGrades: true,
                      includeFeedback,
                      includeWorkflow: true,
                      includeVisibility: true,
                      includePersonalData,
                    })
                  ),
                  timemodified: gRec.submittedAt,
                  onlineTextPreview: gRec.onlineText ? gRec.onlineText.slice(0, 500) : undefined,
                  filesCount: files.length,
                  files,
                });
              }

              // Also check if a student without an assignment group submitted individually
              if (studentId !== undefined && !resolvedStudentGroupId) {
                const indSub = consolidated.individualSubmissionsByUserId.get(studentId);
                const ev = consolidated.memberEvaluationsByUserId.get(studentId);
                const sRes = consolidated.studentResolutions.get(studentId);
                if (indSub) {
                  const hasContent =
                    indSub.status === 'submitted' ||
                    indSub.files.length > 0 ||
                    Boolean(indSub.onlineText) ||
                    (ev?.numericGrade ?? null) !== null;
                  if (!onlySubmitted || hasContent) {
                    const files = indSub.files.map((f) => {
                      uniqueFileKeysInAssignment.add(f.fileKey);
                      return {
                        filename: f.filename,
                        originalFilename: f.originalFilename,
                        filesize: f.filesize,
                        mimetype: f.mimetype,
                        fileurl: f.fileurl,
                        fileKey: f.fileKey,
                        timemodified: f.timemodified,
                      };
                    });
                    submissionsOut.push({
                      submissionId: indSub.submissionId,
                      individualSubmissionId: indSub.submissionId,
                      submissionScope: 'individual',
                      userid: studentId,
                      studentName: sRes?.fullname,
                      ...(includePersonalData && sRes?.email ? { studentEmail: sRes.email } : {}),
                      assignmentGroupId: null,
                      assignmentGroupName: null,
                      assignmentGroupMembers: [],
                      status: indSub.status,
                      gradingstatus: ev?.numericGrade !== null ? 'graded' : (indSub.gradingstatus ?? 'notgraded'),
                      aggregatedGradingStatus:
                        ev?.numericGrade !== null ? 'fully_graded' : 'not_graded',
                      grade: ev?.grade ?? null,
                      timemodified: formatDate(indSub.timemodified),
                      onlineTextPreview: indSub.onlineText
                        ? indSub.onlineText.slice(0, 500)
                        : undefined,
                      filesCount: files.length,
                      files,
                    });
                  }
                }
              }
            } else {
              // Individual assignment
              for (const [uid, indSub] of consolidated.individualSubmissionsByUserId.entries()) {
                if (studentId !== undefined && uid !== studentId) continue;
                const sRes = consolidated.studentResolutions.get(uid);
                if (
                  groupId !== undefined &&
                  !(sRes?.courseGroupIds || []).includes(groupId)
                ) {
                  continue;
                }
                const ev = consolidated.memberEvaluationsByUserId.get(uid);
                const hasContent =
                  indSub.status === 'submitted' ||
                  indSub.files.length > 0 ||
                  Boolean(indSub.onlineText) ||
                  (ev?.numericGrade ?? null) !== null;
                if (onlySubmitted && !hasContent) continue;

                const files = indSub.files.map((f) => {
                  uniqueFileKeysInAssignment.add(f.fileKey);
                  return {
                    filename: f.filename,
                    originalFilename: f.originalFilename,
                    filesize: f.filesize,
                    mimetype: f.mimetype,
                    fileurl: f.fileurl,
                    fileKey: f.fileKey,
                    timemodified: f.timemodified,
                  };
                });

                submissionsOut.push({
                  submissionId: indSub.submissionId,
                  individualSubmissionId: indSub.submissionId,
                  submissionScope: 'individual',
                  userid: uid,
                  studentName: sRes?.fullname ?? consolidated.ctx.usersById.get(uid)?.fullname,
                  ...(includePersonalData && sRes?.email ? { studentEmail: sRes.email } : {}),
                  assignmentGroupId: null,
                  assignmentGroupName: null,
                  status: indSub.status,
                  gradingstatus:
                    ev?.numericGrade !== null ? 'graded' : (indSub.gradingstatus ?? 'notgraded'),
                  aggregatedGradingStatus:
                    ev?.numericGrade !== null ? 'fully_graded' : 'not_graded',
                  grade: ev?.grade ?? null,
                  ...(ev
                    ? {
                        evaluation: sanitizeMemberEvalForOutput(ev, {
                          includeGrades: true,
                          includeFeedback,
                          includeWorkflow: true,
                          includeVisibility: true,
                          includePersonalData,
                        }),
                      }
                    : {}),
                  timemodified: formatDate(indSub.timemodified),
                  onlineTextPreview: indSub.onlineText
                    ? indSub.onlineText.slice(0, 500)
                    : undefined,
                  filesCount: files.length,
                  files,
                });
              }
            }

            assignmentResults.push({
              assignmentId: aId,
              courseId: consolidated.ctx.courseId,
              assignmentName: consolidated.ctx.assignment.name,
              isTeamSubmission: consolidated.ctx.assignment.teamsubmission,
              teamSubmissionGroupingId: consolidated.ctx.assignment.teamsubmissiongroupingid,
              markingWorkflowEnabled: consolidated.ctx.assignment.markingworkflow,
              maxGrade: consolidated.ctx.assignment.maxGrade,
              generalCourseGroupIdsExcluded: Array.from(consolidated.generalCourseGroupIds).sort(
                (a, b) => a - b
              ),
              submissionCount: submissionsOut.length,
              uniqueFilesCount: uniqueFileKeysInAssignment.size,
              submissions: submissionsOut,
            });
          }

          return {
            assignments: assignmentResults,
          };
        });

        return jsonResponse({
          ...result,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 7. get_submission_content
  server.registerTool(
    'get_submission_content',
    {
      title: 'Ler conteúdo completo da entrega de um aluno ou grupo (com OCR automático opcional, layout visual e separação de comentários)',
      description:
        'Obtém os detalhes completos da entrega individual e/ou coletiva em grupo (teamsubmission / userid=0) em uma tarefa, resolvendo deterministicamente o grupo efetivo da tarefa (excluindo grupos gerais de turma como INE5458-08208), deduplicando arquivos por fileKey, suportando OCR automático local (ocrMode="auto"|"force"|"status") com blocos visuais posicionados e separando explicitamente submissionComments (comentários da entrega) de gradingFeedbackComments (comentários da avaliação).',
      inputSchema: z.object({
        assignmentId: z
          .number()
          .int()
          .describe('ID da tarefa (assignmentId).'),
        studentId: z
          .number()
          .int()
          .optional()
          .describe(
            'ID do aluno (userid) no Moodle. Em tarefas em grupo, resolve deterministicamente o grupo efetivo do projeto na tarefa.'
          ),
        groupId: z
          .number()
          .int()
          .optional()
          .describe(
            'ID do grupo de projeto da tarefa (assignmentGroupId) para consultar diretamente uma entrega coletiva (mesmo quando userid=0 em get_submissions).'
          ),
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional da disciplina (resolvido automaticamente caso omitido).'),
        extractFiles: z
          .boolean()
          .optional()
          .describe(
            'Se true (padrão), baixa os arquivos para o armazenamento temporário isolado (gerando downloadUrl e sha256) e executa extração textual (e OCR quando ocrMode="auto"|"force").'
          ),
        maxCharsPerFile: z
          .number()
          .int()
          .min(1000)
          .max(150000)
          .optional()
          .describe('Limite máximo de caracteres extraídos por arquivo (padrão: 45000).'),
        ocrMode: z
          .enum(['off', 'auto', 'force', 'status'])
          .optional()
          .describe(
            'Modo de OCR local no servidor: "off" (padrão compatível, apenas camada nativa), "auto" (tenta nativo e executa OCR local Poppler+Tesseract apenas nas páginas de imagem/sem texto), "force" (força OCR em todas as páginas até maxOcrPages) ou "status" (diagnostica necessidade e disponibilidade de OCR sem executá-lo).'
          ),
        ocrLanguages: z
          .array(z.string().min(2).max(16))
          .optional()
          .describe('Idiomas do Tesseract para OCR (padrão: ["eng", "por"]).'),
        maxOcrPages: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Limite máximo de páginas processadas via OCR por arquivo (padrão: 30).'),
        ocrTimeoutMs: z
          .number()
          .int()
          .min(500)
          .max(600000)
          .optional()
          .describe('Timeout máximo global em ms para o processamento OCR de cada arquivo (padrão proporcional: 120000).'),
        ocrPageTimeoutMs: z
          .number()
          .int()
          .min(500)
          .max(180000)
          .optional()
          .describe('Timeout individual por página em ms para o processamento OCR local (padrão: 60000).'),
        includeSubmissionComments: z
          .boolean()
          .optional()
          .describe(
            'Se true (padrão), consulta também comentários associados à entrega (assignsubmission_comments), separados de gradingFeedbackComments.'
          ),
        includeMemberEvaluations: z
          .boolean()
          .optional()
          .describe(
            'Se true (padrão), inclui o detalhamento individual das avaliações de todos os integrantes do grupo.'
          ),
        includePersonalData: z
          .boolean()
          .optional()
          .describe('Se true, inclui e-mail institucional dos estudantes nos metadados (padrão: false).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      assignmentId,
      studentId,
      groupId,
      courseId,
      extractFiles = true,
      maxCharsPerFile = 45000,
      ocrMode = 'off',
      ocrLanguages,
      maxOcrPages,
      ocrTimeoutMs,
      ocrPageTimeoutMs,
      includeSubmissionComments = true,
      includeMemberEvaluations = true,
      includePersonalData = false,
    }) => {
      try {
        const normalizedStudentId =
          studentId !== undefined && studentId > 0 ? studentId : undefined;
        const normalizedGroupId =
          groupId !== undefined && groupId > 0 ? groupId : undefined;

        if (normalizedStudentId === undefined && normalizedGroupId === undefined) {
          throw new Error(
            'Informe studentId (> 0) ou groupId (> 0) para consultar o conteúdo da entrega.'
          );
        }

        const { result: outPayload, metrics } = await withOperationMetrics(async () => {
          const consolidated = await buildAssignmentConsolidatedData(client, assignmentId, {
            courseId,
            includeFeedback: true,
          });
          const { ctx } = consolidated;

          if (
            normalizedGroupId !== undefined &&
            consolidated.generalCourseGroupIds.has(normalizedGroupId)
          ) {
            return {
              isError: true,
              body: {
                status: 'failed',
                errorCode: 'general_course_group_not_assignment_group',
                errorMessage: `O groupId ${normalizedGroupId} ("${consolidated.groupsById.get(normalizedGroupId)?.name || normalizedGroupId}") é um grupo geral de turma da disciplina, e NÃO um grupo de entrega da tarefa ${assignmentId}.`,
                assignmentId,
                courseId: ctx.courseId,
                generalCourseGroupIdsExcluded: Array.from(
                  consolidated.generalCourseGroupIds
                ).sort((a, b) => a - b),
              },
            };
          }

          const studentRes =
            normalizedStudentId !== undefined
              ? consolidated.studentResolutions.get(normalizedStudentId)
              : undefined;

          // Handle explicit multi-group ambiguity deterministically when groupId was NOT specified
          if (
            ctx.assignment.teamsubmission &&
            normalizedGroupId === undefined &&
            studentRes?.groupResolutionStatus === 'ambiguous'
          ) {
            return {
              isError: false,
              body: {
                assignmentId,
                courseId: ctx.courseId,
                assignmentName: ctx.assignment.name,
                isTeamSubmission: true,
                studentId: normalizedStudentId ?? null,
                student: {
                  id: studentRes.studentId,
                  fullname: studentRes.fullname,
                  ...(includePersonalData && studentRes.email ? { email: studentRes.email } : {}),
                },
                groupResolutionStatus: 'ambiguous' as const,
                assignmentGroupId: null,
                assignmentGroupName: null,
                assignmentGroupMembers: [],
                courseGroupIds: studentRes.courseGroupIds,
                generalCourseGroupIds: studentRes.generalCourseGroupIds,
                ambiguousGroupCandidates: studentRes.ambiguousGroupCandidates ?? [],
                groupId: null,
                individualSubmissionId:
                  consolidated.individualSubmissionsByUserId.get(studentRes.studentId)
                    ?.submissionId ?? null,
                groupSubmissionId: null,
                status: 'ambiguous_group',
                effectiveSubmissionSource: 'none' as const,
                individualHasFiles: false,
                groupHasFiles: false,
                filesCount: 0,
                filesNeedingOcrCount: 0,
                files: [],
                note: 'O estudante pertence a múltiplos grupos candidatos na tarefa. Informe groupId explicitamente para consultar a entrega do grupo desejado sem ambiguidade.',
              },
            };
          }

          // Resolve initial assignment group before checking mod_assign_get_submission_status
          let resolvedAssignmentGroupId: number | null = null;
          let groupResolutionStatus =
            studentRes?.groupResolutionStatus ??
            (ctx.assignment.teamsubmission
              ? normalizedGroupId !== undefined
                ? ('resolved' as const)
                : ('no_assignment_group' as const)
              : ('individual_assignment' as const));

          if (ctx.assignment.teamsubmission) {
            if (normalizedGroupId !== undefined) {
              resolvedAssignmentGroupId = normalizedGroupId;
              groupResolutionStatus = 'resolved';
            } else if (studentRes?.assignmentGroupId) {
              resolvedAssignmentGroupId = studentRes.assignmentGroupId;
              groupResolutionStatus = 'resolved';
            }
          }

          // Determine a valid student userid (> 0) for mod_assign_get_submission_status
          let statusQueryUserId = normalizedStudentId;
          if (!statusQueryUserId && resolvedAssignmentGroupId !== null) {
            const gRec = consolidated.groupRecords.get(resolvedAssignmentGroupId);
            const gInfo = consolidated.groupsById.get(resolvedAssignmentGroupId);
            statusQueryUserId = gRec?.members[0]?.id ?? gInfo?.members[0]?.id;
          }

          let statusData: any = null;
          if (statusQueryUserId) {
            try {
              statusData = await client.call<any>('mod_assign_get_submission_status', {
                assignid: assignmentId,
                userid: statusQueryUserId,
              });
            } catch {
              // Fallback to consolidated mod_assign_get_submissions data
            }
          }

          const parsedStatusGroup = parseStatusSubmissionGroupId(statusData);
          if (
            ctx.assignment.teamsubmission &&
            resolvedAssignmentGroupId === null &&
            parsedStatusGroup.submissionGroupId &&
            !consolidated.generalCourseGroupIds.has(parsedStatusGroup.submissionGroupId)
          ) {
            resolvedAssignmentGroupId = parsedStatusGroup.submissionGroupId;
            groupResolutionStatus = 'resolved';
          }

          const groupRecord =
            resolvedAssignmentGroupId !== null
              ? consolidated.groupRecords.get(resolvedAssignmentGroupId)
              : undefined;
          const groupInfo =
            resolvedAssignmentGroupId !== null
              ? consolidated.groupsById.get(resolvedAssignmentGroupId)
              : undefined;

          const resolvedAssignmentGroupName =
            resolvedAssignmentGroupId !== null
              ? groupRecord?.assignmentGroupName ||
                groupInfo?.name ||
                (parsedStatusGroup.submissionGroupId === resolvedAssignmentGroupId
                  ? parsedStatusGroup.submissionGroupName
                  : undefined) ||
                `Grupo ${resolvedAssignmentGroupId}`
              : null;

          const cleanGroupMembers = (
            groupRecord?.members ??
            groupInfo?.members ??
            studentRes?.assignmentGroupMembers ??
            []
          ).map((m) => sanitizeMemberForOutput(m, includePersonalData));

          interface SourcedRawFile extends RawPluginFile {
            fileKey: string;
            source: 'individual_submission' | 'group_submission';
            submissionId?: number;
            groupId?: number;
            groupName?: string;
          }

          const dedupedFiles = new Map<string, SourcedRawFile>();
          const onlineTextSet = new Set<string>();
          let individualHasFiles = false;
          let groupHasFiles = false;
          let primaryStatus: string | undefined;
          let primaryTimemodified: number | undefined;
          let individualSubmissionId: number | undefined;
          let groupSubmissionId: number | undefined;

          const addRawFiles = (
            items: RawPluginFile[],
            source: 'individual_submission' | 'group_submission',
            subId?: number,
            gid?: number | null
          ) => {
            const gName =
              gid && gid > 0
                ? gid === resolvedAssignmentGroupId && resolvedAssignmentGroupName
                  ? resolvedAssignmentGroupName
                  : consolidated.groupsById.get(gid)?.name || `Grupo ${gid}`
                : undefined;

            for (const item of items) {
              if (source === 'individual_submission') individualHasFiles = true;
              if (source === 'group_submission') groupHasFiles = true;

              const fileKey = computeFileKey(item.fileurl);
              const existing = dedupedFiles.get(fileKey);
              if (!existing) {
                dedupedFiles.set(fileKey, {
                  ...item,
                  fileKey,
                  source,
                  submissionId: subId,
                  ...(gid && gid > 0 ? { groupId: gid, groupName: gName } : {}),
                });
              } else if (source === 'group_submission' && existing.source !== 'group_submission') {
                existing.source = 'group_submission';
                if (gid && gid > 0) {
                  existing.groupId = gid;
                  existing.groupName = gName;
                }
                if (subId) existing.submissionId = subId;
              }
            }
          };

          // 1. Inspect individual & team submission from mod_assign_get_submission_status
          const indivSub = statusData?.lastattempt?.submission;
          if (indivSub && (normalizedStudentId === undefined || Number(indivSub.userid || normalizedStudentId) === normalizedStudentId)) {
            individualSubmissionId = indivSub.id ? Number(indivSub.id) : undefined;
            const { onlineTexts, files } = extractPluginsPayload(indivSub.plugins);
            for (const t of onlineTexts) onlineTextSet.add(t);
            const indivGid = Number(indivSub.groupid || 0);
            const isValidGroup =
              indivGid > 0 && !consolidated.generalCourseGroupIds.has(indivGid);
            addRawFiles(
              files,
              isValidGroup ? 'group_submission' : 'individual_submission',
              individualSubmissionId,
              isValidGroup ? indivGid : undefined
            );
            if (indivSub.status === 'submitted' || !primaryStatus) {
              primaryStatus = indivSub.status;
              primaryTimemodified = indivSub.timemodified;
            }
          }

          const teamSubFromStatus = statusData?.lastattempt?.teamsubmission;
          if (teamSubFromStatus) {
            const statusTeamGid =
              Number(teamSubFromStatus.groupid || 0) ||
              parsedStatusGroup.submissionGroupId ||
              resolvedAssignmentGroupId ||
              undefined;
            if (
              !statusTeamGid ||
              (!consolidated.generalCourseGroupIds.has(statusTeamGid) &&
                (resolvedAssignmentGroupId === null || statusTeamGid === resolvedAssignmentGroupId))
            ) {
              groupSubmissionId = teamSubFromStatus.id ? Number(teamSubFromStatus.id) : undefined;
              const { onlineTexts, files } = extractPluginsPayload(teamSubFromStatus.plugins);
              for (const t of onlineTexts) onlineTextSet.add(t);
              addRawFiles(files, 'group_submission', groupSubmissionId, statusTeamGid);
              if (teamSubFromStatus.status === 'submitted' || primaryStatus !== 'submitted') {
                primaryStatus = teamSubFromStatus.status || primaryStatus;
                primaryTimemodified = teamSubFromStatus.timemodified || primaryTimemodified;
              }
            }
          }

          // 2. Reconcile with consolidated submissions (authoritative userid=0 collective submission + individual submission)
          if (normalizedStudentId !== undefined) {
            const cInd = consolidated.individualSubmissionsByUserId.get(normalizedStudentId);
            if (cInd) {
              if (!individualSubmissionId && cInd.submissionId) {
                individualSubmissionId = cInd.submissionId;
              }
              if (cInd.onlineText) onlineTextSet.add(cInd.onlineText);
              addRawFiles(
                cInd.files.map((f) => ({
                  filename: f.filename,
                  fileurl: f.fileurl,
                  filesize: f.filesize,
                  mimetype: f.mimetype,
                })),
                'individual_submission',
                cInd.submissionId,
                undefined
              );
              if (cInd.status === 'submitted' || (!primaryStatus && cInd.status)) {
                primaryStatus = cInd.status;
                primaryTimemodified = cInd.timemodified ?? primaryTimemodified;
              }
            }
          }

          if (resolvedAssignmentGroupId !== null) {
            const cCol = consolidated.collectiveSubmissionsByGroupId.get(resolvedAssignmentGroupId);
            if (cCol) {
              if (!groupSubmissionId && cCol.submissionId) {
                groupSubmissionId = cCol.submissionId;
              }
              if (cCol.onlineText) onlineTextSet.add(cCol.onlineText);
              addRawFiles(
                cCol.files.map((f) => ({
                  filename: f.filename,
                  fileurl: f.fileurl,
                  filesize: f.filesize,
                  mimetype: f.mimetype,
                })),
                'group_submission',
                cCol.submissionId,
                resolvedAssignmentGroupId
              );
              if (cCol.status === 'submitted' || primaryStatus !== 'submitted') {
                primaryStatus = cCol.status || primaryStatus;
                primaryTimemodified = cCol.timemodified ?? primaryTimemodified;
              }
            }
          }

          const orderedFiles = Array.from(dedupedFiles.values());
          const extractedFiles: ExtractedFileResult[] = [];

          for (const f of orderedFiles) {
            if (extractFiles) {
              const extracted = await client.downloadAndExtractFile(f.fileurl, {
                filename: f.filename,
                mimetype: f.mimetype,
                maxChars: maxCharsPerFile,
                ocrMode,
                ocrLanguages,
                maxOcrPages,
                ocrTimeoutMs,
                ocrPageTimeoutMs,
              });
              extractedFiles.push({
                ...extracted,
                source: f.source,
                ...(f.submissionId ? { submissionId: f.submissionId } : {}),
                ...(f.groupId ? { groupId: f.groupId } : {}),
                ...(f.groupName ? { groupName: f.groupName } : {}),
              });
            } else {
              const { originalFilename, safeFilename } = sanitizeFilenames(f.filename);
              extractedFiles.push({
                filename: originalFilename,
                originalFilename,
                safeFilename,
                fileurl: f.fileurl,
                fileKey: f.fileKey,
                filesize: f.filesize,
                mimetype: f.mimetype,
                downloadStatus: 'not_downloaded',
                extractionStatus: 'not_attempted',
                extractionMethod: 'none',
                needsOcr: false,
                source: f.source,
                ...(f.submissionId ? { submissionId: f.submissionId } : {}),
                ...(f.groupId ? { groupId: f.groupId } : {}),
                ...(f.groupName ? { groupName: f.groupName } : {}),
              });
            }
          }

          // Extract feedback comments & feedback files from statusData + consolidated member evaluation
          const feedback = statusData?.feedback;
          let statusFeedbackComment: string | undefined;
          const feedbackFiles: any[] = [];
          for (const fp of feedback?.plugins || []) {
            if (fp.type === 'comments') {
              for (const ef of fp.editorfields || []) {
                const txt = htmlToText(ef.text);
                if (txt) statusFeedbackComment = txt;
              }
            }
            if (fp.type === 'file') {
              for (const fa of fp.fileareas || []) {
                for (const f of fa.files || []) {
                  if (f?.fileurl) {
                    const cleanUrl = stripTokenFromUrl(String(f.fileurl));
                    feedbackFiles.push({
                      filename: sanitizeFilenames(String(f.filename || 'feedback')).originalFilename,
                      fileurl: cleanUrl,
                      fileKey: computeFileKey(cleanUrl),
                      filesize: f.filesize,
                    });
                  }
                }
              }
            }
          }

          // Fetch submissionComments (assignsubmission_comments) strictly separated from gradingFeedbackComments!
          const submissionComments = includeSubmissionComments
            ? await fetchSubmissionComments(
                client,
                ctx.assignment.cmid,
                groupSubmissionId ?? individualSubmissionId
              )
            : undefined;

          const resolvedGroup =
            resolvedAssignmentGroupId !== null && resolvedAssignmentGroupName !== null
              ? {
                  id: resolvedAssignmentGroupId,
                  name: resolvedAssignmentGroupName,
                  members: cleanGroupMembers,
                }
              : undefined;

          const studentMeta = normalizedStudentId
            ? ctx.usersById.get(normalizedStudentId)
            : undefined;

          const effectiveSubmissionSource:
            | 'group_submission'
            | 'individual_submission'
            | 'both'
            | 'none' =
            individualHasFiles && groupHasFiles
              ? 'both'
              : groupHasFiles
                ? 'group_submission'
                : individualHasFiles
                  ? 'individual_submission'
                  : onlineTextSet.size > 0
                    ? resolvedGroup && ctx.assignment.teamsubmission
                      ? 'group_submission'
                      : 'individual_submission'
                    : 'none';

          const onlineText = Array.from(onlineTextSet).join('\n\n') || undefined;

          const evaluatedUserEval = statusQueryUserId
            ? consolidated.memberEvaluationsByUserId.get(statusQueryUserId)
            : undefined;
          const effectiveFeedbackComment =
            statusFeedbackComment ?? evaluatedUserEval?.gradingFeedbackComment ?? undefined;

          const currentEvaluation =
            feedback || evaluatedUserEval
              ? {
                  evaluatedUserId: statusQueryUserId ?? null,
                  grade: feedback?.grade?.grade ?? evaluatedUserEval?.grade ?? null,
                  numericGrade: evaluatedUserEval?.numericGrade ?? null,
                  gradeForDisplay:
                    htmlToText(feedback?.gradefordisplay) ||
                    evaluatedUserEval?.gradeForDisplay ||
                    undefined,
                  gradedDate:
                    formatDate(feedback?.gradeddate) ?? evaluatedUserEval?.gradedAt ?? null,
                  graderUserId: evaluatedUserEval?.graderUserId ?? null,
                  ...(evaluatedUserEval?.graderName
                    ? { graderName: evaluatedUserEval.graderName }
                    : {}),
                  workflowState: evaluatedUserEval?.workflowState ?? null,
                  publicationState: evaluatedUserEval?.publicationState ?? 'not_graded',
                  visibleToStudents: evaluatedUserEval?.visibleToStudents ?? false,
                  gradingFeedbackComment: effectiveFeedbackComment ?? null,
                  gradingFeedbackSha256: sha256Text(effectiveFeedbackComment),
                  feedbackComment: effectiveFeedbackComment,
                  feedbackFiles: feedbackFiles.length > 0 ? feedbackFiles : undefined,
                }
              : null;

          const memberEvalsList =
            includeMemberEvaluations && groupRecord
              ? groupRecord.memberEvaluations.map((ev) =>
                  sanitizeMemberEvalForOutput(ev, {
                    includeGrades: true,
                    includeFeedback: true,
                    includeWorkflow: true,
                    includeVisibility: true,
                    includePersonalData,
                  })
                )
              : undefined;

          const gradingFeedbackComments = groupRecord
            ? {
                commentType: 'assignfeedback_comments' as const,
                membersWithFeedbackCount: groupRecord.membersWithFeedbackCount,
                totalMembersCount: groupRecord.memberCount,
                sharedFeedbackComment:
                  effectiveFeedbackComment ??
                  groupRecord.memberEvaluations.find((m) => m.gradingFeedbackComment)
                    ?.gradingFeedbackComment ??
                  null,
                byStudent: groupRecord.memberEvaluations.map((m) => ({
                  userId: m.userId,
                  fullname: m.fullname,
                  hasComment: m.hasGradingFeedbackComment,
                  gradingFeedbackComment: m.gradingFeedbackComment,
                  sha256: m.gradingFeedbackSha256,
                })),
              }
            : {
                commentType: 'assignfeedback_comments' as const,
                hasComment: Boolean(effectiveFeedbackComment),
                gradingFeedbackComment: effectiveFeedbackComment ?? null,
                sha256: sha256Text(effectiveFeedbackComment),
              };

          const courseGroupIds =
            studentRes?.courseGroupIds ??
            (resolvedAssignmentGroupId !== null ? [resolvedAssignmentGroupId] : []);
          const studentGeneralGroupIds =
            studentRes?.generalCourseGroupIds ??
            Array.from(consolidated.generalCourseGroupIds).sort((a, b) => a - b);

          return {
            isError: false,
            body: {
              assignmentId,
              courseId: ctx.courseId,
              assignmentName: ctx.assignment.name,
              isTeamSubmission:
                Boolean(ctx.assignment.teamsubmission) || Boolean(teamSubFromStatus),
              teamSubmissionGroupingId: ctx.assignment.teamsubmissiongroupingid,
              markingWorkflowEnabled: ctx.assignment.markingworkflow,
              studentId: normalizedStudentId ?? null,
              ...(studentMeta
                ? {
                    student: {
                      id: studentMeta.id,
                      fullname: studentMeta.fullname,
                      ...(includePersonalData && studentMeta.email
                        ? { email: studentMeta.email }
                        : {}),
                    },
                  }
                : {}),
              // Definitive v1.2.0 group resolution fields
              groupResolutionStatus,
              assignmentGroupId: resolvedGroup?.id ?? null,
              assignmentGroupName: resolvedGroup?.name ?? null,
              assignmentGroupMembers: cleanGroupMembers,
              courseGroupIds,
              generalCourseGroupIds: studentGeneralGroupIds,
              // Corrected legacy group fields
              groupId: resolvedGroup?.id ?? null,
              ...(resolvedGroup ? { group: resolvedGroup } : {}),
              individualSubmissionId,
              groupSubmissionId,
              status: primaryStatus ?? 'unknown',
              effectiveSubmissionSource,
              individualHasFiles,
              groupHasFiles,
              // Separated collective submission state vs aggregated grading state
              ...(groupRecord
                ? {
                    collectiveSubmissionState: {
                      submissionId: groupRecord.groupSubmissionId,
                      status: groupRecord.submissionStatus,
                      rawMoodleGradingStatus: groupRecord.rawCollectiveGradingStatus,
                    },
                    aggregatedGradingStatus: groupRecord.aggregatedGradingStatus,
                    commonGroupGrade: groupRecord.commonGroupGrade,
                    hasGradeDivergence: groupRecord.hasGradeDivergence,
                  }
                : {
                    aggregatedGradingStatus:
                      evaluatedUserEval?.numericGrade !== null && evaluatedUserEval !== undefined
                        ? 'fully_graded'
                        : 'not_graded',
                  }),
              gradingstatus:
                statusData?.lastattempt?.gradingstatus ??
                (groupRecord?.aggregatedGradingStatus === 'fully_graded'
                  ? 'graded'
                  : (groupRecord?.rawCollectiveGradingStatus ?? undefined)),
              timemodified: formatDate(primaryTimemodified),
              onlineText,
              filesCount: extractedFiles.length,
              filesNeedingOcrCount: extractedFiles.filter((f) => f.needsOcr).length,
              files: extractedFiles,
              ...(submissionComments ? { submissionComments } : {}),
              gradingFeedbackComments,
              currentEvaluation,
              ...(memberEvalsList ? { memberEvaluations: memberEvalsList } : {}),
            },
          };
        });

        return jsonResponse(
          {
            ...outPayload.body,
            metrics,
          },
          outPayload.isError
        );
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 8. download_moodle_file
  server.registerTool(
    'download_moodle_file',
    {
      title: 'Baixar arquivo original do Moodle (entrega acessível ao agente)',
      description:
        'Baixa os bytes originais preservados de um arquivo do Moodle (submissões individuais ou em grupo, anexos de enunciados e materiais da disciplina) reutilizando a autenticação da integração, sem depender de navegador e sem converter/substituir o PDF por texto. Retorna metadados verificados (fileId, tamanho, MIME, SHA-256, validade), downloadUrl temporária autenticada por token de capacidade e resourceUri MCP.',
      inputSchema: z.object({
        fileurl: z
          .string()
          .min(1)
          .describe(
            'URL do arquivo retornada pelas ferramentas do Moodle (pluginfile.php, webservice/pluginfile.php ou draftfile.php).'
          ),
        filename: z
          .string()
          .optional()
          .describe(
            'Nome opcional do arquivo (preserva espaços/acentos em originalFilename e gera safeFilename sanitizado).'
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(300000)
          .optional()
          .describe('Timeout máximo do download em milissegundos (padrão: 60000).'),
        maxBytes: z
          .number()
          .int()
          .min(1024)
          .optional()
          .describe('Limite máximo opcional em bytes para este download.'),
        forceDownload: z
          .boolean()
          .optional()
          .describe(
            'Se true, força novo download do Moodle mesmo se o arquivo ainda estiver válido no cache temporário.'
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileurl, filename, timeoutMs, maxBytes, forceDownload }) => {
      try {
        const { result: outcome, metrics } = await withOperationMetrics(async () =>
          client.downloadFile(fileurl, {
            filename,
            timeoutMs,
            maxBytes,
            forceDownload,
          })
        );

        if (!outcome.ok) {
          return jsonResponse(
            {
              status: 'failed',
              errorCode: outcome.errorCode,
              errorMessage: outcome.errorMessage,
              ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}),
              fileurl: outcome.canonicalFileUrl,
              metrics,
            },
            true
          );
        }

        const ref = outcome.file;
        return jsonResponse({
          status: 'downloaded',
          reusedCachedFile: Boolean(outcome.reusedCachedFile),
          fileId: ref.fileId,
          ...(ref.downloadUrl ? { downloadUrl: ref.downloadUrl } : {}),
          resourceUri: ref.resourceUri,
          ...(ref.savedPath ? { savedPath: ref.savedPath } : {}),
          originalFilename: ref.originalFilename,
          safeFilename: ref.safeFilename,
          mimeType: ref.mimeType,
          ...(ref.declaredMimeType ? { declaredMimeType: ref.declaredMimeType } : {}),
          sizeBytes: ref.sizeBytes,
          sha256: ref.sha256,
          expiresAt: ref.expiresAt,
          ttlSeconds: ref.ttlSeconds,
          canonicalFileUrl: outcome.canonicalFileUrl,
          fileKey: computeFileKey(outcome.canonicalFileUrl),
          delivery: {
            ...(ref.downloadUrl ? { httpGetUrl: ref.downloadUrl } : {}),
            mcpResourceUri: ref.resourceUri,
            ...(ref.savedPath ? { localSavedPath: ref.savedPath } : {}),
            instructions: ref.downloadUrl
              ? `Baixe os bytes originais diretamente no seu ambiente via HTTP GET em downloadUrl (ex.: curl -fsSL "${ref.downloadUrl}" -o "${ref.safeFilename}") sem precisar de cookies ou token do Moodle, e valide sizeBytes (${ref.sizeBytes}) e sha256 (${ref.sha256}). Alternativamente, leia resourceUri via MCP resources/read ou reprocesse via read_moodle_file informando fileId="${ref.fileId}" com ocrMode="auto".`
              : `Leia os bytes originais via MCP resources/read usando resourceUri (${ref.resourceUri}) ou reprocesse com OCR usando read_moodle_file(fileId="${ref.fileId}", ocrMode="auto").`,
          },
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 9. read_moodle_file
  server.registerTool(
    'read_moodle_file',
    {
      title: 'Ler e extrair texto/layout visual de arquivo do Moodle (com OCR local automático opcional)',
      description:
        'Lê qualquer arquivo autorizado do Moodle (por fileurl ou reutilizando fileId já baixado em TempFileStore sem novo download), preservando o arquivo original via downloadUrl/resourceUri e extraindo texto nativo (PDF, DOCX, ODT, PPTX, ZIP, código) ou executando OCR local automático no servidor (ocrMode="auto"|"force"|"status" via Poppler pdftoppm + Tesseract) com blocos visuais posicionados (coordenadas, região na página, confiança e ordem de leitura).',
      inputSchema: z.object({
        fileurl: z
          .string()
          .min(1)
          .optional()
          .describe(
            'URL do arquivo no Moodle (pluginfile.php ou webservice/pluginfile.php). Opcional quando fileId válido for informado.'
          ),
        fileId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'ID temporário retornado anteriormente por download_moodle_file, read_moodle_file ou get_submission_content para reprocessar o arquivo (ex: com ocrMode="auto") sem baixá-lo novamente do Moodle.'
          ),
        filename: z
          .string()
          .optional()
          .describe('Nome opcional do arquivo para auxiliar na detecção de formato.'),
        maxChars: z
          .number()
          .int()
          .min(1000)
          .max(200000)
          .optional()
          .describe('Limite máximo de caracteres a extrair (padrão: 60000).'),
        ocrMode: z
          .enum(['off', 'auto', 'force', 'status'])
          .optional()
          .describe(
            'Modo de OCR local no servidor: "off" (padrão compatível, apenas texto nativo), "auto" (usa texto nativo quando suficiente e aplica OCR local apenas nas páginas de imagem/sem camada textual), "force" (força OCR em todas as páginas até maxOcrPages) ou "status" (apenas diagnostica necessidade e suporte de OCR).'
          ),
        ocrLanguages: z
          .array(z.string().min(2).max(16))
          .optional()
          .describe('Idiomas do Tesseract para OCR (padrão: ["eng", "por"]).'),
        maxOcrPages: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Limite máximo de páginas processadas via OCR (padrão: 30).'),
        ocrTimeoutMs: z
          .number()
          .int()
          .min(500)
          .max(600000)
          .optional()
          .describe('Timeout máximo global em ms para o processamento OCR local (padrão proporcional: 120000).'),
        ocrPageTimeoutMs: z
          .number()
          .int()
          .min(500)
          .max(180000)
          .optional()
          .describe('Timeout individual por página em ms para o processamento OCR local (padrão: 60000).'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(300000)
          .optional()
          .describe('Timeout opcional em milissegundos para o download no Moodle.'),
        maxBytes: z
          .number()
          .int()
          .min(1024)
          .optional()
          .describe('Limite máximo opcional em bytes para o download.'),
        forceDownload: z
          .boolean()
          .optional()
          .describe('Se true, força novo download do Moodle quando fileurl é informado.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      fileurl,
      fileId,
      filename,
      maxChars = 60000,
      ocrMode = 'off',
      ocrLanguages,
      maxOcrPages,
      ocrTimeoutMs,
      ocrPageTimeoutMs,
      timeoutMs,
      maxBytes,
      forceDownload,
    }) => {
      try {
        if (!fileurl && !fileId) {
          return jsonResponse(
            {
              status: 'failed',
              downloadStatus: 'failed',
              extractionStatus: 'not_attempted',
              errorCode: 'invalid_url',
              errorMessage: 'Informe fileurl ou fileId para ler o arquivo.',
            },
            true
          );
        }

        const { result, metrics } = await withOperationMetrics(async () => {
          if (fileId && !forceDownload) {
            const byId = await client.extractByFileId(fileId, {
              maxChars,
              ocrMode,
              ocrLanguages,
              maxOcrPages,
              ocrTimeoutMs,
              ocrPageTimeoutMs,
            });
            if (byId.downloadStatus === 'downloaded' || !fileurl) {
              return byId;
            }
          }
          return client.downloadAndExtractFile(fileurl!, {
            filename,
            maxChars,
            timeoutMs,
            maxBytes,
            forceDownload,
            ocrMode,
            ocrLanguages,
            maxOcrPages,
            ocrTimeoutMs,
            ocrPageTimeoutMs,
          });
        });

        return jsonResponse(
          {
            ...result,
            metrics,
          },
          result.downloadStatus === 'failed'
        );
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 10. provide_feedback
  server.registerTool(
    'provide_feedback',
    {
      title: 'Avaliar entrega individual de aluno (salvar nota e/ou gradingFeedbackComments preservando campos omitidos)',
      description:
        'Registra ou atualiza a nota e/ou o comentário da avaliação (assignfeedback_comments) de um aluno em uma tarefa do Moodle, preservando valores existentes quando grade, feedback ou workflowState forem omitidos. Para avaliações em lote ou de grupos com etapa de revisão do professor, prefira prepare_grading_batch -> commit_grading_batch -> verify_grading_batch.',
      inputSchema: z.object({
        assignmentId: z
          .number()
          .int()
          .describe('ID da tarefa (assignmentId).'),
        studentId: z
          .number()
          .int()
          .describe('ID do aluno (userid) no Moodle.'),
        grade: z
          .number()
          .optional()
          .describe(
            'Nota numérica a atribuir (ex: 9.5 ou 10, conforme a escala da tarefa). Se omitido, preserva a nota atual do aluno.'
          ),
        feedback: z
          .string()
          .optional()
          .describe(
            'Comentário da avaliação (gradingFeedbackComments / assignfeedback_comments) para o aluno (aceita texto ou HTML). Se omitido, preserva o comentário existente.'
          ),
        workflowState: z
          .string()
          .optional()
          .describe(
            'Estado explícito opcional do fluxo de avaliação ("inmarking", "readyforreview", "inreview", "readyforrelease", "released"). Se omitido, preserva o estado atual da avaliação sem forçar "released" implicitamente.'
          ),
        applyToAll: z
          .boolean()
          .optional()
          .describe(
            'Para tarefas em grupo, se true, solicita ao Moodle replicar para integrantes do grupo (padrão: false para evitar propagação implícita não revisada; use prepare_grading_batch para grupos).'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      assignmentId,
      studentId,
      grade,
      feedback,
      workflowState,
      applyToAll = false,
    }) => {
      try {
        const { result: resPayload, metrics } = await withOperationMetrics(async () =>
          gradingBatchManager.saveSingleFeedbackSafe({
            assignmentId,
            studentId,
            grade,
            feedback,
            workflowState,
            applyToAll,
          })
        );

        return jsonResponse({
          ...resPayload,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 11. get_quizzes
  server.registerTool(
    'get_quizzes',
    {
      title: 'Listar questionários (quizzes) da disciplina',
      description:
        'Lista todos os questionários (quizzes) de uma disciplina, com datas de abertura/fechamento, limite de tempo e nota máxima.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ courseId }) => {
      try {
        const resolvedCourseId = client.resolveCourseId(courseId);
        const res = await client.call<any>('mod_quiz_get_quizzes_by_courses', {
          courseids: [resolvedCourseId],
        });

        const quizzes = (res?.quizzes || []).map((q: any) => ({
          id: q.id,
          coursemodule: q.coursemodule,
          course: q.course,
          name: q.name,
          intro: htmlToText(q.intro) || undefined,
          timeopen: formatDate(q.timeopen),
          timeclose: formatDate(q.timeclose),
          timelimitSeconds: q.timelimit,
          maxGrade: q.grade,
          sumgrades: q.sumgrades,
          attemptsAllowed: q.attempts,
        }));

        return jsonResponse({
          courseId: resolvedCourseId,
          count: quizzes.length,
          quizzes,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 12. get_quiz_grade
  server.registerTool(
    'get_quiz_grade',
    {
      title: 'Consultar nota e tentativas de um aluno em um questionário',
      description:
        'Retorna a melhor nota e o histórico de tentativas de um aluno em um questionário (quiz) do Moodle.',
      inputSchema: z.object({
        quizId: z.number().int().describe('ID do questionário (quizId).'),
        studentId: z.number().int().describe('ID do aluno (userid).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ quizId, studentId }) => {
      try {
        const [bestGrade, attemptsRes] = await Promise.all([
          client.call<any>('mod_quiz_get_user_best_grade', {
            quizid: quizId,
            userid: studentId,
          }),
          client
            .call<any>('mod_quiz_get_user_attempts', {
              quizid: quizId,
              userid: studentId,
              status: 'all',
            })
            .catch(() => ({ attempts: [] })),
        ]);

        return jsonResponse({
          quizId,
          studentId,
          hasGrade: Boolean(bestGrade?.hasgrade),
          bestGrade: bestGrade?.grade ?? null,
          attempts: (attemptsRes?.attempts || []).map((a: any) => ({
            id: a.id,
            attempt: a.attempt,
            state: a.state,
            timestart: formatDate(a.timestart),
            timefinish: formatDate(a.timefinish),
            sumgrades: a.sumgrades,
          })),
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 13. send_message
  server.registerTool(
    'send_message',
    {
      title: 'Enviar mensagem direta no Moodle',
      description:
        'Envia uma mensagem instantânea direta pelo Moodle para um aluno ou usuário (core_message_send_instant_messages).',
      inputSchema: z.object({
        toUserId: z
          .number()
          .int()
          .describe('ID do usuário destinatário no Moodle (use get_students para descobrir).'),
        text: z
          .string()
          .min(1)
          .describe('Texto da mensagem a ser enviada.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ toUserId, text }) => {
      try {
        const res = await client.call<any[]>('core_message_send_instant_messages', {
          messages: [
            {
              touserid: toUserId,
              text,
              textformat: 1,
            },
          ],
        });

        const first = Array.isArray(res) ? res[0] : res;
        if (first?.errormessage) {
          throw new Error(`Erro ao enviar mensagem: ${first.errormessage}`);
        }

        return jsonResponse({
          success: true,
          msgid: first?.msgid,
          toUserId,
          timecreated: formatDate(first?.timecreated),
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 14. get_messages
  server.registerTool(
    'get_messages',
    {
      title: 'Listar mensagens recebidas/enviadas no Moodle',
      description:
        'Lista as mensagens diretas ou notificações recentes da conta do professor no Moodle.',
      inputSchema: z.object({
        direction: z
          .enum(['received', 'sent'])
          .optional()
          .describe('Direção das mensagens: "received" (padrão) ou "sent".'),
        type: z
          .enum(['conversations', 'notifications', 'both'])
          .optional()
          .describe('Tipo de mensagem: "conversations" (padrão), "notifications" ou "both".'),
        readStatus: z
          .enum(['unread', 'read', 'all'])
          .optional()
          .describe('Filtro de leitura: "all" (padrão), "unread" ou "read".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Quantidade máxima de mensagens a retornar (padrão: 20).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      direction = 'received',
      type = 'conversations',
      readStatus = 'all',
      limit = 20,
    }) => {
      try {
        const info = await client.getSiteInfo();
        const useridto = direction === 'received' ? info.userid : 0;
        const useridfrom = direction === 'sent' ? info.userid : 0;

        let messages: any[] = [];
        if (readStatus === 'all') {
          const [unreadRes, readRes] = await Promise.all([
            client.call<any>('core_message_get_messages', {
              useridto,
              useridfrom,
              type,
              read: 0,
              newestfirst: 1,
              limitnum: limit,
            }),
            client.call<any>('core_message_get_messages', {
              useridto,
              useridfrom,
              type,
              read: 1,
              newestfirst: 1,
              limitnum: limit,
            }),
          ]);
          messages = [...(unreadRes?.messages || []), ...(readRes?.messages || [])]
            .sort((a, b) => (b.timecreated || 0) - (a.timecreated || 0))
            .slice(0, limit);
        } else {
          const res = await client.call<any>('core_message_get_messages', {
            useridto,
            useridfrom,
            type,
            read: readStatus === 'unread' ? 0 : 1,
            newestfirst: 1,
            limitnum: limit,
          });
          messages = res?.messages || [];
        }

        const formatted = messages.map((m: any) => ({
          id: m.id,
          useridfrom: m.useridfrom,
          userfromfullname: m.userfromfullname,
          useridto: m.useridto,
          usertofullname: m.usertofullname,
          subject: m.subject,
          text: htmlToText(m.text || m.fullmessagehtml || m.smallmessage),
          timecreated: formatDate(m.timecreated),
          timeread: formatDate(m.timeread),
          notification: Boolean(m.notification),
        }));

        return jsonResponse({
          count: formatted.length,
          messages: formatted,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 15. get_forums
  server.registerTool(
    'get_forums',
    {
      title: 'Listar fóruns da disciplina',
      description:
        'Lista os fóruns de uma disciplina (ex: "Avisos" e "Fórum de Discussão"), retornando seus IDs para leitura ou publicação de avisos.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ courseId }) => {
      try {
        const resolvedCourseId = client.resolveCourseId(courseId);
        const forums = await client.call<any[]>('mod_forum_get_forums_by_courses', {
          courseids: [resolvedCourseId],
        });

        const formatted = (Array.isArray(forums) ? forums : []).map((f) => ({
          id: f.id,
          cmid: f.cmid,
          course: f.course,
          type: f.type,
          name: f.name,
          intro: htmlToText(f.intro) || undefined,
          numdiscussions: f.numdiscussions,
        }));

        return jsonResponse({
          courseId: resolvedCourseId,
          count: formatted.length,
          forums: formatted,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 16. get_forum_discussions
  server.registerTool(
    'get_forum_discussions',
    {
      title: 'Ler tópicos e postagens de um fórum',
      description:
        'Lista os tópicos/discussões de um fórum ou lê todas as postagens/respostas de uma discussão específica.',
      inputSchema: z.object({
        forumId: z
          .number()
          .int()
          .optional()
          .describe('ID do fórum (obtido via get_forums) para listar seus tópicos.'),
        discussionId: z
          .number()
          .int()
          .optional()
          .describe('ID de uma discussão específica para ler todas as mensagens/respostas dentro dela.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Número máximo de discussões retornadas (padrão: 20).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ forumId, discussionId, limit = 20 }) => {
      try {
        if (discussionId !== undefined) {
          const postsRes = await client.call<any>('mod_forum_get_discussion_posts', {
            discussionid: discussionId,
          });
          const posts = (postsRes?.posts || []).map((p: any) => ({
            id: p.id,
            discussionid: p.discussionid,
            parentid: p.parentid,
            hasparent: Boolean(p.hasparent),
            subject: p.subject,
            author: p.author?.fullname,
            authorId: p.author?.id,
            message: htmlToText(p.message),
            timecreated: formatDate(p.timecreated),
          }));
          return jsonResponse({
            discussionId,
            postCount: posts.length,
            posts,
          });
        }

        if (forumId === undefined) {
          throw new Error(
            'Informe forumId (para listar tópicos) ou discussionId (para ler as postagens de um tópico).'
          );
        }

        const res = await client.call<any>('mod_forum_get_forum_discussions', {
          forumid: forumId,
          perpage: limit,
        });

        const discussions = (res?.discussions || []).map((d: any) => ({
          id: d.id,
          discussion: d.discussion,
          name: d.name,
          subject: d.subject,
          userfullname: d.userfullname,
          userid: d.userid,
          message: htmlToText(d.message),
          numreplies: d.numreplies,
          created: formatDate(d.created),
          timemodified: formatDate(d.timemodified),
          pinned: Boolean(d.pinned),
        }));

        return jsonResponse({
          forumId,
          count: discussions.length,
          discussions,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 17. post_forum_discussion
  server.registerTool(
    'post_forum_discussion',
    {
      title: 'Publicar aviso/tópico ou resposta em fórum da disciplina',
      description:
        'Publica um novo aviso/tópico em um fórum da disciplina (ex: fórum de Avisos) ou responde a uma postagem existente.',
      inputSchema: z.object({
        forumId: z
          .number()
          .int()
          .optional()
          .describe('ID do fórum (obrigatório ao criar um novo tópico/aviso).'),
        replyToPostId: z
          .number()
          .int()
          .optional()
          .describe('ID do post (postid) ao qual deseja responder (em uma discussão já existente).'),
        subject: z
          .string()
          .min(1)
          .describe('Assunto/título do aviso ou da resposta.'),
        message: z
          .string()
          .min(1)
          .describe('Conteúdo da mensagem (aceita texto simples ou HTML).'),
        pinned: z
          .boolean()
          .optional()
          .describe('Se true, fixa o tópico no topo do fórum (ao criar novo tópico).'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ forumId, replyToPostId, subject, message, pinned = false }) => {
      try {
        const htmlMessage = !/<[a-z][\s\S]*>/i.test(message)
          ? message
              .split(/\n\n+/)
              .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
              .join('')
          : message;

        if (replyToPostId !== undefined) {
          const res = await client.call<any>('mod_forum_add_discussion_post', {
            postid: replyToPostId,
            subject,
            message: htmlMessage,
          });
          return jsonResponse({
            success: true,
            action: 'reply',
            postid: res?.postid,
            warnings: res?.warnings,
          });
        }

        if (forumId === undefined) {
          throw new Error(
            'Informe forumId para criar um novo tópico/aviso ou replyToPostId para responder a um post.'
          );
        }

        const options: { name: string; value: string }[] = [];
        if (pinned) {
          options.push({ name: 'discussionpinned', value: 'true' });
        }

        const res = await client.call<any>('mod_forum_add_discussion', {
          forumid: forumId,
          subject,
          message: htmlMessage,
          ...(options.length > 0 ? { options } : {}),
        });

        return jsonResponse({
          success: true,
          action: 'new_discussion',
          forumId,
          discussionid: res?.discussionid,
          warnings: res?.warnings,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 18. get_course_groups
  server.registerTool(
    'get_course_groups',
    {
      title: 'Listar grupos, agrupamentos e regras mod_groupselect da disciplina',
      description:
        'Lista todos os grupos de uma disciplina no Moodle (core_group_get_course_groups), seus participantes atuais, agrupamentos (groupings), permissão moodle/course:managegroups, sugestão de próximo nome único e a configuração completa das atividades mod_groupselect (como agrupamento associado, limites mínimo/máximo de participantes, prazos e permissões de criação).',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle (resolvido automaticamente se activityCmid for informado).'),
        activityCmid: z
          .number()
          .int()
          .optional()
          .describe(
            'Course module ID (cmid) opcional de uma atividade mod_groupselect (ex: 1569070) para inspecionar suas regras e verificar disponibilidade de cada grupo nela.'
          ),
        includeMembers: z
          .boolean()
          .optional()
          .describe('Se true (padrão), inclui a lista confirmada de integrantes de cada grupo.'),
        includeGroupSelect: z
          .boolean()
          .optional()
          .describe('Se true (padrão), consulta automaticamente as configurações de mod_groupselect da disciplina.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ courseId, activityCmid, includeMembers = true, includeGroupSelect = true }) => {
      try {
        const res = await groupManager.getCourseGroups({
          courseId,
          activityCmid,
          includeMembers,
          includeGroupSelect,
        });
        return jsonResponse(res);
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 19. get_group_members
  server.registerTool(
    'get_group_members',
    {
      title: 'Consultar participantes confirmados de um grupo',
      description:
        'Retorna a lista atualizada e confirmada de integrantes de um grupo específico no Moodle, juntamente com contagem de membros, limite máximo configurado (maxMembers), vagas restantes e disponibilidade na atividade mod_groupselect.',
      inputSchema: z.object({
        groupId: z
          .number()
          .int()
          .describe('ID do grupo (groupId) no Moodle.'),
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional da disciplina (validado contra o grupo quando informado).'),
        activityCmid: z
          .number()
          .int()
          .optional()
          .describe('Course module ID opcional (ex: mod_groupselect) para verificar disponibilidade e limite de vagas.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ groupId, courseId, activityCmid }) => {
      try {
        const res = await groupManager.getGroupMembers({
          groupId,
          courseId,
          activityCmid,
        });
        return jsonResponse(res);
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 20. create_course_group
  server.registerTool(
    'create_course_group',
    {
      title: 'Criar novo grupo na disciplina (idempotente e compatível com mod_groupselect)',
      description:
        'Cria um novo grupo em uma disciplina validando moodle/course:managegroups, permitindo escolher um nome explícito (sem nunca sobrescrever nem reutilizar grupos preexistentes) ou gerar automaticamente um nome único a partir dos grupos existentes. Se a atividade mod_groupselect exigir um agrupamento (targetgrouping > 0), associa o grupo automaticamente e confirma o estado final no Moodle antes de retornar.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle (resolvido automaticamente se activityCmid for informado).'),
        name: z
          .string()
          .optional()
          .describe(
            'Nome desejado para o novo grupo. Se omitido, gera automaticamente um nome único sequencial (ex: "Grupo 10") sem reutilizar lacunas nem duplicar grupos.'
          ),
        autoGenerateName: z
          .boolean()
          .optional()
          .describe('Se true (padrão quando name é omitido), gera nome único automaticamente.'),
        namePrefix: z
          .string()
          .optional()
          .describe('Prefixo opcional para geração automática de nome (ex: "Grupo ").'),
        description: z
          .string()
          .optional()
          .describe('Descrição opcional do grupo.'),
        idnumber: z
          .string()
          .optional()
          .describe('Identificador externo opcional (idnumber) do grupo no Moodle.'),
        enrolmentKey: z
          .string()
          .optional()
          .describe('Chave de inscrição opcional do grupo.'),
        groupingId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional de agrupamento (grouping) ao qual associar o grupo recém-criado.'),
        activityCmid: z
          .number()
          .int()
          .optional()
          .describe(
            'Course module ID (cmid) opcional da atividade mod_groupselect (ex: 1569070) onde o grupo deve ficar disponível.'
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            'Chave opcional de idempotência para evitar criação duplicada em caso de repetição da chamada após timeout.'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const res = await groupManager.createCourseGroup(args);
        return jsonResponse(res);
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 21. add_group_member
  server.registerTool(
    'add_group_member',
    {
      title: 'Adicionar participante(s) a um grupo da disciplina',
      description:
        'Adiciona um ou mais alunos matriculados a um grupo existente, validando moodle/course:managegroups, matrícula na disciplina, limite máximo de participantes (maxMembers do mod_groupselect) e unicidade de grupo. Operação idempotente e auditada que confirma o estado final no Moodle antes de retornar.',
      inputSchema: z.object({
        groupId: z
          .number()
          .int()
          .describe('ID do grupo (groupId) no Moodle.'),
        userId: z
          .number()
          .int()
          .optional()
          .describe('ID de um usuário/aluno (userid) a adicionar ao grupo.'),
        userIds: z
          .array(z.number().int())
          .optional()
          .describe('Lista opcional de IDs de usuários a adicionar ao grupo (alternativa ou complemento a userId).'),
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional da disciplina (validado contra o grupo).'),
        activityCmid: z
          .number()
          .int()
          .optional()
          .describe(
            'Course module ID opcional (ex: 1569070, mod_groupselect) cujas regras de limite máximo e agrupamento devem ser respeitadas.'
          ),
        allowMultipleGroups: z
          .boolean()
          .optional()
          .describe(
            'Se false (padrão), impede adicionar um aluno que já pertença a outro grupo no escopo da mesma atividade mod_groupselect.'
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe('Chave opcional de idempotência para auditoria e repetição segura.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ groupId, userId, userIds, courseId, activityCmid, allowMultipleGroups, idempotencyKey }) => {
      try {
        const combined = [
          ...(userId !== undefined ? [userId] : []),
          ...(userIds ?? []),
        ];
        if (combined.length === 0) {
          throw new MoodleGroupError(
            'moodle_api_error',
            'Informe userId ou userIds com pelo menos um participante.'
          );
        }
        const res = await groupManager.addGroupMember({
          groupId,
          userIds: combined,
          courseId,
          activityCmid,
          allowMultipleGroups,
          idempotencyKey,
        });
        return jsonResponse(res, res.status === 'partial_failure');
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 22. remove_group_member
  server.registerTool(
    'remove_group_member',
    {
      title: 'Remover participante(s) de um grupo da disciplina',
      description:
        'Remove um ou mais participantes de um grupo da disciplina validando moodle/course:managegroups e matrícula no curso. Operação idempotente e auditada que confirma a remoção no Moodle antes de retornar.',
      inputSchema: z.object({
        groupId: z
          .number()
          .int()
          .describe('ID do grupo (groupId) no Moodle.'),
        userId: z
          .number()
          .int()
          .optional()
          .describe('ID de um usuário/aluno (userid) a remover do grupo.'),
        userIds: z
          .array(z.number().int())
          .optional()
          .describe('Lista opcional de IDs de usuários a remover do grupo.'),
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional da disciplina (validado contra o grupo).'),
        activityCmid: z
          .number()
          .int()
          .optional()
          .describe('Course module ID opcional (ex: mod_groupselect) para conferência de estado.'),
        idempotencyKey: z
          .string()
          .optional()
          .describe('Chave opcional de idempotência.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ groupId, userId, userIds, courseId, activityCmid, idempotencyKey }) => {
      try {
        const combined = [
          ...(userId !== undefined ? [userId] : []),
          ...(userIds ?? []),
        ];
        if (combined.length === 0) {
          throw new MoodleGroupError(
            'moodle_api_error',
            'Informe userId ou userIds com pelo menos um participante.'
          );
        }
        const res = await groupManager.removeGroupMember({
          groupId,
          userIds: combined,
          courseId,
          activityCmid,
          idempotencyKey,
        });
        return jsonResponse(res, res.status === 'partial_failure');
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 23. create_group_with_members
  server.registerTool(
    'create_group_with_members',
    {
      title: 'Criar grupo e matricular participantes em uma única operação composta',
      description:
        'Cria um grupo novo na disciplina (com nome escolhido ou único gerado automaticamente, disponível no mod_groupselect) e adiciona os participantes informados de forma idempotente, validando previamente permissões, matrícula e limite máximo de vagas, relatando qualquer falha parcial e confirmando o estado final no Moodle.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID da disciplina no Moodle.'),
        name: z
          .string()
          .optional()
          .describe('Nome desejado para o grupo (se omitido, gera nome único automaticamente).'),
        autoGenerateName: z
          .boolean()
          .optional()
          .describe('Se true (padrão quando name é omitido), gera nome único a partir dos grupos existentes.'),
        namePrefix: z
          .string()
          .optional()
          .describe('Prefixo opcional para geração automática de nome (ex: "Grupo ").'),
        description: z
          .string()
          .optional()
          .describe('Descrição opcional do grupo.'),
        idnumber: z
          .string()
          .optional()
          .describe('Identificador externo opcional (idnumber) do grupo.'),
        enrolmentKey: z
          .string()
          .optional()
          .describe('Chave de inscrição opcional do grupo.'),
        groupingId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional de agrupamento ao qual associar o grupo.'),
        userIds: z
          .array(z.number().int())
          .describe('Lista de userIds dos participantes matriculados a adicionar ao grupo.'),
        activityCmid: z
          .number()
          .int()
          .optional()
          .describe('Course module ID opcional da atividade mod_groupselect (ex: 1569070).'),
        allowMultipleGroups: z
          .boolean()
          .optional()
          .describe('Se false (padrão), impede adicionar aluno já vinculado a outro grupo na mesma atividade.'),
        idempotencyKey: z
          .string()
          .optional()
          .describe('Chave opcional de idempotência para recuperação segura após timeout ou falha parcial.'),
        prevalidateAllMembers: z
          .boolean()
          .optional()
          .describe(
            'Se true (padrão), aborta antes de criar o grupo caso algum userId não esteja matriculado na disciplina; se false, cria o grupo, adiciona os válidos e reporta partial_failure para os inválidos.'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const res = await groupManager.createGroupWithMembers(args);
        return jsonResponse(res, res.status === 'partial_failure');
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 24. get_moodle_capabilities
  server.registerTool(
    'get_moodle_capabilities',
    {
      title: 'Consultar capacidades, versão, OCR, limites e ferramentas do UFSC Moodle MCP',
      description:
        'Retorna metadados de versão e protocolo do servidor UFSC Moodle MCP (v1.3.0), a lista completa de 30 ferramentas registradas e disponíveis, funcionalidades ativas, status detalhado dos motores de OCR local (Poppler pdftoppm + Tesseract e idiomas instalados), limites operacionais, suporte a avaliação em lote controlada (prepare/commit/verify), suporte a atualização e verificação de arquivos PDF em recursos mod_resource (replace_course_resource_file / verify_course_resource_file) e guia de atualização de cache de catálogo em clientes MCP externos.',
      inputSchema: z.object({
        checkMoodleConnection: z
          .boolean()
          .optional()
          .describe(
            'Se true, consulta também metadados básicos da instância Moodle (core_webservice_get_site_info) sem expor credenciais.'
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ checkMoodleConnection = false }) => {
      try {
        const { result: capPayload, metrics } = await withOperationMetrics(async () => {
          const cfg = client.getConfig();
          const ocrCaps = await client.getOcrCapabilities();

          let moodleSite: Record<string, unknown> | undefined;
          if (checkMoodleConnection) {
            try {
              const info = await client.getSiteInfo();
              moodleSite = {
                connected: true,
                sitename: info.sitename,
                siteurl: info.siteurl,
                release: info.release,
                version: info.version,
                authenticatedUserId: info.userid,
                authenticatedFullname: info.fullname,
              };
            } catch (err) {
              moodleSite = {
                connected: false,
                error: client.sanitizeErrorMessage(err),
              };
            }
          }

          return {
            serverName: 'ufsc-moodle-mcp',
            serverVersion: SERVER_VERSION,
            mcpProtocolVersion: MCP_PROTOCOL_VERSION,
            siteUrl: cfg.siteUrl,
            ...(moodleSite ? { moodleSite } : {}),
            availableToolsCount: REGISTERED_TOOL_NAMES.length,
            availableTools: [...REGISTERED_TOOL_NAMES],
            enabledFeatures: {
              binaryFileDownload: true,
              mcpFileResources: true,
              localServerOcr: ocrCaps.available,
              structuredVisualLayoutOcr: ocrCaps.available,
              deterministicAssignmentGroupResolution: true,
              consolidatedAssignmentGradingOverview: true,
              controlledGradingBatch: true,
              postWriteVerification: true,
              submissionVsFeedbackCommentSeparation: true,
              courseGroupManagement: true,
              resourcePdfReplacement: true,
              resourceIntegrityVerification: true,
              assignmentDetailsInspection: true,
              assignmentUpdatePreparation: true,
              assignmentUpdateControlledCommit: true,
              assignmentPostUpdateVerification: true,
            },
            ocr: ocrCaps,
            limits: {
              maxDownloadBytes: cfg.maxDownloadBytes ?? 50 * 1024 * 1024,
              downloadTimeoutMs: cfg.downloadTimeoutMs ?? 60_000,
              fileTtlSeconds: cfg.fileTtlSeconds ?? 1800,
              ocrMaxPages: ocrCaps.maxPages,
              ocrDpi: ocrCaps.dpi,
              ocrTimeoutMs: ocrCaps.timeoutMs,
              ocrPageTimeoutMs: ocrCaps.pageTimeoutMs,
              ocrMaxConcurrency: ocrCaps.maxConcurrency,
            },
            assignmentManagement: {
              supported: true,
              tools: [
                'get_assignment_details',
                'prepare_assignment_update',
                'commit_assignment_update',
                'verify_assignment_update',
              ],
              supportedPatchFields: [
                'intro',
                'visible',
                'alwaysShowDescription',
                'allowSubmissionsFromDate',
                'dueDate',
                'cutoffDate',
                'fileSubmissionEnabled',
                'fileTypes',
                'maxFiles',
                'maxSizeBytes',
              ],
              supportsTwoPhaseCommit: true,
              optimisticConcurrencyProtection: true,
              requiresReviewerConfirmation: true,
              independentCutoffDate: true,
              idempotencySupported: true,
              timeZoneHandling: 'explicit_offset_or_iana',
            },
            batchOperations: {
              supported: true,
              tools: [
                'get_assignment_grading_overview',
                'prepare_grading_batch',
                'commit_grading_batch',
                'verify_grading_batch',
              ],
              prepareIsStrictlyReadOnly: true,
              requiresHumanReviewerApproval: true,
              optimisticConcurrencyProtection: true,
              idempotentByOperationId: true,
            },
            resourceManagement: {
              supported: true,
              tools: [
                'replace_course_resource_file',
                'verify_course_resource_file',
              ],
              supportedSources: ['https_url', 'data_uri', 'base64', 'file_uri'],
              supportsGoogleDrivePdfExport: true,
              preservesCourseModuleId: true,
              preservesPublicUrl: true,
              dryRunSupported: true,
              idempotencySupported: true,
              pdfIntegrityValidation: true,
            },
            controlledPublication: {
              supportedPublicationStates: [
                'inmarking',
                'readyforreview',
                'inreview',
                'readyforrelease',
                'released',
              ],
              supportedNotificationPolicies: [
                'suppress',
                'moodle_default',
                'notify_students',
              ],
              blocksSilentReleaseWhenWorkflowDisabled: true,
              writesOnlyTo: 'assignfeedbackcomments_editor',
            },
            schemaPortability: {
              avoidsFormatUriFilterHazard: true,
              listChangedNotificationEnabled: true,
            },
            clientCacheRefreshGuide: {
              chatgptConnectors:
                'Em Configurações -> Conectores / Apps -> UFSC Moodle MCP, clique em "Atualizar ferramentas" (Refresh tools) ou reconecte o conector e inicie uma nova conversa para recarregar o catálogo MCP.',
              desktopAndCliClients:
                'Reinicie a sessão MCP ou reconecte o transporte Streamable HTTP para disparar novo initialize + tools/list.',
            },
          };
        });

        return jsonResponse({
          ...capPayload,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 25. get_assignment_grading_overview
  server.registerTool(
    'get_assignment_grading_overview',
    {
      title: 'Visão consolidada em lote de entregas, grupos, notas, feedbacks, workflow e cobertura da tarefa',
      description:
        'Recupera em uma única operação consolidada todo o panorama de avaliação de uma tarefa do Moodle: metadados da tarefa, grupos efetivos do projeto (excluindo grupos gerais de turma), integrantes confirmados (sem docentes), entregas coletivas e individuais com arquivos deduplicados, notas individuais e agregadas por grupo (fully_graded, partially_graded, not_graded, inconsistent), comentários de avaliação existentes (gradingFeedbackComments), estados de workflow e visibilidade, cobertura percentual e inconsistências detectadas.',
      inputSchema: z.object({
        assignmentId: z
          .number()
          .int()
          .describe('ID da tarefa (assignmentId) no Moodle.'),
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional da disciplina (resolvido automaticamente quando omitido).'),
        includeMembers: z
          .boolean()
          .optional()
          .describe('Se true (padrão), inclui os integrantes e suas avaliações individuais em cada grupo.'),
        includeGrades: z
          .boolean()
          .optional()
          .describe('Se true (padrão), inclui notas individuais, nota agregada comum e divergências.'),
        includeFeedback: z
          .boolean()
          .optional()
          .describe(
            'Se true (padrão), inclui comentários da avaliação existentes (gradingFeedbackComments) e hash SHA-256.'
          ),
        includeWorkflow: z
          .boolean()
          .optional()
          .describe('Se true (padrão), inclui estados de workflow da avaliação.'),
        includeVisibility: z
          .boolean()
          .optional()
          .describe('Se true (padrão), inclui estado de publicação e visibilidade para os estudantes.'),
        includeSubmissionComments: z
          .boolean()
          .optional()
          .describe(
            'Se true, consulta também comentários da entrega (assignsubmission_comments) de cada submissão enviada (padrão: false para máxima velocidade).'
          ),
        includeGroups: z
          .boolean()
          .optional()
          .describe('Se true (padrão), retorna a lista detalhada de grupos da tarefa.'),
        includePersonalData: z
          .boolean()
          .optional()
          .describe('Se true, inclui e-mail institucional dos estudantes (padrão: false).'),
        fresh: z
          .boolean()
          .optional()
          .describe('Se true, ignora caches temporários e força releitura direta do Moodle.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Quantidade máxima de grupos/itens retornados por página (padrão: 200).'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor numérico opcional para paginação (nextCursor da chamada anterior).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const { result: overview, metrics } = await withOperationMetrics(async () =>
          getAssignmentGradingOverview(client, args)
        );
        return jsonResponse({
          ...overview,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 26. prepare_grading_batch
  const publicationStateSchema = z.enum([
    'inmarking',
    'readyforreview',
    'inreview',
    'readyforrelease',
    'released',
  ]);
  const notificationPolicySchema = z.enum(['suppress', 'moodle_default', 'notify_students']);

  server.registerTool(
    'prepare_grading_batch',
    {
      title: 'Preparar plano de avaliação em lote para revisão humana (estritamente somente-leitura)',
      description:
        'Prepara, valida e calcula o diff completo de um lote de avaliações (notas e/ou gradingFeedbackComments por groupId ou studentId) SEM realizar nenhuma escrita no Moodle. Distingue alterações solicitadas de alterações efetivas: se notas/feedbacks propostos forem idênticos aos já armazenados, classifica a ação como "preserve", reporta status="prepared_no_changes" e readyToCommit=false. Detecta conflitos (grupos gerais inválidos, ambiguidade, bloqueios, notas fora da faixa ou divergências), gera planId + planHash (SHA-256) e detalha os 4 níveis de garantia exigidos para autorização humana.',
      inputSchema: z.object({
        assignmentId: z
          .number()
          .int()
          .describe('ID da tarefa (assignmentId) no Moodle.'),
        courseId: z
          .number()
          .int()
          .optional()
          .describe('ID opcional da disciplina.'),
        items: z
          .array(
            z.object({
              groupId: z
                .number()
                .int()
                .optional()
                .describe('ID do grupo de projeto da tarefa (assignmentGroupId) cujos integrantes receberão a avaliação.'),
              studentId: z
                .number()
                .int()
                .optional()
                .describe('ID de um estudante específico (userid) quando a avaliação for individual.'),
              grade: z
                .number()
                .optional()
                .describe(
                  'Nota numérica proposta (ex: 9.5). Omita este campo para preservar integralmente a nota atual.'
                ),
              gradingFeedbackComment: z
                .string()
                .optional()
                .describe(
                  'Comentário de avaliação proposto (assignfeedback_comments, texto simples ou HTML). Omita para preservar o comentário existente.'
                ),
              feedback: z
                .string()
                .optional()
                .describe('Alias opcional compatível para gradingFeedbackComment.'),
              clearFeedback: z
                .boolean()
                .optional()
                .describe(
                  'Se true, limpa intencionalmente o comentário de avaliação existente (padrão: false).'
                ),
            })
          )
          .min(1)
          .max(200)
          .describe('Lista de avaliações propostas por grupo ou por estudante.'),
        proposedPublicationState: publicationStateSchema
          .optional()
          .describe(
            'Estado pretendido de publicação ("inmarking", "readyforreview", "inreview", "readyforrelease" ou "released") para validação prévia contra markingworkflow da tarefa.'
          ),
        proposedNotificationPolicy: notificationPolicySchema
          .optional()
          .describe('Política pretendida de notificação aos estudantes ("suppress", "moodle_default" ou "notify_students").'),
        allowMemberGradeOverride: z
          .boolean()
          .optional()
          .describe(
            'Se true, permite aplicar avaliação coletiva a um grupo mesmo que seus integrantes tenham notas prévias divergentes entre si (padrão: false, gerando conflito explícito).'
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      assignmentId,
      courseId,
      items,
      proposedPublicationState,
      proposedNotificationPolicy,
      allowMemberGradeOverride,
    }) => {
      try {
        const { result: prepared, metrics } = await withOperationMetrics(async () =>
          gradingBatchManager.prepareGradingBatch({
            assignmentId,
            courseId,
            items,
            proposedPublicationState: proposedPublicationState as
              | PublicationStateOption
              | undefined,
            proposedNotificationPolicy: proposedNotificationPolicy as
              | NotificationPolicyOption
              | undefined,
            allowMemberGradeOverride,
          })
        );
        return jsonResponse({
          ...prepared,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 27. commit_grading_batch
  server.registerTool(
    'commit_grading_batch',
    {
      title: 'Publicar lote de avaliações aprovado pelo professor (idempotente, auditado e com controle de concorrência)',
      description:
        'Executa exclusivamente um plano preparado por prepare_grading_batch e formalmente autorizado pelo professor. Distingue 4 níveis de controle: (1) validação técnica do plano, (2) integridade criptográfica pelo approvedPlanHash, (3) confirmação declarada via confirmedByReviewer=true e (4) autorização humana efetiva do docente. Se o plano não contiver alterações efetivas (status="prepared_no_changes"), commit_grading_batch retorna "unchanged_no_action_required" com 0 escritas no Moodle de forma totalmente idempotente. Protegido por verificação otimista de concorrência e registro em log de auditoria local redigido.',
      inputSchema: z.object({
        planId: z
          .string()
          .min(1)
          .describe('Identificador planId retornado por prepare_grading_batch.'),
        approvedPlanHash: z
          .string()
          .min(1)
          .describe('Hash SHA-256 exato (planHash) aprovado pelo professor revisor.'),
        confirmedByReviewer: z
          .boolean()
          .describe(
            'Declaração formal do cliente/agente de que o professor revisou e autorizou o plano. NOTA: Este parâmetro isolado não comprova de forma autônoma a autorização humana; a interface cliente deve colher a aprovação efetiva do docente antes de enviar true.'
          ),
        operationId: z
          .string()
          .min(1)
          .max(160)
          .describe(
            'Chave única de idempotência da operação (repetir o mesmo operationId não duplica escritas nem notificações).'
          ),
        publicationState: publicationStateSchema.describe(
          'Estado explícito de publicação: "inmarking", "readyforreview", "inreview", "readyforrelease" ou "released". Se markingworkflow=0 na tarefa, estados não liberados são bloqueados em vez de publicar silenciosamente.'
        ),
        notificationPolicy: notificationPolicySchema.describe(
          'Política explícita de notificação aos estudantes: "suppress" (suprimir notificação), "moodle_default" ou "notify_students".'
        ),
        resumeFailedOnly: z
          .boolean()
          .optional()
          .describe(
            'Em caso de retomada de partial_failure com o mesmo operationId, reexecuta apenas os registros pendentes/com falha (padrão: true).'
          ),
        reviewerNote: z
          .string()
          .max(500)
          .optional()
          .describe('Observação opcional de auditoria registrada pelo revisor.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      planId,
      approvedPlanHash,
      confirmedByReviewer,
      operationId,
      publicationState,
      notificationPolicy,
      resumeFailedOnly,
      reviewerNote,
    }) => {
      try {
        const { result: committed, metrics } = await withOperationMetrics(async () =>
          gradingBatchManager.commitGradingBatch({
            planId,
            approvedPlanHash,
            confirmedByReviewer,
            operationId,
            publicationState,
            notificationPolicy,
            resumeFailedOnly,
            reviewerNote,
          })
        );
        return jsonResponse(
          {
            ...committed.payload,
            metrics,
          },
          committed.isError
        );
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 28. verify_grading_batch
  server.registerTool(
    'verify_grading_batch',
    {
      title: 'Verificar em tempo real no Moodle o resultado de um lote de avaliações publicado',
      description:
        'Reconsulta os dados diretamente no Moodle (fresh=true, nunca confiando apenas na resposta de escrita) e confere, para cada grupo e cada integrante afetado, se nota, comentário da avaliação (gradingFeedbackComments), contagem de membros, estado de workflow e visibilidade correspondem exatamente ao plano aprovado.',
      inputSchema: z.object({
        planId: z
          .string()
          .min(1)
          .optional()
          .describe('planId do plano preparado/publicado (opcional se operationId for informado).'),
        operationId: z
          .string()
          .min(1)
          .optional()
          .describe('operationId utilizado em commit_grading_batch (opcional se planId for informado).'),
        expectedPublicationState: publicationStateSchema
          .optional()
          .describe('Estado esperado de publicação para conferência (inferido automaticamente da operação quando omitido).'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ planId, operationId, expectedPublicationState }) => {
      try {
        const { result: verified, metrics } = await withOperationMetrics(async () =>
          gradingBatchManager.verifyGradingBatch({
            planId,
            operationId,
            expectedPublicationState,
          })
        );
        return jsonResponse(
          {
            ...verified.payload,
            metrics,
          },
          verified.isError
        );
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 29. replace_course_resource_file
  server.registerTool(
    'replace_course_resource_file',
    {
      title: 'Atualizar ou substituir arquivo PDF em recurso didático existente (mod_resource)',
      description:
        'Substitui com segurança o arquivo PDF de um recurso mod_resource existente no Moodle (ex.: apresentação exportada pelo Google Drive MCP). Valida papel docente/edição no curso, valida a integridade do PDF (magic bytes, trailer %%EOF e ausência de senha), preserva intactos o courseModuleId e a URL pública do recurso, executa a atualização no Moodle via controller oficial (/course/modedit.php) e realiza verificação independente automática pós-gravação. Suporta dryRun=true para simulação prévia sem escrita.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .positive()
          .describe('ID numérico da disciplina no Moodle (ex: 49476).'),
        courseModuleId: z
          .number()
          .int()
          .positive()
          .describe(
            'ID numérico do módulo do recurso no curso (cmid, ex: 1564872). O módulo deve ser do tipo mod_resource.'
          ),
        sourceFileUri: z
          .string()
          .optional()
          .describe(
            'URI ou URL de origem do arquivo PDF (ex.: URL de exportação do Google Drive, data URI data:application/pdf;base64,..., ou file://).'
          ),
        sourceBase64: z
          .string()
          .optional()
          .describe('Conteúdo do arquivo PDF em Base64 bruto (alternativa a sourceFileUri).'),
        sourceFileHeaders: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Headers HTTP adicionais para download de sourceFileUri (ex: { "Authorization": "Bearer ..." }).'
          ),
        expectedCurrentFilename: z
          .string()
          .optional()
          .describe(
            'Nome esperado do arquivo atual no Moodle como trava de proteção anti-conflito/troca indevida (ex: "INE5458 -  DeFi and On Chain Finance.pdf").'
          ),
        newFilename: z
          .string()
          .optional()
          .describe(
            'Nome de arquivo desejado para o novo PDF no Moodle. Se omitido, preserva o nome atual do arquivo.'
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'Se true, simula toda a operação (resolve origem, valida integridade do PDF, confere permissões e metadados no Moodle) sem aplicar qualquer modificação.'
          ),
        operationId: z
          .string()
          .optional()
          .describe(
            'Chave de idempotência para evitar uploads/modificações repetidas em retentativas com o mesmo operationId.'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { result, metrics } = await withOperationMetrics(async () =>
          resourceManager.replaceCourseResourceFile(params)
        );
        return jsonResponse({
          ...result,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 30. verify_course_resource_file
  server.registerTool(
    'verify_course_resource_file',
    {
      title: 'Verificar integridade e metadados de arquivo PDF em recurso didático (mod_resource)',
      description:
        'Reconsulta diretamente no Moodle o módulo mod_resource indicado, recupera seus metadados de arquivo, efetua download independente, valida se é um PDF íntegro (magic bytes, trailer %%EOF e ausência de criptografia com senha) e confere o hash SHA-256 e tamanho com os valores esperados fornecidos.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .positive()
          .describe('ID numérico da disciplina no Moodle (ex: 49476).'),
        courseModuleId: z
          .number()
          .int()
          .positive()
          .describe('ID numérico do módulo do recurso no curso (cmid, ex: 1564872).'),
        expectedFilename: z
          .string()
          .optional()
          .describe('Nome esperado do arquivo para conferência.'),
        expectedSha256: z
          .string()
          .optional()
          .describe(
            'Hash SHA-256 esperado do arquivo PDF para conferência criptográfica exata.'
          ),
        expectedSizeBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Tamanho exato esperado em bytes do arquivo PDF.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { result, metrics } = await withOperationMetrics(async () =>
          resourceManager.verifyCourseResourceFile(params)
        );
        return jsonResponse({
          ...result,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 31. get_assignment_details
  server.registerTool(
    'get_assignment_details',
    {
      title: 'Consultar detalhes completos, enunciado, datas e visibilidade de tarefa (mod_assign)',
      description:
        'Realiza leitura completa e segura de uma tarefa (mod_assign) no Moodle UFSC. Distingue explicitamente o estado do enunciado (presente, vazio, não retornado ou não autorizado), avalia visibilidade de módulo e seção, datas com conversão explícita de fuso horário (local America/Sao_Paulo e UTC), configurações de envio de arquivos (.pdf, .zip, quantidade máxima, limites de tamanho), modalidade em grupo, nota máxima e gera um fingerprint de estado para detecção de concorrência.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .positive()
          .describe('ID numérico da disciplina no Moodle (ex: 49472).'),
        assignmentId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('ID numérico da tarefa no Moodle (ex: 125468). Opcional se courseModuleId for fornecido.'),
        courseModuleId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('ID numérico do módulo da tarefa no curso (cmid, ex: 1569058). Opcional se assignmentId for fornecido.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { result, metrics } = await withOperationMetrics(async () =>
          assignmentManager.getAssignmentDetails(params)
        );
        return jsonResponse({
          ...result,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 32. prepare_assignment_update
  server.registerTool(
    'prepare_assignment_update',
    {
      title: 'Preparar plano não-destrutivo de alteração de tarefa (mod_assign)',
      description:
        'Prepara um plano auditado de atualização para uma tarefa no Moodle SEM executar qualquer gravação. Recebe um patch parcial explícito (campos omitidos são rigorosamente preservados), valida formato de enunciado, visibilidade, datas com fuso horário (tratando vencimento e encerramento de forma independente), configurações de arquivos de entrega (.pdf, .zip, limites). Gera diff legível, lista de campos inalterados, identificador de plano (planId) e hash de aprovação com validade de 1 hora.',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .positive()
          .describe('ID numérico da disciplina no Moodle (ex: 49472).'),
        assignmentId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('ID numérico da tarefa no Moodle (ex: 125468).'),
        courseModuleId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('ID numérico do módulo da tarefa no curso (cmid, ex: 1569058).'),
        patch: z
          .object({
            intro: z
              .string()
              .optional()
              .describe('Novo enunciado da tarefa em HTML. Preservar tags, listas, tabelas e código.'),
            clearIntro: z
              .boolean()
              .optional()
              .describe('Proteção obrigatória para limpeza intencional do enunciado quando intro for vazio ("").'),
            introFormat: z
              .number()
              .int()
              .optional()
              .describe('Formato do editor de texto (padrão: 1 = HTML).'),
            visible: z
              .boolean()
              .optional()
              .describe('Visibilidade da tarefa no curso (true = visível, false = oculta).'),
            alwaysShowDescription: z
              .boolean()
              .optional()
              .describe('Exibir enunciado antes da data de início das submissões.'),
            allowSubmissionsFromDate: z
              .object({
                enabled: z.boolean().describe('Habilitar data de abertura para submissões.'),
                date: z
                  .string()
                  .optional()
                  .describe('Data e hora no formato ISO com offset (ex: 2026-11-20T08:00:00-03:00) ou UTC (Z).'),
                timeZone: z.string().optional().describe('Fuso horário IANA (padrão: America/Sao_Paulo).'),
              })
              .nullable()
              .optional()
              .describe('Data de abertura para recebimento de entregas (null para desabilitar).'),
            dueDate: z
              .object({
                enabled: z.boolean().describe('Habilitar prazo regular de vencimento.'),
                date: z
                  .string()
                  .optional()
                  .describe('Data e hora de vencimento ISO com offset (ex: 2026-11-26T23:59:00-03:00).'),
                timeZone: z.string().optional().describe('Fuso horário IANA (padrão: America/Sao_Paulo).'),
              })
              .nullable()
              .optional()
              .describe('Data de vencimento. Alterar este campo NUNCA altera o cutoffDate.'),
            cutoffDate: z
              .object({
                enabled: z.boolean().describe('Habilitar encerramento estrito de recebimento.'),
                date: z
                  .string()
                  .optional()
                  .describe('Data e hora limite no formato ISO com offset (ex: 2026-11-30T23:59:00-03:00).'),
                timeZone: z.string().optional().describe('Fuso horário IANA (padrão: America/Sao_Paulo).'),
              })
              .nullable()
              .optional()
              .describe('Data de encerramento do recebimento. Totalmente independente de dueDate.'),
            fileSubmissionEnabled: z
              .boolean()
              .optional()
              .describe('Habilitar envio de arquivos pelos alunos.'),
            fileTypes: z
              .string()
              .optional()
              .describe('Tipos de arquivo aceitos separados por vírgula (ex: ".pdf,.zip").'),
            maxFiles: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Quantidade máxima de arquivos aceitos (mínimo 1).'),
            maxSizeBytes: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe('Tamanho máximo em bytes por entrega (0 = limite do curso/site).'),
          })
          .describe('Conjunto de alterações propostas. Campos omitidos permanecem inalterados no Moodle.'),
        allowReduceMaxFiles: z
          .boolean()
          .optional()
          .describe('Aprovação explícita obrigatória se a alteração reduzir a quantidade máxima de arquivos.'),
        expectedFingerprint: z
          .string()
          .optional()
          .describe('Fingerprint de estado anterior para validação prévia de concorrência.'),
        operationId: z
          .string()
          .optional()
          .describe('Identificador único da operação para controle de idempotência.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { result, metrics } = await withOperationMetrics(async () =>
          assignmentManager.prepareAssignmentUpdate(params)
        );
        return jsonResponse({
          ...result,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 33. commit_assignment_update
  server.registerTool(
    'commit_assignment_update',
    {
      title: 'Aplicar exclusivamente plano aprovado de alteração de tarefa (mod_assign)',
      description:
        'Aplica no Moodle com segurança o conjunto exato de modificações preparado por prepare_assignment_update. Exige planId, planHash criptográfico e confirmedByReviewer=true (trava de aprovação humana). Revalida permissões e estado atual no Moodle (detectando concorrência), grava via controlador oficial (/course/modedit.php), executa verificação independente pós-gravação e registra auditoria completa sem vazamento de credenciais.',
      inputSchema: z.object({
        planId: z
          .string()
          .describe('Identificador do plano gerado por prepare_assignment_update.'),
        planHash: z
          .string()
          .describe('Hash HMAC-SHA256 de aprovação gerado por prepare_assignment_update.'),
        confirmedByReviewer: z
          .boolean()
          .describe('Confirmação explícita do revisor humano (deve ser true). Trava contra execução acidental.'),
        operationId: z
          .string()
          .optional()
          .describe('Identificador de operação para repetição idempotente segura.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { result, metrics } = await withOperationMetrics(async () =>
          assignmentManager.commitAssignmentUpdate(params)
        );
        return jsonResponse({
          ...result,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  // 34. verify_assignment_update
  server.registerTool(
    'verify_assignment_update',
    {
      title: 'Verificar independentemente estado persistido de tarefa no Moodle (mod_assign)',
      description:
        'Reler diretamente do Moodle uma tarefa atualizada (sem confiar em respostas intermediárias de escrita) e verifica se os campos esperados foram alterados e se os campos não modificados permaneceram íntegros (enunciado, datas, visibilidade, arquivos de entrega, modalidade individual/grupo e nota máxima).',
      inputSchema: z.object({
        courseId: z
          .number()
          .int()
          .positive()
          .describe('ID numérico da disciplina no Moodle (ex: 49472).'),
        assignmentId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('ID numérico da tarefa no Moodle (ex: 125468).'),
        courseModuleId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('ID numérico do módulo da tarefa no curso (cmid, ex: 1569058).'),
        expectedChanges: z
          .record(z.string(), z.any())
          .optional()
          .describe('Mapeamento dos campos e valores esperados alterados para conferência rigorosa.'),
        expectedPreserved: z
          .record(z.string(), z.any())
          .optional()
          .describe('Mapeamento dos campos que deveriam permanecer preservados.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { result, metrics } = await withOperationMetrics(async () =>
          assignmentManager.verifyAssignmentUpdate(params)
        );
        return jsonResponse({
          ...result,
          metrics,
        });
      } catch (err) {
        return errorResponse(err, client);
      }
    }
  );

  return server;
}
