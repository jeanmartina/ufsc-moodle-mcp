import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MoodleClient, MoodleConfig, htmlToText, redactSecrets } from './moodle.js';
import { MoodleWebSession, extractMoodleFormErrors } from './group-manager.js';

export type AssignmentIntroStatus = 'present' | 'empty' | 'not_returned' | 'unauthorized';

export type AssignmentErrorCode =
  | 'assignment_not_found'
  | 'module_not_found'
  | 'not_an_assign_module'
  | 'course_mismatch'
  | 'insufficient_permissions'
  | 'invalid_patch'
  | 'invalid_date'
  | 'concurrency_conflict'
  | 'plan_not_found'
  | 'plan_expired'
  | 'invalid_plan_hash'
  | 'approval_required'
  | 'moodle_api_error'
  | 'verification_failed'
  | 'idempotent_replay';

export class MoodleAssignmentError extends Error {
  public readonly code: AssignmentErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: AssignmentErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MoodleAssignmentError';
    this.code = code;
    this.details = details;
  }
}

export interface AssignmentIntroDetails {
  status: AssignmentIntroStatus;
  html: string | null;
  text: string | null;
  format: number;
  attachments: Array<{
    filename: string;
    filesize: number;
    fileurl: string;
    mimetype: string;
    timemodified: number;
  }>;
}

export interface AssignmentVisibilityDetails {
  moduleVisible: boolean;
  sectionVisible: boolean;
  userVisible: boolean;
  effectiveVisible: boolean;
  availabilityInfo: string | null;
  sectionId?: number;
  sectionNumber?: number;
  accessRestrictions: string[];
}

export interface AssignmentDateDetails {
  enabled: boolean;
  timestamp: number | null;
  isoLocal: string | null;
  isoUtc: string | null;
  timeZone: string;
}

export interface AssignmentDatesDetails {
  allowSubmissionsFromDate: AssignmentDateDetails;
  dueDate: AssignmentDateDetails;
  cutoffDate: AssignmentDateDetails;
  gradingDueDate: AssignmentDateDetails;
  alwaysShowDescription: boolean;
}

export interface AssignmentSubmissionConfigDetails {
  fileSubmissionEnabled: boolean;
  maxFiles: number;
  fileTypes: string;
  maxSizeBytes: number;
  effectiveMaxSizeBytes?: number;
  onlineTextEnabled: boolean;
  commentsEnabled: boolean;
}

export interface AssignmentSettingsDetails {
  teamSubmission: boolean;
  teamSubmissionGroupingId: number;
  requireAllTeamMembersSubmit: boolean;
  preventSubmissionNotInGroup: boolean;
  maxGrade: number;
  markingWorkflow: boolean;
  markingAllocation: boolean;
  blindMarking: boolean;
}

export interface AssignmentActorDetails {
  userId: number;
  username: string;
  fullname: string;
  canEdit: boolean;
  roles: string[];
}

export interface AssignmentDetailsResult {
  courseId: number;
  assignmentId: number;
  courseModuleId: number;
  name: string;
  url: string;
  intro: AssignmentIntroDetails;
  visibility: AssignmentVisibilityDetails;
  dates: AssignmentDatesDetails;
  submissionConfig: AssignmentSubmissionConfigDetails;
  settings: AssignmentSettingsDetails;
  permissions: AssignmentActorDetails;
  dataOrigin: {
    moodleVersion?: string;
    fetchedAt: string;
    sources: string[];
  };
  stateFingerprint: string;
}

export interface DatePatchInput {
  enabled: boolean;
  date?: string;
  timeZone?: string;
}

export interface AssignmentPatchInput {
  intro?: string;
  clearIntro?: boolean;
  introFormat?: number;
  visible?: boolean;
  alwaysShowDescription?: boolean;
  allowSubmissionsFromDate?: DatePatchInput | null;
  dueDate?: DatePatchInput | null;
  cutoffDate?: DatePatchInput | null;
  fileSubmissionEnabled?: boolean;
  fileTypes?: string;
  maxFiles?: number;
  maxSizeBytes?: number;
}

export interface PrepareAssignmentUpdateParams {
  courseId: number;
  assignmentId?: number;
  courseModuleId?: number;
  patch: AssignmentPatchInput;
  allowReduceMaxFiles?: boolean;
  expectedFingerprint?: string;
  operationId?: string;
}

export interface AssignmentFieldDiff<T = any> {
  previous: T;
  proposed: T;
}

export interface AssignmentUpdatePlan {
  planId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  operationId?: string;
  actor: AssignmentActorDetails;
  courseId: number;
  assignmentId: number;
  courseModuleId: number;
  previousFingerprint: string;
  patch: AssignmentPatchInput;
  proposedDiff: Record<string, AssignmentFieldDiff>;
  unchangedFields: string[];
  sideEffectsAndWarnings: string[];
  requiresReviewerConfirmation: boolean;
  instructionsForApproval: string;
}

export interface CommitAssignmentUpdateParams {
  planId: string;
  planHash: string;
  confirmedByReviewer: boolean;
  operationId?: string;
}

export interface VerifyAssignmentUpdateParams {
  courseId: number;
  assignmentId?: number;
  courseModuleId?: number;
  expectedChanges?: Record<string, any>;
  expectedPreserved?: Record<string, any>;
}

export interface VerifyAssignmentUpdateResult {
  verified: boolean;
  status: 'confirmed' | 'divergence' | 'partial_failure' | 'failed';
  courseId: number;
  assignmentId: number;
  courseModuleId: number;
  checks: Record<string, boolean>;
  divergences?: string[];
  currentDetails: AssignmentDetailsResult;
}

export interface CommitAssignmentUpdateResult {
  success: boolean;
  status: 'committed_and_verified' | 'idempotent_replay' | 'divergence_detected';
  operationId?: string;
  planId: string;
  courseId: number;
  assignmentId: number;
  courseModuleId: number;
  appliedDiff: Record<string, AssignmentFieldDiff>;
  verification: VerifyAssignmentUpdateResult;
  message: string;
}

export interface AssignmentAuditEntry {
  timestamp: string;
  operationId?: string;
  planId?: string;
  planHash?: string;
  actor: { userId: number; username: string };
  courseId: number;
  assignmentId: number;
  courseModuleId: number;
  assignmentName: string;
  diff: Record<string, AssignmentFieldDiff>;
  verified: boolean;
  status: string;
  error?: string;
}

/**
 * Parses and formats dates strictly adhering to explicit timezone rules.
 * Accepts ISO strings with timezone offsets (e.g. -03:00 or Z), timestamps, or explicit IANA timezones.
 * Rejects ambiguous dates without offsets or timezones.
 */
export function parseAndFormatMoodleDate(
  input: string | number | Date,
  timeZone = 'America/Sao_Paulo'
): {
  timestamp: number;
  isoUtc: string;
  isoLocal: string;
  timeZone: string;
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
} {
  let d: Date;

  if (typeof input === 'number') {
    d = new Date(input < 1e11 ? input * 1000 : input);
  } else if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'string') {
    const clean = input.trim();
    // Verify explicit offset or Z to prevent implicit container timezone ambiguity
    const hasOffsetOrZ = /([+-]\d{2}:?\d{2}|Z)$/i.test(clean);
    if (!hasOffsetOrZ) {
      throw new MoodleAssignmentError(
        'invalid_date',
        `Data ambígua sem fuso horário ou offset especificado: "${input}". Forneça o offset (ex: -03:00 ou Z) ou use formato ISO completo com fuso.`
      );
    }
    d = new Date(clean);
  } else {
    throw new MoodleAssignmentError('invalid_date', `Tipo de data inválido: ${typeof input}`);
  }

  if (isNaN(d.getTime())) {
    throw new MoodleAssignmentError('invalid_date', `Data inválida ou não reconhecida: "${input}"`);
  }

  let partsObj: Record<string, number> = {};
  try {
    const partsFmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    for (const p of partsFmt.formatToParts(d)) {
      if (p.type !== 'literal') {
        partsObj[p.type] = parseInt(p.value, 10);
      }
    }
  } catch (err: any) {
    throw new MoodleAssignmentError(
      'invalid_date',
      `Fuso horário inválido ou não suportado ("${timeZone}"): ${err?.message || err}`
    );
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const isoLocal = `${partsObj.year}-${pad(partsObj.month)}-${pad(partsObj.day)}T${pad(
    partsObj.hour
  )}:${pad(partsObj.minute)}:${pad(partsObj.second || 0)}`;

  return {
    timestamp: Math.floor(d.getTime() / 1000),
    isoUtc: d.toISOString(),
    isoLocal,
    timeZone,
    parts: {
      year: partsObj.year,
      month: partsObj.month,
      day: partsObj.day,
      hour: partsObj.hour,
      minute: partsObj.minute,
      second: partsObj.second || 0,
    },
  };
}

/**
 * Computes a deterministic SHA-256 state fingerprint for optimistic concurrency.
 */
export function computeAssignmentFingerprint(data: {
  courseId: number;
  assignmentId: number;
  courseModuleId: number;
  name: string;
  introHtml: string | null;
  introStatus: AssignmentIntroStatus;
  moduleVisible: boolean;
  sectionVisible: boolean;
  allowSubmissionsFromDate?: number | null;
  dueDate?: number | null;
  cutoffDate?: number | null;
  alwaysShowDescription?: boolean;
  fileSubmissionEnabled?: boolean;
  maxFiles?: number;
  fileTypes?: string;
  maxSizeBytes?: number;
}): string {
  const canonical = {
    courseId: data.courseId,
    assignmentId: data.assignmentId,
    courseModuleId: data.courseModuleId,
    name: data.name.trim(),
    introHtml: data.introHtml ? data.introHtml.trim() : null,
    introStatus: data.introStatus,
    moduleVisible: Boolean(data.moduleVisible),
    sectionVisible: Boolean(data.sectionVisible),
    allowSubmissionsFromDate: data.allowSubmissionsFromDate ?? null,
    dueDate: data.dueDate ?? null,
    cutoffDate: data.cutoffDate ?? null,
    alwaysShowDescription: Boolean(data.alwaysShowDescription),
    fileSubmissionEnabled: Boolean(data.fileSubmissionEnabled),
    maxFiles: data.maxFiles ?? 1,
    fileTypes: (data.fileTypes || '').toLowerCase().replace(/\s+/g, ''),
    maxSizeBytes: data.maxSizeBytes ?? 0,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface MoodleAssignmentManagerOptions {
  client: MoodleClient;
  config: MoodleConfig;
  webSession: MoodleWebSession;
  auditLogPath?: string;
  defaultTimeZone?: string;
}

const sharedAssignmentManagers = new WeakMap<MoodleClient, MoodleAssignmentManager>();

export function getOrCreateAssignmentManager(
  client: MoodleClient,
  config?: MoodleConfig
): MoodleAssignmentManager {
  let mgr = sharedAssignmentManagers.get(client);
  if (!mgr) {
    const cfg = config ?? client.getConfig();
    const webSession = new MoodleWebSession({
      siteUrl: cfg.siteUrl,
      username: cfg.username,
      password: cfg.password,
    });
    const auditLogPath =
      process.env.ASSIGNMENT_AUDIT_LOG_PATH ||
      path.join(process.cwd(), 'config', 'assignment-audit.jsonl');
    mgr = new MoodleAssignmentManager({
      client,
      config: cfg,
      webSession,
      auditLogPath,
    });
    sharedAssignmentManagers.set(client, mgr);
  }
  return mgr;
}

export class MoodleAssignmentManager {
  private readonly client: MoodleClient;
  private readonly config: MoodleConfig;
  private readonly webSession: MoodleWebSession;
  private readonly auditLogPath?: string;
  private readonly defaultTimeZone: string;
  private readonly plansStore = new Map<string, AssignmentUpdatePlan>();
  private readonly idempotencyStore = new Map<string, CommitAssignmentUpdateResult>();

  constructor(options: MoodleAssignmentManagerOptions) {
    this.client = options.client;
    this.config = options.config;
    this.webSession = options.webSession;
    this.auditLogPath = options.auditLogPath;
    this.defaultTimeZone = options.defaultTimeZone || 'America/Sao_Paulo';
  }

  /**
   * Validates teacher/editing permissions in a course.
   */
  public async checkCourseEditingPermission(courseId: number): Promise<AssignmentActorDetails> {
    const siteInfo = await this.client.getSiteInfo();
    const userId = Number(siteInfo.userid);

    let userRoles: string[] = [];
    try {
      const courses = await this.client.call<any[]>('core_enrol_get_users_courses', {
        userid: userId,
      });
      const c = (courses || []).find((x: any) => Number(x.id) === courseId);
      if (c && Array.isArray(c.roles)) {
        userRoles = c.roles.map((r: any) => String(r.shortname || r.roleid || ''));
      }
    } catch {
      // Ignore if enrolment role listing fails
    }

    const editingRoles = ['editingteacher', 'teacher', 'manager', 'coursecreator', 'admin'];
    const hasEditingRole = userRoles.some((r) => editingRoles.includes(r));

    if (!hasEditingRole && userRoles.length > 0) {
      throw new MoodleAssignmentError(
        'insufficient_permissions',
        `Permissão insuficiente: o usuário autenticado (${siteInfo.username}, ID ${userId}) não possui papel docente com permissão de edição na disciplina ${courseId}. Papéis encontrados: [${userRoles.join(
          ', '
        )}].`,
        { courseId, userId, userRoles }
      );
    }

    return {
      userId,
      username: siteInfo.username,
      fullname: siteInfo.fullname,
      canEdit: true,
      roles: userRoles,
    };
  }

  /**
   * Retrieves complete details of an assignment, explicitly distinguishing intro status,
   * dates with timezone, module/section visibility, and file submission configurations.
   */
  public async getAssignmentDetails(params: {
    courseId?: number;
    assignmentId?: number;
    courseModuleId?: number;
  }): Promise<AssignmentDetailsResult> {
    const { courseId, assignmentId, courseModuleId } = await this.resolveTargetIdentifiers(params);
    const actor = await this.checkCourseEditingPermission(courseId);

    // 1. Fetch assignment list from mod_assign_get_assignments
    const assignRes = await this.client.call<any>('mod_assign_get_assignments', {
      courseids: [courseId],
    });

    const courseObj = (assignRes?.courses || []).find((c: any) => Number(c.id) === courseId);
    if (!courseObj) {
      throw new MoodleAssignmentError(
        'assignment_not_found',
        `Disciplina ${courseId} não encontrada ou sem tarefas no Moodle.`,
        { courseId, assignmentId, courseModuleId }
      );
    }

    const rawAssign = (courseObj.assignments || []).find(
      (a: any) => Number(a.id) === assignmentId || (a.cmid && Number(a.cmid) === courseModuleId)
    );

    if (!rawAssign) {
      throw new MoodleAssignmentError(
        'assignment_not_found',
        `Tarefa com ID ${assignmentId} (cmid ${courseModuleId}) não encontrada na disciplina ${courseId}.`,
        { courseId, assignmentId, courseModuleId }
      );
    }

    const resolvedAssignmentId = Number(rawAssign.id);
    const resolvedCmid = Number(rawAssign.cmid || courseModuleId);

    // 2. Fetch course contents to inspect module visibility, section visibility and restrictions
    const sections = await this.client.call<any[]>('core_course_get_contents', {
      courseid: courseId,
    });

    let targetModule: any;
    let targetSection: any;
    let sectionNum = 0;
    let sectionVisible = true;

    for (const sec of sections || []) {
      for (const mod of sec.modules || []) {
        if (Number(mod.id) === resolvedCmid) {
          targetModule = mod;
          targetSection = sec;
          sectionNum = Number(sec.section ?? 0);
          sectionVisible = sec.visible !== 0 && sec.visible !== false;
          break;
        }
      }
      if (targetModule) break;
    }

    if (targetModule && String(targetModule.modname || '').toLowerCase() !== 'assign') {
      throw new MoodleAssignmentError(
        'not_an_assign_module',
        `O módulo ${resolvedCmid} é do tipo "${targetModule.modname}", mas a operação exige exclusivamente "assign" (mod_assign).`,
        { courseId, courseModuleId: resolvedCmid, modname: targetModule.modname }
      );
    }

    const moduleVisible = targetModule ? targetModule.visible !== 0 && targetModule.visible !== false : true;
    const userVisible = targetModule ? targetModule.uservisible !== false : true;
    const availabilityInfo = targetModule?.availabilityinfo || targetSection?.availabilityinfo || null;

    const accessRestrictions: string[] = [];
    if (!sectionVisible) {
      accessRestrictions.push(
        `A seção ${sectionNum} está oculta para os alunos, impedindo o acesso à atividade mesmo com o módulo visível.`
      );
    }
    if (availabilityInfo) {
      accessRestrictions.push(`Restrições adicionais de disponibilidade: ${availabilityInfo}`);
    }

    // 3. Evaluate statement status explicitly
    let introStatus: AssignmentIntroStatus = 'not_returned';
    let introHtml: string | null = null;
    let introText: string | null = null;
    const introFormat = Number(rawAssign.introformat ?? 1);

    if (rawAssign.intro !== undefined && rawAssign.intro !== null) {
      const rawIntroStr = String(rawAssign.intro);
      if (rawIntroStr.trim().length === 0) {
        introStatus = 'empty';
        introHtml = '';
        introText = '';
      } else {
        introStatus = 'present';
        introHtml = rawIntroStr;
        introText = htmlToText(rawIntroStr);
      }
    } else {
      introStatus = 'not_returned';
    }

    // 4. Attachments
    const attachments = (rawAssign.introattachments || rawAssign.introfiles || []).map((f: any) => ({
      filename: String(f.filename || ''),
      filesize: Number(f.filesize || 0),
      fileurl: String(f.fileurl || ''),
      mimetype: String(f.mimetype || ''),
      timemodified: Number(f.timemodified || 0),
    }));

    // 5. Parse dates
    const tz = this.defaultTimeZone;
    const parseFieldDate = (ts?: number): AssignmentDateDetails => {
      if (!ts || ts <= 0) {
        return {
          enabled: false,
          timestamp: null,
          isoLocal: null,
          isoUtc: null,
          timeZone: tz,
        };
      }
      const parsed = parseAndFormatMoodleDate(ts, tz);
      return {
        enabled: true,
        timestamp: parsed.timestamp,
        isoLocal: parsed.isoLocal,
        isoUtc: parsed.isoUtc,
        timeZone: tz,
      };
    };

    const allowSubDate = parseFieldDate(rawAssign.allowsubmissionsfromdate);
    const dueDate = parseFieldDate(rawAssign.duedate);
    const cutoffDate = parseFieldDate(rawAssign.cutoffdate);
    const gradingDueDate = parseFieldDate(rawAssign.gradingduedate);
    const alwaysShowDescription = Boolean(rawAssign.alwaysshowdescription ?? true);

    // 6. Submission configs
    const configs: Array<{ plugin: string; subtype: string; name: string; value: string }> = Array.isArray(
      rawAssign.configs
    )
      ? rawAssign.configs
      : [];

    const getConfigVal = (plugin: string, name: string): string | undefined => {
      return configs.find(
        (c) =>
          String(c.plugin).toLowerCase() === plugin.toLowerCase() &&
          String(c.name).toLowerCase() === name.toLowerCase()
      )?.value;
    };

    const fileSubEnabled = getConfigVal('assignsubmission_file', 'enabled') === '1';
    const maxFilesStr = getConfigVal('assignsubmission_file', 'maxfilesubmissions');
    const maxFiles = maxFilesStr ? Math.max(1, parseInt(maxFilesStr, 10)) : 1;
    const fileTypes = getConfigVal('assignsubmission_file', 'filetypeslist') || '';
    const maxSizeBytesStr = getConfigVal('assignsubmission_file', 'maxsubmissionsizebytes');
    const maxSizeBytes = maxSizeBytesStr ? parseInt(maxSizeBytesStr, 10) : 0;

    const onlineTextEnabled = getConfigVal('assignsubmission_onlinetext', 'enabled') === '1';
    const commentsEnabled = getConfigVal('assignsubmission_comments', 'enabled') === '1';

    // 7. State Fingerprint
    const stateFingerprint = computeAssignmentFingerprint({
      courseId,
      assignmentId: resolvedAssignmentId,
      courseModuleId: resolvedCmid,
      name: String(rawAssign.name || ''),
      introHtml,
      introStatus,
      moduleVisible,
      sectionVisible,
      allowSubmissionsFromDate: allowSubDate.timestamp,
      dueDate: dueDate.timestamp,
      cutoffDate: cutoffDate.timestamp,
      alwaysShowDescription,
      fileSubmissionEnabled: fileSubEnabled,
      maxFiles,
      fileTypes,
      maxSizeBytes,
    });

    return {
      courseId,
      assignmentId: resolvedAssignmentId,
      courseModuleId: resolvedCmid,
      name: String(rawAssign.name || ''),
      url: `${this.config.siteUrl}/mod/assign/view.php?id=${resolvedCmid}`,
      intro: {
        status: introStatus,
        html: introHtml,
        text: introText,
        format: introFormat,
        attachments,
      },
      visibility: {
        moduleVisible,
        sectionVisible,
        userVisible,
        effectiveVisible: moduleVisible && sectionVisible && userVisible,
        availabilityInfo,
        sectionId: targetSection ? Number(targetSection.id) : undefined,
        sectionNumber: sectionNum,
        accessRestrictions,
      },
      dates: {
        allowSubmissionsFromDate: allowSubDate,
        dueDate,
        cutoffDate,
        gradingDueDate,
        alwaysShowDescription,
      },
      submissionConfig: {
        fileSubmissionEnabled: fileSubEnabled,
        maxFiles,
        fileTypes,
        maxSizeBytes,
        effectiveMaxSizeBytes: maxSizeBytes === 0 ? this.config.maxDownloadBytes : maxSizeBytes,
        onlineTextEnabled,
        commentsEnabled,
      },
      settings: {
        teamSubmission: Boolean(rawAssign.teamsubmission),
        teamSubmissionGroupingId: Number(rawAssign.teamsubmissiongroupingid || 0),
        requireAllTeamMembersSubmit: Boolean(rawAssign.requireallteammemberssubmit),
        preventSubmissionNotInGroup: Boolean(rawAssign.preventsubmissionnotingroup),
        maxGrade: Number(rawAssign.grade ?? 0),
        markingWorkflow: Boolean(rawAssign.markingworkflow),
        markingAllocation: Boolean(rawAssign.markingallocation),
        blindMarking: Boolean(rawAssign.blindmarking),
      },
      permissions: actor,
      dataOrigin: {
        moodleVersion: '4.1.5+',
        fetchedAt: new Date().toISOString(),
        sources: ['mod_assign_get_assignments', 'core_course_get_contents', 'core_enrol_get_users_courses'],
      },
      stateFingerprint,
    };
  }

  /**
   * Prepares a non-destructive assignment update plan. Computes diff, validates constraints,
   * checks independent dates, and produces an approval hash.
   */
  public async prepareAssignmentUpdate(
    params: PrepareAssignmentUpdateParams
  ): Promise<AssignmentUpdatePlan> {
    const current = await this.getAssignmentDetails({
      courseId: params.courseId,
      assignmentId: params.assignmentId,
      courseModuleId: params.courseModuleId,
    });

    // 1. Optimistic fingerprint validation if caller provided expectedFingerprint
    if (params.expectedFingerprint && params.expectedFingerprint !== current.stateFingerprint) {
      throw new MoodleAssignmentError(
        'concurrency_conflict',
        `Conflito de concorrência na preparação: o fingerprint esperado ("${params.expectedFingerprint}") não coincide com o estado atual da tarefa no Moodle ("${current.stateFingerprint}").`,
        { expected: params.expectedFingerprint, current: current.stateFingerprint }
      );
    }

    const patch = params.patch;
    const proposedDiff: Record<string, AssignmentFieldDiff> = {};
    const unchangedFields: string[] = [];
    const sideEffectsAndWarnings: string[] = [];

    // Helper to register unchanged fields
    const checkPreserve = (field: string, isPreserved: boolean) => {
      if (isPreserved) unchangedFields.push(field);
    };

    // 2. Validate Intro Patch
    if (patch.intro !== undefined) {
      if (patch.intro === '' && !patch.clearIntro) {
        throw new MoodleAssignmentError(
          'invalid_patch',
          'Para limpar o enunciado da tarefa, defina explicitamente clearIntro: true junto com intro: "". ' +
            'Esta proteção impede a limpeza acidental do enunciado.'
        );
      }
      if (patch.intro !== current.intro.html) {
        proposedDiff.intro = {
          previous: current.intro.html,
          proposed: patch.intro,
        };
      } else {
        checkPreserve('intro', true);
      }
    } else {
      checkPreserve('intro', true);
    }

    // 3. Validate Visibility Patch
    if (patch.visible !== undefined) {
      if (patch.visible !== current.visibility.moduleVisible) {
        proposedDiff.visible = {
          previous: current.visibility.moduleVisible,
          proposed: patch.visible,
        };
        if (patch.visible && !current.visibility.sectionVisible) {
          sideEffectsAndWarnings.push(
            `Atenção: o módulo da tarefa se tornará visível, mas a seção ${current.visibility.sectionNumber} permanece oculta aos alunos.`
          );
        }
      } else {
        checkPreserve('visible', true);
      }
    } else {
      checkPreserve('visible', true);
    }

    // 4. Validate alwaysShowDescription Patch
    if (patch.alwaysShowDescription !== undefined) {
      if (patch.alwaysShowDescription !== current.dates.alwaysShowDescription) {
        proposedDiff.alwaysShowDescription = {
          previous: current.dates.alwaysShowDescription,
          proposed: patch.alwaysShowDescription,
        };
      } else {
        checkPreserve('alwaysShowDescription', true);
      }
    } else {
      checkPreserve('alwaysShowDescription', true);
    }

    // 5. Validate Dates: allowSubmissionsFromDate
    if (patch.allowSubmissionsFromDate !== undefined) {
      if (patch.allowSubmissionsFromDate === null || !patch.allowSubmissionsFromDate.enabled) {
        if (current.dates.allowSubmissionsFromDate.enabled) {
          proposedDiff.allowSubmissionsFromDate = {
            previous: current.dates.allowSubmissionsFromDate,
            proposed: { enabled: false, timestamp: null, isoLocal: null, isoUtc: null },
          };
        } else {
          checkPreserve('allowSubmissionsFromDate', true);
        }
      } else {
        const dateInput = patch.allowSubmissionsFromDate.date;
        if (!dateInput) {
          throw new MoodleAssignmentError(
            'invalid_date',
            'Campo "date" é obrigatório quando allowSubmissionsFromDate.enabled for true.'
          );
        }
        const parsed = parseAndFormatMoodleDate(
          dateInput,
          patch.allowSubmissionsFromDate.timeZone || this.defaultTimeZone
        );
        proposedDiff.allowSubmissionsFromDate = {
          previous: current.dates.allowSubmissionsFromDate,
          proposed: {
            enabled: true,
            timestamp: parsed.timestamp,
            isoLocal: parsed.isoLocal,
            isoUtc: parsed.isoUtc,
            timeZone: parsed.timeZone,
          },
        };
      }
    } else {
      checkPreserve('allowSubmissionsFromDate', true);
    }

    // 6. Validate Dates: dueDate
    if (patch.dueDate !== undefined) {
      if (patch.dueDate === null || !patch.dueDate.enabled) {
        if (current.dates.dueDate.enabled) {
          proposedDiff.dueDate = {
            previous: current.dates.dueDate,
            proposed: { enabled: false, timestamp: null, isoLocal: null, isoUtc: null },
          };
        } else {
          checkPreserve('dueDate', true);
        }
      } else {
        const dateInput = patch.dueDate.date;
        if (!dateInput) {
          throw new MoodleAssignmentError(
            'invalid_date',
            'Campo "date" é obrigatório quando dueDate.enabled for true.'
          );
        }
        const parsed = parseAndFormatMoodleDate(
          dateInput,
          patch.dueDate.timeZone || this.defaultTimeZone
        );
        proposedDiff.dueDate = {
          previous: current.dates.dueDate,
          proposed: {
            enabled: true,
            timestamp: parsed.timestamp,
            isoLocal: parsed.isoLocal,
            isoUtc: parsed.isoUtc,
            timeZone: parsed.timeZone,
          },
        };
      }
    } else {
      checkPreserve('dueDate', true);
    }

    // 7. Validate Dates: cutoffDate (INDEPENDENT from dueDate!)
    if (patch.cutoffDate !== undefined) {
      if (patch.cutoffDate === null || !patch.cutoffDate.enabled) {
        if (current.dates.cutoffDate.enabled) {
          proposedDiff.cutoffDate = {
            previous: current.dates.cutoffDate,
            proposed: { enabled: false, timestamp: null, isoLocal: null, isoUtc: null },
          };
        } else {
          checkPreserve('cutoffDate', true);
        }
      } else {
        const dateInput = patch.cutoffDate.date;
        if (!dateInput) {
          throw new MoodleAssignmentError(
            'invalid_date',
            'Campo "date" é obrigatório quando cutoffDate.enabled for true.'
          );
        }
        const parsed = parseAndFormatMoodleDate(
          dateInput,
          patch.cutoffDate.timeZone || this.defaultTimeZone
        );
        proposedDiff.cutoffDate = {
          previous: current.dates.cutoffDate,
          proposed: {
            enabled: true,
            timestamp: parsed.timestamp,
            isoLocal: parsed.isoLocal,
            isoUtc: parsed.isoUtc,
            timeZone: parsed.timeZone,
          },
        };
      }
    } else {
      // CRITICAL: dueDate and cutoffDate are independent. Preserved!
      checkPreserve('cutoffDate', true);
    }

    // 8. Validate File Submissions
    if (patch.fileSubmissionEnabled !== undefined) {
      if (patch.fileSubmissionEnabled !== current.submissionConfig.fileSubmissionEnabled) {
        proposedDiff.fileSubmissionEnabled = {
          previous: current.submissionConfig.fileSubmissionEnabled,
          proposed: patch.fileSubmissionEnabled,
        };
      } else {
        checkPreserve('fileSubmissionEnabled', true);
      }
    } else {
      checkPreserve('fileSubmissionEnabled', true);
    }

    if (patch.maxFiles !== undefined) {
      const proposedMax = Math.max(1, patch.maxFiles);
      if (proposedMax < current.submissionConfig.maxFiles && !params.allowReduceMaxFiles) {
        throw new MoodleAssignmentError(
          'invalid_patch',
          `Redução de quantidade máxima de arquivos de ${current.submissionConfig.maxFiles} para ${proposedMax} requer aprovação explícita (defina allowReduceMaxFiles: true).`
        );
      }
      if (proposedMax !== current.submissionConfig.maxFiles) {
        proposedDiff.maxFiles = {
          previous: current.submissionConfig.maxFiles,
          proposed: proposedMax,
        };
      } else {
        checkPreserve('maxFiles', true);
      }
    } else {
      checkPreserve('maxFiles', true);
    }

    if (patch.fileTypes !== undefined) {
      const cleanTypes = patch.fileTypes.trim();
      if (cleanTypes !== current.submissionConfig.fileTypes) {
        proposedDiff.fileTypes = {
          previous: current.submissionConfig.fileTypes,
          proposed: cleanTypes,
        };
      } else {
        checkPreserve('fileTypes', true);
      }
    } else {
      checkPreserve('fileTypes', true);
    }

    const effectiveFileTypes =
      patch.fileTypes !== undefined ? patch.fileTypes : current.submissionConfig.fileTypes;
    if (/\.pdf/i.test(effectiveFileTypes) && /\.zip/i.test(effectiveFileTypes)) {
      sideEffectsAndWarnings.push(
        'Tipos de arquivo aceitos configurados para permitir entregas em PDF e ZIP.'
      );
    }

    if (patch.maxSizeBytes !== undefined) {
      if (patch.maxSizeBytes !== current.submissionConfig.maxSizeBytes) {
        proposedDiff.maxSizeBytes = {
          previous: current.submissionConfig.maxSizeBytes,
          proposed: patch.maxSizeBytes,
        };
      } else {
        checkPreserve('maxSizeBytes', true);
      }
    } else {
      checkPreserve('maxSizeBytes', true);
    }

    // Always preserved settings:
    unchangedFields.push(
      'name',
      'courseModuleId',
      'assignmentId',
      'maxGrade',
      'teamSubmission',
      'onlineTextEnabled',
      'commentsEnabled',
      'introAttachments'
    );

    sideEffectsAndWarnings.push('O MCP não dispara avisos ou notificações automáticas aos alunos.');

    // 9. Generate Deterministic Plan ID and Hash
    const planId = `plan_assign_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const expiresAtMs = Date.now() + 60 * 60 * 1000; // 1 hour validity
    const expiresAt = new Date(expiresAtMs).toISOString();

    const planHashPayload = {
      planId,
      courseId: current.courseId,
      assignmentId: current.assignmentId,
      courseModuleId: current.courseModuleId,
      actorUserId: current.permissions.userId,
      previousFingerprint: current.stateFingerprint,
      proposedDiff,
      expiresAt,
    };
    const planHash = crypto
      .createHmac('sha256', this.config.token || 'moodle-plan-secret')
      .update(JSON.stringify(planHashPayload))
      .digest('hex');

    const plan: AssignmentUpdatePlan = {
      planId,
      planHash,
      createdAt: new Date().toISOString(),
      expiresAt,
      expiresAtMs,
      operationId: params.operationId,
      actor: current.permissions,
      courseId: current.courseId,
      assignmentId: current.assignmentId,
      courseModuleId: current.courseModuleId,
      previousFingerprint: current.stateFingerprint,
      patch,
      proposedDiff,
      unchangedFields: Array.from(new Set(unchangedFields)),
      sideEffectsAndWarnings,
      requiresReviewerConfirmation: true,
      instructionsForApproval:
        `Para aplicar este plano com segurança no Moodle, chame commit_assignment_update com: ` +
        `planId: "${planId}", planHash: "${planHash}" e confirmedByReviewer: true. ` +
        `O plano expira em ${expiresAt}.`,
    };

    this.plansStore.set(planId, plan);
    return plan;
  }

  /**
   * Commits an approved assignment update plan. Validates confirmation, plan integrity,
   * revalidates permissions and concurrency, writes to Moodle via modedit.php, and verifies immediately.
   */
  public async commitAssignmentUpdate(
    params: CommitAssignmentUpdateParams
  ): Promise<CommitAssignmentUpdateResult> {
    // 1. Idempotency Check
    if (params.operationId && this.idempotencyStore.has(params.operationId)) {
      const cached = this.idempotencyStore.get(params.operationId)!;
      return {
        ...cached,
        status: 'idempotent_replay',
        message: `Operação ${params.operationId} já executada anteriormente com sucesso. Estado atual confirmado.`,
      };
    }

    // 2. Validate Reviewer Confirmation
    if (params.confirmedByReviewer !== true) {
      throw new MoodleAssignmentError(
        'approval_required',
        'A gravação no Moodle exige confirmação explícita do revisor humano. Defina confirmedByReviewer: true após revisar o diff gerado por prepare_assignment_update.'
      );
    }

    // 3. Find and Validate Plan
    const plan = this.plansStore.get(params.planId);
    if (!plan) {
      throw new MoodleAssignmentError(
        'plan_not_found',
        `Plano com ID "${params.planId}" não encontrado. Pode ter expirado ou o servidor foi reiniciado. Gere um novo plano com prepare_assignment_update.`
      );
    }

    if (Date.now() > plan.expiresAtMs) {
      this.plansStore.delete(params.planId);
      throw new MoodleAssignmentError(
        'plan_expired',
        `O plano de alteração "${params.planId}" expirou em ${plan.expiresAt}. Gere um novo plano para aprovação.`
      );
    }

    if (params.planHash.trim().toLowerCase() !== plan.planHash.toLowerCase()) {
      throw new MoodleAssignmentError(
        'invalid_plan_hash',
        'Hash de aprovação do plano inválido ou adulterado. O plano não pode ser aplicado com hash divergente do gerado em prepare_assignment_update.'
      );
    }

    // 4. Revalidate Actor Permissions and Live Moodle State
    const actor = await this.checkCourseEditingPermission(plan.courseId);
    const liveCurrent = await this.getAssignmentDetails({
      courseId: plan.courseId,
      assignmentId: plan.assignmentId,
      courseModuleId: plan.courseModuleId,
    });

    // 5. Concurrency Protection Check
    if (liveCurrent.stateFingerprint !== plan.previousFingerprint) {
      throw new MoodleAssignmentError(
        'concurrency_conflict',
        `Conflito de concorrência: a tarefa foi modificada no Moodle após a preparação do plano. ` +
          `Fingerprint atual: "${liveCurrent.stateFingerprint}", Fingerprint do plano: "${plan.previousFingerprint}". ` +
          `Gere um novo plano com prepare_assignment_update para incorporar as mudanças recentes.`,
        { liveFingerprint: liveCurrent.stateFingerprint, planFingerprint: plan.previousFingerprint }
      );
    }

    // 6. Check Web Session Credentials for Official Controller modedit.php
    if (!this.webSession.hasCredentials() && !this.config.token) {
      throw new MoodleAssignmentError(
        'insufficient_permissions',
        'Credenciais (MOODLE_USERNAME/MOODLE_PASSWORD) não configuradas para executar a gravação da tarefa via controlador oficial do Moodle (/course/modedit.php).'
      );
    }

    // 7. Request Official modedit.php Form
    const editPage = await this.webSession.requestPage(
      `/course/modedit.php?update=${plan.courseModuleId}`
    );

    if (editPage.status !== 200 || !/name=["']_qf__mod_assign_mod_form["']/i.test(editPage.html)) {
      const errs = extractMoodleFormErrors(editPage.html);
      throw new MoodleAssignmentError(
        'moodle_api_error',
        `Não foi possível abrir o formulário de edição da tarefa (/course/modedit.php?update=${plan.courseModuleId}): ${
          errs.join('; ') || 'falha de acesso ou permissão negada no Moodle'
        }.`
      );
    }

    // 8. Parse Existing Form Fields to Preserve ALL Unmodified Settings
    const formFields = new URLSearchParams();
    for (const tag of editPage.html.matchAll(/<input[^>]+>/gi)) {
      const name = tag[0].match(/name=["']([^"']+)["']/i)?.[1];
      const val = tag[0].match(/value=["']([^"']*)["']/i)?.[1] ?? '';
      const type = tag[0].match(/type=["']([^"']+)["']/i)?.[1]?.toLowerCase() || 'text';
      if (!name) continue;

      if (type === 'checkbox' || type === 'radio') {
        if (/\bchecked\b/i.test(tag[0])) {
          formFields.set(name, val || '1');
        }
      } else if (type !== 'submit' && type !== 'button' && type !== 'image') {
        formFields.set(name, val);
      }
    }

    for (const tag of editPage.html.matchAll(
      /<select[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi
    )) {
      const name = tag[1];
      const optMatch =
        tag[2].match(/<option[^>]*\bselected\b[^>]*value=["']([^"']*)["']/i) ||
        tag[2].match(/<option[^>]*value=["']([^"']*)["']/i);
      if (optMatch) {
        formFields.set(name, optMatch[1]);
      }
    }

    for (const tag of editPage.html.matchAll(
      /<textarea[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/textarea>/gi
    )) {
      formFields.set(tag[1], tag[2]);
    }

    // 9. Apply the Approved Patch to Form Fields
    const patch = plan.patch;

    // Intro statement
    if (patch.intro !== undefined) {
      formFields.set('introeditor[text]', patch.intro);
      formFields.set('introeditor[format]', String(patch.introFormat ?? 1));
    }

    // Visibility
    if (patch.visible !== undefined) {
      formFields.set('visible', patch.visible ? '1' : '0');
    }

    // Always show description
    if (patch.alwaysShowDescription !== undefined) {
      formFields.set('alwaysshowdescription', patch.alwaysShowDescription ? '1' : '0');
    }

    // Date helper
    const applyDateToForm = (prefix: string, datePatch?: DatePatchInput | null) => {
      if (datePatch === undefined) return; // preserve
      if (datePatch === null || !datePatch.enabled) {
        formFields.delete(`${prefix}[enabled]`);
        return;
      }
      formFields.set(`${prefix}[enabled]`, '1');
      if (datePatch.date) {
        const parsed = parseAndFormatMoodleDate(
          datePatch.date,
          datePatch.timeZone || this.defaultTimeZone
        );
        formFields.set(`${prefix}[day]`, String(parsed.parts.day));
        formFields.set(`${prefix}[month]`, String(parsed.parts.month));
        formFields.set(`${prefix}[year]`, String(parsed.parts.year));
        formFields.set(`${prefix}[hour]`, String(parsed.parts.hour));
        formFields.set(`${prefix}[minute]`, String(parsed.parts.minute));
      }
    };

    applyDateToForm('allowsubmissionsfromdate', patch.allowSubmissionsFromDate);
    applyDateToForm('duedate', patch.dueDate);
    applyDateToForm('cutoffdate', patch.cutoffDate);

    // File submission settings
    if (patch.fileSubmissionEnabled !== undefined) {
      if (patch.fileSubmissionEnabled) {
        formFields.set('assignsubmission_file_enabled', '1');
      } else {
        formFields.delete('assignsubmission_file_enabled');
      }
    }

    if (patch.maxFiles !== undefined) {
      formFields.set('assignsubmission_file_maxfiles', String(patch.maxFiles));
    }

    if (patch.fileTypes !== undefined) {
      formFields.set('assignsubmission_file_filetypes', patch.fileTypes);
    }

    if (patch.maxSizeBytes !== undefined) {
      formFields.set('assignsubmission_file_maxsizebytes', String(patch.maxSizeBytes));
    }

    // Submit button
    formFields.set('submitbutton', 'Save and return to course');

    // 10. Execute POST to /course/modedit.php
    const saveRes = await this.webSession.requestPage('/course/modedit.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formFields.toString(),
    });

    if (/name=["']_qf__mod_assign_mod_form["']/i.test(saveRes.html)) {
      const formErrors = extractMoodleFormErrors(saveRes.html);
      throw new MoodleAssignmentError(
        'moodle_api_error',
        `O formulário do Moodle rejeitou a gravação da tarefa: ${
          formErrors.join('; ') || 'erro de validação nos campos do formulário modedit.php'
        }.`
      );
    }

    // 11. Run Immediate Independent Verification
    const verification = await this.verifyAssignmentUpdate({
      courseId: plan.courseId,
      assignmentId: plan.assignmentId,
      courseModuleId: plan.courseModuleId,
      expectedChanges: plan.proposedDiff,
    });

    if (!verification.verified) {
      throw new MoodleAssignmentError(
        'verification_failed',
        `A gravação da tarefa foi submetida, mas a verificação pós-atualização detectou divergências: ${(
          verification.divergences || []
        ).join('; ')}`,
        { verification }
      );
    }

    const result: CommitAssignmentUpdateResult = {
      success: true,
      status: 'committed_and_verified',
      operationId: params.operationId,
      planId: plan.planId,
      courseId: plan.courseId,
      assignmentId: plan.assignmentId,
      courseModuleId: plan.courseModuleId,
      appliedDiff: plan.proposedDiff,
      verification,
      message:
        `Tarefa "${liveCurrent.name}" (ID ${plan.assignmentId}, cmid ${plan.courseModuleId}) atualizada e verificada com sucesso no Moodle. ` +
        `Campos alterados: [${Object.keys(plan.proposedDiff).join(', ')}].`,
    };

    // 12. Record Audit
    this.recordAudit({
      timestamp: new Date().toISOString(),
      operationId: params.operationId,
      planId: plan.planId,
      planHash: plan.planHash,
      actor: { userId: actor.userId, username: actor.username },
      courseId: plan.courseId,
      assignmentId: plan.assignmentId,
      courseModuleId: plan.courseModuleId,
      assignmentName: liveCurrent.name,
      diff: plan.proposedDiff,
      verified: verification.verified,
      status: 'committed_and_verified',
    });

    // 13. Idempotency store
    if (params.operationId) {
      this.idempotencyStore.set(params.operationId, result);
    }

    // 14. Invalidate used plan
    this.plansStore.delete(params.planId);

    return result;
  }

  /**
   * Performs an independent post-write verification against live Moodle state.
   */
  public async verifyAssignmentUpdate(
    params: VerifyAssignmentUpdateParams
  ): Promise<VerifyAssignmentUpdateResult> {
    const currentDetails = await this.getAssignmentDetails({
      courseId: params.courseId,
      assignmentId: params.assignmentId,
      courseModuleId: params.courseModuleId,
    });

    const checks: Record<string, boolean> = {
      assignmentFound: Boolean(currentDetails.assignmentId),
      moduleFound: Boolean(currentDetails.courseModuleId),
    };
    const divergences: string[] = [];

    // Verify expected changes if provided
    if (params.expectedChanges) {
      for (const [key, diff] of Object.entries(params.expectedChanges)) {
        const expected = diff.proposed !== undefined ? diff.proposed : diff;

        if (key === 'intro') {
          // Normalize whitespace and compare
          const expNorm = String(expected || '').trim();
          const actNorm = String(currentDetails.intro.html || '').trim();
          const matches = expNorm === actNorm || expNorm === htmlToText(actNorm);
          checks.introMatches = matches;
          if (!matches) {
            divergences.push(`Enunciado diverge do esperado`);
          }
        } else if (key === 'visible') {
          const matches = currentDetails.visibility.moduleVisible === Boolean(expected);
          checks.visibleMatches = matches;
          if (!matches) {
            divergences.push(
              `Visibilidade (${currentDetails.visibility.moduleVisible}) diverge do esperado (${expected})`
            );
          }
        } else if (key === 'alwaysShowDescription') {
          const matches = currentDetails.dates.alwaysShowDescription === Boolean(expected);
          checks.alwaysShowDescriptionMatches = matches;
          if (!matches) {
            divergences.push(`alwaysShowDescription diverge do esperado`);
          }
        } else if (key === 'dueDate') {
          if (expected.enabled) {
            const expTs = expected.timestamp;
            const actTs = currentDetails.dates.dueDate.timestamp;
            const matches = expTs && actTs ? Math.abs(expTs - actTs) < 60 : false;
            checks.dueDateMatches = matches;
            if (!matches) {
              divergences.push(
                `dueDate timestamp (${actTs}) diverge do esperado (${expTs}, iso: ${expected.isoUtc})`
              );
            }
          } else {
            checks.dueDateMatches = !currentDetails.dates.dueDate.enabled;
            if (currentDetails.dates.dueDate.enabled) {
              divergences.push('dueDate deveria estar desabilitado mas permaneceu ativo');
            }
          }
        } else if (key === 'cutoffDate') {
          if (expected.enabled) {
            const expTs = expected.timestamp;
            const actTs = currentDetails.dates.cutoffDate.timestamp;
            const matches = expTs && actTs ? Math.abs(expTs - actTs) < 60 : false;
            checks.cutoffDateMatches = matches;
            if (!matches) {
              divergences.push(`cutoffDate timestamp (${actTs}) diverge do esperado (${expTs})`);
            }
          } else {
            checks.cutoffDateMatches = !currentDetails.dates.cutoffDate.enabled;
            if (currentDetails.dates.cutoffDate.enabled) {
              divergences.push('cutoffDate deveria estar desabilitado mas permaneceu ativo');
            }
          }
        } else if (key === 'allowSubmissionsFromDate') {
          if (expected.enabled) {
            const expTs = expected.timestamp;
            const actTs = currentDetails.dates.allowSubmissionsFromDate.timestamp;
            const matches = expTs && actTs ? Math.abs(expTs - actTs) < 60 : false;
            checks.allowSubmissionsFromDateMatches = matches;
            if (!matches) {
              divergences.push(
                `allowSubmissionsFromDate timestamp (${actTs}) diverge do esperado (${expTs})`
              );
            }
          } else {
            checks.allowSubmissionsFromDateMatches =
              !currentDetails.dates.allowSubmissionsFromDate.enabled;
          }
        } else if (key === 'fileSubmissionEnabled') {
          const matches = currentDetails.submissionConfig.fileSubmissionEnabled === Boolean(expected);
          checks.fileSubmissionEnabledMatches = matches;
          if (!matches) divergences.push('fileSubmissionEnabled diverge');
        } else if (key === 'maxFiles') {
          const matches = currentDetails.submissionConfig.maxFiles === Number(expected);
          checks.maxFilesMatches = matches;
          if (!matches) divergences.push(`maxFiles (${currentDetails.submissionConfig.maxFiles}) diverge de ${expected}`);
        } else if (key === 'fileTypes') {
          const expNorm = String(expected || '').toLowerCase().replace(/\s+/g, '');
          const actNorm = String(currentDetails.submissionConfig.fileTypes || '').toLowerCase().replace(/\s+/g, '');
          const matches = expNorm === actNorm;
          checks.fileTypesMatches = matches;
          if (!matches) divergences.push(`fileTypes ("${actNorm}") diverge de "${expNorm}"`);
        } else if (key === 'maxSizeBytes') {
          const matches = currentDetails.submissionConfig.maxSizeBytes === Number(expected);
          checks.maxSizeBytesMatches = matches;
          if (!matches) divergences.push('maxSizeBytes diverge');
        }
      }
    }

    const verified = Object.values(checks).every(Boolean) && divergences.length === 0;
    const status = verified ? 'confirmed' : divergences.length > 0 ? 'divergence' : 'failed';

    return {
      verified,
      status,
      courseId: currentDetails.courseId,
      assignmentId: currentDetails.assignmentId,
      courseModuleId: currentDetails.courseModuleId,
      checks,
      divergences: divergences.length > 0 ? divergences : undefined,
      currentDetails,
    };
  }

  private async resolveTargetIdentifiers(params: {
    courseId?: number;
    assignmentId?: number;
    courseModuleId?: number;
  }): Promise<{ courseId: number; assignmentId?: number; courseModuleId?: number }> {
    if (params.assignmentId) {
      const ctx = await this.client.resolveAssignmentContext(params.assignmentId, params.courseId);
      if (ctx) {
        if (params.courseId && ctx.courseId !== params.courseId) {
          throw new MoodleAssignmentError(
            'course_mismatch',
            `A tarefa ${params.assignmentId} pertence à disciplina ${ctx.courseId}, divergindo do courseId ${params.courseId} informado.`,
            { courseId: params.courseId, actualCourseId: ctx.courseId }
          );
        }
        return {
          courseId: ctx.courseId,
          assignmentId: params.assignmentId,
          courseModuleId: ctx.assignment.cmid || params.courseModuleId,
        };
      }
    }

    if (params.courseId) {
      return {
        courseId: params.courseId,
        assignmentId: params.assignmentId,
        courseModuleId: params.courseModuleId,
      };
    }

    throw new MoodleAssignmentError(
      'assignment_not_found',
      'Forneça courseId e assignmentId (ou courseModuleId) para identificar a tarefa.'
    );
  }

  private recordAudit(entry: Record<string, any>): void {
    if (!this.auditLogPath) return;
    try {
      const dir = path.dirname(this.auditLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const secrets = [this.config.token, this.config.password, process.env.MCP_AUTH_TOKEN];
      const raw = redactSecrets(JSON.stringify(entry), secrets);
      fs.appendFileSync(this.auditLogPath, raw + '\n', 'utf-8');
    } catch {
      // Audit write failures must not break the main operation
    }
  }
}
