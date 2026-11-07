import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAssignmentConsolidatedData,
  formatNormalizedGrade,
  normalizeGradeNumber,
  sha256Text,
} from './assignment-resolver.js';
import { htmlToText, MoodleClient, redactSecrets } from './moodle.js';

export type PublicationStateOption =
  | 'inmarking'
  | 'readyforreview'
  | 'inreview'
  | 'readyforrelease'
  | 'released';

export type NotificationPolicyOption = 'suppress' | 'moodle_default' | 'notify_students';

export type GradingErrorCode =
  | 'invalid_batch_input'
  | 'assignment_not_found'
  | 'confirmation_required'
  | 'plan_not_found_or_expired'
  | 'plan_hash_mismatch'
  | 'plan_has_conflicts'
  | 'operation_id_conflict'
  | 'workflow_not_enabled_on_assignment'
  | 'stale_plan_conflict'
  | 'partial_failure'
  | 'moodle_write_failed';

export class MoodleGradingError extends Error {
  public readonly code: GradingErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: GradingErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MoodleGradingError';
    this.code = code;
    this.details = details;
  }
}

export interface ProposedGradingItem {
  groupId?: number;
  studentId?: number;
  grade?: number;
  gradingFeedbackComment?: string;
  feedback?: string;
  clearFeedback?: boolean;
}

export interface PlanConflictItem {
  code:
    | 'missing_target'
    | 'empty_change'
    | 'general_course_group_rejected'
    | 'group_not_found'
    | 'empty_group'
    | 'student_not_enrolled'
    | 'ambiguous_student_group'
    | 'grade_out_of_range'
    | 'grade_locked'
    | 'member_grade_divergence_conflict'
    | 'duplicate_student_conflict'
    | 'accidental_feedback_clear_blocked';
  message: string;
  groupId?: number;
  studentId?: number;
}

export interface PreparedStudentChange {
  studentId: number;
  fullname: string;
  assignmentGroupId: number | null;
  assignmentGroupName: string | null;
  sourceTargetType: 'group' | 'student';
  sourceTargetId: number;
  gradeAction: 'update' | 'preserve';
  previousGrade: number | null;
  proposedGrade: number | null;
  effectiveMoodleGradeParam: number;
  gradeChanged: boolean;
  feedbackAction: 'update' | 'preserve' | 'clear';
  previousFeedbackText: string | null;
  previousFeedbackHtml: string;
  previousFeedbackSha256: string;
  proposedFeedbackText: string | null;
  effectiveFeedbackHtml: string;
  proposedFeedbackSha256: string;
  feedbackChanged: boolean;
  baselineWorkflowState: string | null;
  baselinePublicationState: string;
  baselineVisibleToStudents: boolean;
  anyEffectiveChange: boolean;
}

export interface PreparedGroupPreview {
  assignmentGroupId: number;
  assignmentGroupName: string;
  memberCount: number;
  affectedStudentIds: number[];
  affectedStudentNames: string[];
  hasSubmitted: boolean;
  previousCommonGrade: string | null;
  proposedGrade: number | null;
  gradeAction: 'update' | 'preserve';
  feedbackAction: 'update' | 'preserve' | 'clear';
  proposedFeedbackPreview: string | null;
  proposedFeedbackSha256: string;
}

export interface PreparedGradingPlan {
  planId: string;
  planHash: string;
  createdAt: string;
  expiresAtMs: number;
  assignmentId: number;
  cmid?: number;
  courseId: number;
  courseName?: string;
  assignmentName: string;
  maxGrade: number;
  isTeamSubmission: boolean;
  markingWorkflowEnabled: boolean;
  moodleGradingUrl?: string;
  groupsTargetedCount: number;
  studentsTargetedCount: number;
  groupPreviews: PreparedGroupPreview[];
  studentChanges: PreparedStudentChange[];
  conflicts: PlanConflictItem[];
  warnings: string[];
}

export interface StudentWriteRecord {
  studentId: number;
  fullname: string;
  assignmentGroupId: number | null;
  status: 'updated' | 'unchanged_skipped' | 'failed' | 'pending';
  previousGrade: number | null;
  newGrade: number | null;
  previousFeedbackSha256: string;
  newFeedbackSha256: string;
  notificationMechanism?: string;
  errorMessage?: string;
  updatedAt?: string;
}

export interface StoredBatchOperation {
  operationId: string;
  planId: string;
  approvedPlanHash: string;
  assignmentId: number;
  courseId: number;
  publicationState: PublicationStateOption;
  notificationPolicy: NotificationPolicyOption;
  status: 'succeeded' | 'partial_failure';
  createdAt: string;
  updatedAt: string;
  moodleGradingUrl?: string;
  groupsExpected: number;
  studentRecords: Record<number, StudentWriteRecord>;
}

export interface GradingAuditEntry {
  auditId: string;
  timestamp: string;
  operation:
    | 'commit_grading_batch'
    | 'commit_grading_batch_blocked'
    | 'verify_grading_batch'
    | 'provide_feedback';
  operationId: string;
  planId?: string;
  planHash?: string;
  actor?: {
    userId: number;
    username: string;
    fullname: string;
  };
  courseId?: number;
  assignmentId: number;
  groupIds: number[];
  affectedStudentIds: number[];
  changeTypes: Array<'grade' | 'gradingFeedbackComments' | 'workflowState'>;
  publicationState?: string;
  notificationPolicy?: string;
  operationStatus:
    | 'succeeded'
    | 'unchanged_no_action_required'
    | 'idempotent_replay'
    | 'partial_failure'
    | 'blocked'
    | 'failed'
    | 'verified'
    | 'verification_mismatch';
  studentDiffs?: Array<{
    studentId: number;
    groupId: number | null;
    previousGrade: number | null;
    newGrade: number | null;
    previousFeedbackSha256: string;
    newFeedbackSha256: string;
    outcome: 'updated' | 'unchanged_skipped' | 'failed' | 'pending';
  }>;
  verificationSummary?: {
    status: 'verified' | 'mismatch_detected';
    studentsExpected: number;
    studentsVerified: number;
    gradeMismatches: number;
    feedbackMismatches: number;
    workflowMismatches: number;
    visibilityMismatches: number;
  };
  reviewerNote?: string;
  errorCode?: string;
  errorMessage?: string;
  officialHistoryNote: string;
}

function resolveDefaultGradingAuditPath(explicitPath?: string, tempDir?: string): string {
  if (explicitPath && explicitPath.trim()) {
    return explicitPath.trim();
  }
  if (process.env.MOODLE_GRADING_AUDIT_LOG_PATH?.trim()) {
    return process.env.MOODLE_GRADING_AUDIT_LOG_PATH.trim();
  }
  try {
    if (fs.existsSync('/config')) {
      fs.accessSync('/config', fs.constants.W_OK);
      return '/config/grading-audit.jsonl';
    }
  } catch {
    // Fall through
  }
  const base = tempDir || path.join(os.tmpdir(), 'ufsc-moodle-mcp-files');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return path.join(base, 'grading-audit.jsonl');
}

function resolveDefaultGradingStatePath(explicitDir?: string, tempDir?: string): string {
  const dir = explicitDir?.trim() || process.env.MOODLE_GRADING_STATE_DIR?.trim();
  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, 'grading-operations.json');
  }
  try {
    if (fs.existsSync('/config')) {
      fs.accessSync('/config', fs.constants.W_OK);
      return '/config/grading-operations.json';
    }
  } catch {
    // Fall through
  }
  const base = tempDir || path.join(os.tmpdir(), 'ufsc-moodle-mcp-files');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return path.join(base, 'grading-operations.json');
}

export function formatPlainOrHtmlFeedback(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    return trimmed;
  }
  return trimmed
    .split(/\n\n+/)
    .map((para) => `<p>${para.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function normalizeTextForComparison(raw: string | null | undefined): string {
  if (!raw) return '';
  return htmlToText(raw)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const PLAN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export class GradingBatchManager {
  private readonly client: MoodleClient;
  private readonly auditLogPath: string;
  private readonly operationsStatePath: string;
  private readonly secrets: (string | undefined)[];
  private readonly plans = new Map<string, PreparedGradingPlan>();
  private readonly operations = new Map<string, StoredBatchOperation>();
  private readonly assignmentLocks = new Map<number, Promise<void>>();

  constructor(client: MoodleClient) {
    this.client = client;
    const cfg = client.getConfig();
    const fallbackDir = client.fileStore.getBaseDir();
    this.auditLogPath = resolveDefaultGradingAuditPath(cfg.gradingAuditLogPath, fallbackDir);
    this.operationsStatePath = resolveDefaultGradingStatePath(cfg.gradingStateDir, fallbackDir);
    this.secrets = [cfg.token, cfg.password, process.env.MCP_AUTH_TOKEN];

    fs.mkdirSync(path.dirname(this.auditLogPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.operationsStatePath), { recursive: true, mode: 0o700 });
    this.hydrateOperationsFromDisk();
  }

  public getAuditLogPath(): string {
    return this.auditLogPath;
  }

  private hydrateOperationsFromDisk(): void {
    if (!fs.existsSync(this.operationsStatePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.operationsStatePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [opId, opVal] of Object.entries(parsed)) {
          if (opVal && typeof opVal === 'object') {
            this.operations.set(opId, opVal as StoredBatchOperation);
          }
        }
      }
    } catch {
      // Ignore corrupted historical state file
    }
  }

  private persistOperationsToDisk(): void {
    try {
      const obj: Record<string, StoredBatchOperation> = {};
      for (const [k, v] of this.operations.entries()) {
        obj[k] = v;
      }
      const payload = redactSecrets(JSON.stringify(obj, null, 2), this.secrets);
      fs.writeFileSync(this.operationsStatePath, payload, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(this.operationsStatePath, 0o600);
      } catch {
        // ignore
      }
    } catch {
      // ignore disk write issues on read-only mounts
    }
  }

  public appendAuditEntry(
    partial: Omit<GradingAuditEntry, 'auditId' | 'timestamp' | 'officialHistoryNote'>
  ): GradingAuditEntry {
    const entry: GradingAuditEntry = {
      auditId: `gaud_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...partial,
      ...(partial.reviewerNote
        ? { reviewerNote: redactSecrets(partial.reviewerNote.slice(0, 300), this.secrets) }
        : {}),
      ...(partial.errorMessage
        ? { errorMessage: redactSecrets(partial.errorMessage, this.secrets) }
        : {}),
      officialHistoryNote:
        'Registro operacional local do MCP (com hashes SHA-256 redigidos); consulte o histórico de notas do Moodle como fonte oficial institucional.',
    };

    const line = `${redactSecrets(JSON.stringify(entry), this.secrets)}\n`;
    fs.appendFileSync(this.auditLogPath, line, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(this.auditLogPath, 0o600);
    } catch {
      // ignore
    }
    return entry;
  }

  public readRecentAuditEntries(limit = 50): GradingAuditEntry[] {
    if (!fs.existsSync(this.auditLogPath)) return [];
    const lines = fs
      .readFileSync(this.auditLogPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    return lines.slice(-limit).map((l) => JSON.parse(l) as GradingAuditEntry);
  }

  private async withAssignmentLock<T>(assignmentId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.assignmentLocks.get(assignmentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.assignmentLocks.set(assignmentId, chained);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.assignmentLocks.get(assignmentId) === chained) {
        this.assignmentLocks.delete(assignmentId);
      }
    }
  }

  private async resolveActorInfo(): Promise<
    { userId: number; username: string; fullname: string } | undefined
  > {
    try {
      const info = await this.client.getSiteInfo();
      return {
        userId: info.userid,
        username: info.username,
        fullname: info.fullname,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * STRICTLY READ-ONLY preparation of a grading batch.
   * Never calls any Moodle write endpoint.
   */
  public async prepareGradingBatch(params: {
    assignmentId: number;
    courseId?: number;
    items: ProposedGradingItem[];
    proposedPublicationState?: PublicationStateOption;
    proposedNotificationPolicy?: NotificationPolicyOption;
    allowMemberGradeOverride?: boolean;
  }): Promise<Record<string, unknown>> {
    const {
      assignmentId,
      courseId,
      items,
      proposedPublicationState,
      proposedNotificationPolicy,
      allowMemberGradeOverride = false,
    } = params;

    if (!Array.isArray(items) || items.length === 0) {
      throw new MoodleGradingError(
        'invalid_batch_input',
        'Informe ao menos um item em items[] para preparar o lote de avaliações.'
      );
    }

    // Sweep expired plans
    const now = Date.now();
    for (const [id, p] of this.plans.entries()) {
      if (p.expiresAtMs <= now) this.plans.delete(id);
    }

    // Fetch fresh live baseline from Moodle (read-only)
    const data = await buildAssignmentConsolidatedData(this.client, assignmentId, {
      courseId,
      fresh: true,
      includeFeedback: true,
    });
    const { ctx } = data;
    const siteUrl = this.client.getConfig().siteUrl.replace(/\/+$/, '');
    const moodleGradingUrl = ctx.assignment.cmid
      ? `${siteUrl}/mod/assign/view.php?id=${ctx.assignment.cmid}&action=grading`
      : undefined;

    const conflicts: PlanConflictItem[] = [];
    const warnings: string[] = [];
    const studentChangesById = new Map<number, PreparedStudentChange>();
    const groupPreviews: PreparedGroupPreview[] = [];
    const groupsTargetedSet = new Set<number>();

    if (
      proposedPublicationState &&
      proposedPublicationState !== 'released' &&
      !ctx.assignment.markingworkflow
    ) {
      warnings.push(
        `A tarefa ${assignmentId} está com markingworkflow desabilitado (markingworkflow=0) no Moodle. O Moodle não retém notas em estado "${proposedPublicationState}" sem workflow ativo; para publicar nesta tarefa, será necessário autorizar explicitamente publicationState="released" (ou ativar o fluxo de avaliação na atividade do Moodle).`
      );
    }

    for (const item of items) {
      const hasGroupTarget = item.groupId !== undefined && item.groupId > 0;
      const hasStudentTarget = item.studentId !== undefined && item.studentId > 0;

      if (!hasGroupTarget && !hasStudentTarget) {
        conflicts.push({
          code: 'missing_target',
          message: 'Cada item do lote deve especificar groupId (> 0) ou studentId (> 0).',
        });
        continue;
      }

      const rawProposedFeedback =
        item.gradingFeedbackComment !== undefined ? item.gradingFeedbackComment : item.feedback;
      const hasGradeProposal = item.grade !== undefined;
      const hasFeedbackProposal = rawProposedFeedback !== undefined || item.clearFeedback === true;

      if (!hasGradeProposal && !hasFeedbackProposal) {
        conflicts.push({
          code: 'empty_change',
          groupId: item.groupId,
          studentId: item.studentId,
          message:
            'Nenhum campo de alteração informado (forneça grade e/ou gradingFeedbackComment).',
        });
        continue;
      }

      if (hasGradeProposal) {
        const gNum = Number(item.grade);
        if (
          !Number.isFinite(gNum) ||
          gNum < 0 ||
          (ctx.assignment.maxGrade > 0 && gNum > ctx.assignment.maxGrade)
        ) {
          conflicts.push({
            code: 'grade_out_of_range',
            groupId: item.groupId,
            studentId: item.studentId,
            message: `Nota proposta (${item.grade}) está fora do intervalo permitido da tarefa [0 .. ${ctx.assignment.maxGrade}].`,
          });
          continue;
        }
      }

      let targetStudentIds: number[] = [];
      let sourceTargetType: 'group' | 'student' = 'student';
      let sourceTargetId = 0;

      if (hasGroupTarget) {
        const gid = item.groupId!;
        sourceTargetType = 'group';
        sourceTargetId = gid;

        if (data.generalCourseGroupIds.has(gid)) {
          conflicts.push({
            code: 'general_course_group_rejected',
            groupId: gid,
            message: `O grupo ${gid} corresponde a um grupo geral da turma/disciplina (e não a uma equipe de projeto da tarefa). Operação bloqueada para evitar afetar equipes distintas.`,
          });
          continue;
        }

        const gRecord = data.groupRecords.get(gid);
        if (!gRecord) {
          conflicts.push({
            code: 'group_not_found',
            groupId: gid,
            message: `Grupo ${gid} não encontrado entre os grupos válidos da tarefa ${assignmentId}.`,
          });
          continue;
        }

        if (gRecord.members.length === 0) {
          conflicts.push({
            code: 'empty_group',
            groupId: gid,
            message: `Grupo "${gRecord.assignmentGroupName}" (${gid}) não possui estudantes integrantes.`,
          });
          continue;
        }

        if (hasGradeProposal && gRecord.hasGradeDivergence && !allowMemberGradeOverride) {
          conflicts.push({
            code: 'member_grade_divergence_conflict',
            groupId: gid,
            message: `Grupo "${gRecord.assignmentGroupName}" (${gid}) possui notas individuais divergentes ([${gRecord.distinctMemberGrades.join(', ')}]). Defina allowMemberGradeOverride=true ou avalie por studentId se desejar sobrescrever notas individuais divergentes.`,
          });
          continue;
        }

        if (!gRecord.hasSubmitted) {
          warnings.push(
            `Grupo "${gRecord.assignmentGroupName}" (${gid}) consta sem entrega enviada na tarefa.`
          );
        }

        targetStudentIds = gRecord.members.map((m) => m.id);
        groupsTargetedSet.add(gid);
      } else {
        const sid = item.studentId!;
        sourceTargetType = 'student';
        sourceTargetId = sid;

        const studentRes = data.studentResolutions.get(sid);
        if (!studentRes) {
          conflicts.push({
            code: 'student_not_enrolled',
            studentId: sid,
            message: `Estudante ${sid} não está matriculado como participante estudante na tarefa ${assignmentId}.`,
          });
          continue;
        }

        if (studentRes.groupResolutionStatus === 'ambiguous') {
          conflicts.push({
            code: 'ambiguous_student_group',
            studentId: sid,
            message: `Estudante "${studentRes.fullname}" (${sid}) pertence a múltiplos grupos candidatos na tarefa ([${(studentRes.ambiguousGroupCandidates || []).map((c) => `${c.id}:${c.name}`).join(', ')}]).`,
          });
          continue;
        }

        targetStudentIds = [sid];
        if (studentRes.assignmentGroupId) {
          groupsTargetedSet.add(studentRes.assignmentGroupId);
        }
      }

      // Compute per-student changes with strict preservation of omitted fields
      let groupFeedbackSha = '';
      let groupFeedbackPreview: string | null = null;
      let groupGradeAction: 'update' | 'preserve' = hasGradeProposal ? 'update' : 'preserve';
      let groupFeedbackAction: 'update' | 'preserve' | 'clear' = 'preserve';

      for (const sid of targetStudentIds) {
        if (studentChangesById.has(sid)) {
          conflicts.push({
            code: 'duplicate_student_conflict',
            studentId: sid,
            groupId: item.groupId,
            message: `Estudante ${sid} foi incluído mais de uma vez no mesmo lote de avaliação.`,
          });
          continue;
        }

        const currentEval = data.memberEvaluationsByUserId.get(sid);
        if (!currentEval) {
          conflicts.push({
            code: 'student_not_enrolled',
            studentId: sid,
            message: ` Avaliação atual do estudante ${sid} não pôde ser resolvida.`,
          });
          continue;
        }

        if (currentEval.gradeIsLocked || currentEval.userFlagLocked) {
          conflicts.push({
            code: 'grade_locked',
            studentId: sid,
            groupId: currentEval.assignmentGroupId ?? undefined,
            message: `A avaliação do estudante "${currentEval.fullname}" (${sid}) está bloqueada (locked) no Moodle.`,
          });
          continue;
        }

        const previousGrade = currentEval.numericGrade;
        const proposedGrade = hasGradeProposal ? normalizeGradeNumber(item.grade!) : previousGrade;
        // Moodle mod_assign_save_grade uses -1 to represent "no grade assigned"
        const effectiveMoodleGradeParam = proposedGrade !== null ? proposedGrade : -1;
        const gradeChanged =
          hasGradeProposal &&
          (previousGrade === null ||
            proposedGrade === null ||
            Math.abs(previousGrade - proposedGrade) > 1e-5);
        const gradeAction: 'update' | 'preserve' = gradeChanged ? 'update' : 'preserve';

        const previousFeedbackText = currentEval.gradingFeedbackComment;
        const previousFeedbackHtml = currentEval.gradingFeedbackHtml || '';
        const previousFeedbackSha256 = currentEval.gradingFeedbackSha256;

        let feedbackAction: 'update' | 'preserve' | 'clear' = 'preserve';
        let effectiveFeedbackHtml = previousFeedbackHtml;
        let proposedFeedbackText = previousFeedbackText;

        if (item.clearFeedback === true) {
          if (previousFeedbackText || previousFeedbackHtml) {
            feedbackAction = 'clear';
            effectiveFeedbackHtml = '';
            proposedFeedbackText = null;
          } else {
            feedbackAction = 'preserve';
            effectiveFeedbackHtml = '';
            proposedFeedbackText = null;
          }
        } else if (rawProposedFeedback !== undefined) {
          if (rawProposedFeedback.trim() === '' && previousFeedbackText) {
            conflicts.push({
              code: 'accidental_feedback_clear_blocked',
              studentId: sid,
              groupId: currentEval.assignmentGroupId ?? undefined,
              message: `String vazia recebida em gradingFeedbackComment para "${currentEval.fullname}" (${sid}), que já possui comentário registrado. Omita gradingFeedbackComment para preservar o comentário existente ou informe clearFeedback=true se desejar apagá-lo intencionalmente.`,
            });
            continue;
          }
          const formattedHtml = formatPlainOrHtmlFeedback(rawProposedFeedback);
          const normalizedProposed = normalizeTextForComparison(formattedHtml) || null;
          const normalizedPrevious =
            normalizeTextForComparison(previousFeedbackHtml || previousFeedbackText) || null;

          if (normalizedProposed === normalizedPrevious) {
            feedbackAction = 'preserve';
            effectiveFeedbackHtml = previousFeedbackHtml;
            proposedFeedbackText = previousFeedbackText;
          } else {
            feedbackAction = 'update';
            effectiveFeedbackHtml = formattedHtml;
            proposedFeedbackText = normalizedProposed;
          }
        }

        const proposedFeedbackSha256 =
          feedbackAction === 'preserve'
            ? previousFeedbackSha256
            : sha256Text(proposedFeedbackText);

        const feedbackChanged =
          feedbackAction !== 'preserve' && proposedFeedbackSha256 !== previousFeedbackSha256;

        if (!feedbackChanged && feedbackAction !== 'clear') {
          feedbackAction = 'preserve';
        }

        studentChangesById.set(sid, {
          studentId: sid,
          fullname: currentEval.fullname,
          assignmentGroupId: currentEval.assignmentGroupId,
          assignmentGroupName: currentEval.assignmentGroupName,
          sourceTargetType,
          sourceTargetId,
          gradeAction,
          previousGrade,
          proposedGrade,
          effectiveMoodleGradeParam,
          gradeChanged,
          feedbackAction,
          previousFeedbackText,
          previousFeedbackHtml,
          previousFeedbackSha256,
          proposedFeedbackText,
          effectiveFeedbackHtml,
          proposedFeedbackSha256,
          feedbackChanged,
          baselineWorkflowState: currentEval.workflowState,
          baselinePublicationState: currentEval.publicationState,
          baselineVisibleToStudents: currentEval.visibleToStudents,
          anyEffectiveChange: gradeChanged || feedbackChanged,
        });
      }

      if (hasGroupTarget) {
        const gRecord = data.groupRecords.get(item.groupId!);
        if (gRecord) {
          const memberChanges = gRecord.members
            .map((m) => studentChangesById.get(m.id))
            .filter((sc): sc is PreparedStudentChange => sc !== undefined);

          const anyMemberGradeChange = memberChanges.some((sc) => sc.gradeChanged);
          const anyMemberFeedbackChange = memberChanges.some((sc) => sc.feedbackChanged);

          const effectiveGroupGradeAction: 'update' | 'preserve' = anyMemberGradeChange
            ? 'update'
            : 'preserve';
          const effectiveGroupFeedbackAction: 'update' | 'preserve' | 'clear' = anyMemberFeedbackChange
            ? item.clearFeedback
              ? 'clear'
              : 'update'
            : 'preserve';

          const firstSc = memberChanges[0];

          groupPreviews.push({
            assignmentGroupId: gRecord.assignmentGroupId,
            assignmentGroupName: gRecord.assignmentGroupName,
            memberCount: gRecord.memberCount,
            affectedStudentIds: gRecord.members.map((m) => m.id),
            affectedStudentNames: gRecord.members.map((m) => m.fullname),
            hasSubmitted: gRecord.hasSubmitted,
            previousCommonGrade: gRecord.commonGroupGrade,
            proposedGrade: hasGradeProposal ? normalizeGradeNumber(item.grade!) : null,
            gradeAction: effectiveGroupGradeAction,
            feedbackAction: effectiveGroupFeedbackAction,
            proposedFeedbackPreview: firstSc?.proposedFeedbackText
              ? firstSc.proposedFeedbackText.slice(0, 280)
              : null,
            proposedFeedbackSha256: firstSc?.proposedFeedbackSha256 || '',
          });
        }
      }
    }

    const orderedStudentChanges = Array.from(studentChangesById.values()).sort(
      (a, b) => a.studentId - b.studentId
    );

    const canonicalPayloadForHash = JSON.stringify({
      assignmentId: ctx.assignment.id,
      courseId: ctx.courseId,
      markingWorkflowEnabled: ctx.assignment.markingworkflow,
      students: orderedStudentChanges.map((sc) => ({
        studentId: sc.studentId,
        groupId: sc.assignmentGroupId,
        previousGrade: formatNormalizedGrade(sc.previousGrade),
        proposedGrade: formatNormalizedGrade(sc.proposedGrade),
        gradeAction: sc.gradeAction,
        previousFeedbackSha256: sc.previousFeedbackSha256,
        proposedFeedbackSha256: sc.proposedFeedbackSha256,
        feedbackAction: sc.feedbackAction,
        baselineWorkflowState: sc.baselineWorkflowState,
      })),
    });

    const planHash = `sha256_${crypto
      .createHash('sha256')
      .update(canonicalPayloadForHash, 'utf8')
      .digest('hex')}`;
    const planId = `plan_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const createdAt = new Date(now).toISOString();
    const expiresAtMs = now + PLAN_TTL_MS;

    const plan: PreparedGradingPlan = {
      planId,
      planHash,
      createdAt,
      expiresAtMs,
      assignmentId: ctx.assignment.id,
      cmid: ctx.assignment.cmid,
      courseId: ctx.courseId,
      courseName: ctx.courseName,
      assignmentName: ctx.assignment.name,
      maxGrade: ctx.assignment.maxGrade,
      isTeamSubmission: ctx.assignment.teamsubmission,
      markingWorkflowEnabled: ctx.assignment.markingworkflow,
      moodleGradingUrl,
      groupsTargetedCount: groupsTargetedSet.size,
      studentsTargetedCount: orderedStudentChanges.length,
      groupPreviews,
      studentChanges: orderedStudentChanges,
      conflicts,
      warnings,
    };

    this.plans.set(planId, plan);

    const studentsWithGradeChanges = orderedStudentChanges.filter((s) => s.gradeChanged).length;
    const studentsWithFeedbackChanges = orderedStudentChanges.filter(
      (s) => s.feedbackChanged
    ).length;
    const studentsUnchanged = orderedStudentChanges.filter((s) => !s.anyEffectiveChange).length;
    const studentsWithEffectiveChanges = orderedStudentChanges.filter(
      (s) => s.anyEffectiveChange
    ).length;

    let status: 'prepared_ready_for_review' | 'prepared_no_changes' | 'prepared_with_conflicts';
    let readyToCommit: boolean;

    if (conflicts.length > 0) {
      status = 'prepared_with_conflicts';
      readyToCommit = false;
    } else if (studentsWithEffectiveChanges === 0) {
      status = 'prepared_no_changes';
      readyToCommit = false;
    } else {
      status = 'prepared_ready_for_review';
      readyToCommit = true;
    }

    return {
      status,
      readOnlyGuarantee: true,
      writesPerformed: 0,
      planId,
      planHash,
      createdAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      readyToCommit,
      assignment: {
        id: ctx.assignment.id,
        cmid: ctx.assignment.cmid ?? null,
        courseId: ctx.courseId,
        courseName: ctx.courseName ?? null,
        name: ctx.assignment.name,
        maxGrade: ctx.assignment.maxGrade,
        isTeamSubmission: ctx.assignment.teamsubmission,
        markingWorkflowEnabled: ctx.assignment.markingworkflow,
        ...(moodleGradingUrl ? { moodleGradingUrl } : {}),
      },
      targetCommentField: 'gradingFeedbackComments',
      summary: {
        itemsReceived: items.length,
        groupsTargetedCount: groupsTargetedSet.size,
        studentsTargetedCount: orderedStudentChanges.length,
        studentsAffectedCount: orderedStudentChanges.length,
        studentsWithEffectiveChangesCount: studentsWithEffectiveChanges,
        hasEffectiveChanges: studentsWithEffectiveChanges > 0,
        studentsWithGradeChanges,
        studentsWithFeedbackChanges,
        studentsUnchangedCount: studentsUnchanged,
        conflictsCount: conflicts.length,
        warningsCount: warnings.length,
        ...(proposedPublicationState ? { proposedPublicationState } : {}),
        ...(proposedNotificationPolicy ? { proposedNotificationPolicy } : {}),
      },
      ...(groupPreviews.length > 0 ? { groupPreviews } : {}),
      studentChanges: orderedStudentChanges.map((sc) => ({
        studentId: sc.studentId,
        fullname: sc.fullname,
        assignmentGroupId: sc.assignmentGroupId,
        assignmentGroupName: sc.assignmentGroupName,
        gradeAction: sc.gradeAction,
        previousGrade: sc.previousGrade,
        proposedGrade: sc.proposedGrade,
        gradeChanged: sc.gradeChanged,
        feedbackAction: sc.feedbackAction,
        previousFeedbackPreview: sc.previousFeedbackText
          ? sc.previousFeedbackText.slice(0, 200)
          : null,
        proposedFeedbackPreview: sc.proposedFeedbackText
          ? sc.proposedFeedbackText.slice(0, 200)
          : null,
        previousFeedbackSha256: sc.previousFeedbackSha256,
        proposedFeedbackSha256: sc.proposedFeedbackSha256,
        feedbackChanged: sc.feedbackChanged,
        anyEffectiveChange: sc.anyEffectiveChange,
        baselineWorkflowState: sc.baselineWorkflowState,
        baselinePublicationState: sc.baselinePublicationState,
      })),
      conflicts,
      warnings,
      humanApprovalRequired: {
        required: true,
        summary:
          'Nenhuma alteração foi gravada no Moodle. O fluxo exige autorização humana explícita do professor antes da publicação.',
        levels: {
          technicalValidation:
            'Validação técnica concluída: os dados propostos cumprem as restrições de tipo, escala e mapeamento de grupos da tarefa.',
          planIntegrity:
            'Integridade criptográfica garantida pelo approvedPlanHash (SHA-256 canônico). Qualquer alteração no estado ou no plano invalida o hash.',
          clientConfirmation:
            'O parâmetro confirmedByReviewer=true registra a confirmação declarada pela aplicação/agente MCP chamador. Por si só, NÃO comprova autorização humana independente.',
          humanAuthorization:
            'A autorização humana efetiva é prerrogativa indelegável do professor. O agente NÃO pode autoaprovar lotes de avaliação; a interface cliente deve colher a aprovação explícita do docente antes de chamar commit_grading_batch.',
        },
        protocolRule:
          'Nenhuma nota ou comentário pode ser publicado pelo agente antes de o professor revisar e autorizar explicitamente o conteúdo apresentado.',
      },
    };
  }

  /**
   * Commits an approved grading plan with optimistic concurrency check, idempotency by
   * `operationId`, partial-failure recovery, notification control, and redacted audit logging.
   */
  public async commitGradingBatch(params: {
    planId: string;
    approvedPlanHash: string;
    confirmedByReviewer: boolean;
    operationId: string;
    publicationState: PublicationStateOption;
    notificationPolicy: NotificationPolicyOption;
    resumeFailedOnly?: boolean;
    reviewerNote?: string;
  }): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
    const {
      planId,
      approvedPlanHash,
      confirmedByReviewer,
      operationId,
      publicationState,
      notificationPolicy,
      resumeFailedOnly = true,
      reviewerNote,
    } = params;

    const existingOp = this.operations.get(operationId);
    const plan = this.plans.get(planId);
    const targetAssignmentId = plan?.assignmentId ?? existingOp?.assignmentId ?? 0;

    return this.withAssignmentLock(targetAssignmentId, async () => {
      const actor = await this.resolveActorInfo();

      // 1. Explicit reviewer confirmation check
      if (confirmedByReviewer !== true) {
        this.appendAuditEntry({
          operation: 'commit_grading_batch_blocked',
          operationId,
          planId,
          planHash: approvedPlanHash,
          actor,
          courseId: plan?.courseId ?? existingOp?.courseId,
          assignmentId: targetAssignmentId,
          groupIds: [],
          affectedStudentIds: [],
          changeTypes: [],
          publicationState,
          notificationPolicy,
          operationStatus: 'blocked',
          reviewerNote,
          errorCode: 'confirmation_required',
          errorMessage: 'Publicação bloqueada: confirmedByReviewer deve ser explicitamente true após revisão humana do professor.',
        });
        throw new MoodleGradingError(
          'confirmation_required',
          'Publicação bloqueada: confirmedByReviewer=true é obrigatório e exige revisão e autorização explícita do professor.'
        );
      }

      // 2. Check idempotency by operationId
      const prevOp = this.operations.get(operationId);
      if (prevOp) {
        if (
          prevOp.planId !== planId ||
          !safeEqualStrings(prevOp.approvedPlanHash, approvedPlanHash)
        ) {
          throw new MoodleGradingError(
            'operation_id_conflict',
            `O operationId "${operationId}" já foi utilizado para outro plano (${prevOp.planId}). Use um novo operationId para publicar um plano diferente.`
          );
        }

        if (prevOp.status === 'succeeded') {
          const records = Object.values(prevOp.studentRecords);
          const groupIds = Array.from(
            new Set(
              records
                .map((r) => r.assignmentGroupId)
                .filter((g): g is number => typeof g === 'number' && g > 0)
            )
          );
          this.appendAuditEntry({
            operation: 'commit_grading_batch',
            operationId,
            planId,
            planHash: approvedPlanHash,
            actor,
            courseId: prevOp.courseId,
            assignmentId: prevOp.assignmentId,
            groupIds,
            affectedStudentIds: records.map((r) => r.studentId),
            changeTypes: ['grade', 'gradingFeedbackComments'],
            publicationState: prevOp.publicationState,
            notificationPolicy: prevOp.notificationPolicy,
            operationStatus: 'idempotent_replay',
            reviewerNote,
          });

          return {
            isError: false,
            payload: {
              status: 'idempotent_replay',
              idempotentReplay: true,
              operationId,
              planId,
              approvedPlanHash,
              assignmentId: prevOp.assignmentId,
              courseId: prevOp.courseId,
              commentTypeUpdated: 'gradingFeedbackComments',
              publicationState: prevOp.publicationState,
              visibleToStudents: prevOp.publicationState === 'released',
              notificationPolicy: prevOp.notificationPolicy,
              ...(prevOp.moodleGradingUrl ? { moodleGradingUrl: prevOp.moodleGradingUrl } : {}),
              updatedStudentsCount: records.filter(
                (r) => r.status === 'updated' || r.status === 'unchanged_skipped'
              ).length,
              failedStudentsCount: 0,
              affectedStudents: records,
              note: 'Operação já concluída anteriormente com este operationId; nenhuma escrita ou notificação duplicada foi enviada ao Moodle.',
            },
          };
        }
      }

      // 3. Validate prepared plan & approved hash
      if (!plan || plan.expiresAtMs <= Date.now()) {
        throw new MoodleGradingError(
          'plan_not_found_or_expired',
          `Plano "${planId}" não encontrado ou expirado. Execute prepare_grading_batch novamente para gerar uma prévia atualizada.`
        );
      }

      if (!safeEqualStrings(plan.planHash, approvedPlanHash)) {
        this.appendAuditEntry({
          operation: 'commit_grading_batch_blocked',
          operationId,
          planId,
          planHash: approvedPlanHash,
          actor,
          courseId: plan.courseId,
          assignmentId: plan.assignmentId,
          groupIds: [],
          affectedStudentIds: plan.studentChanges.map((s) => s.studentId),
          changeTypes: [],
          publicationState,
          notificationPolicy,
          operationStatus: 'blocked',
          reviewerNote,
          errorCode: 'plan_hash_mismatch',
          errorMessage: 'O approvedPlanHash informado não corresponde ao planHash do plano preparado.',
        });
        throw new MoodleGradingError(
          'plan_hash_mismatch',
          'Publicação bloqueada: approvedPlanHash diverge do planHash do plano preparado.'
        );
      }

      if (plan.conflicts.length > 0) {
        throw new MoodleGradingError(
          'plan_has_conflicts',
          `O plano "${planId}" contém ${plan.conflicts.length} conflito(s) pendente(s) e não pode ser publicado.`,
          { conflicts: plan.conflicts }
        );
      }

      // 4. Block silent release if assignment has markingworkflow=false and caller asked for non-released state
      if (!plan.markingWorkflowEnabled && publicationState !== 'released') {
        this.appendAuditEntry({
          operation: 'commit_grading_batch_blocked',
          operationId,
          planId,
          planHash: approvedPlanHash,
          actor,
          courseId: plan.courseId,
          assignmentId: plan.assignmentId,
          groupIds: [],
          affectedStudentIds: plan.studentChanges.map((s) => s.studentId),
          changeTypes: [],
          publicationState,
          notificationPolicy,
          operationStatus: 'blocked',
          reviewerNote,
          errorCode: 'workflow_not_enabled_on_assignment',
          errorMessage: `Solicitado publicationState="${publicationState}", mas markingworkflow=0 na tarefa ${plan.assignmentId}.`,
        });
        throw new MoodleGradingError(
          'workflow_not_enabled_on_assignment',
          `Publicação bloqueada por segurança: foi solicitado publicationState="${publicationState}" (não liberado aos alunos), porém a tarefa ${plan.assignmentId} está com markingworkflow=0 no Moodle, o que tornaria as notas/comentários imediatamente visíveis aos estudantes. Ative o Fluxo de Avaliação na tarefa ou solicite explicitamente publicationState="released".`
        );
      }

      // 4.5. Fast-path & security check: if the plan has NO effective changes, do not call Moodle write endpoints!
      if (plan.studentChanges.every((sc) => !sc.anyEffectiveChange)) {
        const records: Record<number, StudentWriteRecord> = {};
        for (const sc of plan.studentChanges) {
          records[sc.studentId] = {
            studentId: sc.studentId,
            fullname: sc.fullname,
            assignmentGroupId: sc.assignmentGroupId,
            status: 'unchanged_skipped',
            previousGrade: sc.previousGrade,
            newGrade: sc.previousGrade,
            previousFeedbackSha256: sc.previousFeedbackSha256,
            newFeedbackSha256: sc.previousFeedbackSha256,
            notificationMechanism: 'none_no_changes',
            updatedAt: new Date().toISOString(),
          };
        }

        const noOpRecord: StoredBatchOperation = {
          operationId,
          planId,
          approvedPlanHash,
          assignmentId: plan.assignmentId,
          courseId: plan.courseId,
          publicationState,
          notificationPolicy,
          status: 'succeeded',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          moodleGradingUrl: plan.moodleGradingUrl,
          groupsExpected: plan.groupsTargetedCount,
          studentRecords: records,
        };
        this.operations.set(operationId, noOpRecord);
        this.persistOperationsToDisk();

        this.appendAuditEntry({
          operation: 'commit_grading_batch',
          operationId,
          planId,
          planHash: approvedPlanHash,
          actor,
          courseId: plan.courseId,
          assignmentId: plan.assignmentId,
          groupIds: plan.groupPreviews.map((g) => g.assignmentGroupId),
          affectedStudentIds: plan.studentChanges.map((s) => s.studentId),
          changeTypes: [],
          publicationState,
          notificationPolicy,
          operationStatus: 'unchanged_no_action_required',
          reviewerNote,
        });

        return {
          isError: false,
          payload: {
            status: 'unchanged_no_action_required',
            operationId,
            planId,
            approvedPlanHash,
            assignmentId: plan.assignmentId,
            courseId: plan.courseId,
            writesPerformed: 0,
            publicationState,
            visibleToStudents: publicationState === 'released',
            notificationPolicy,
            ...(plan.moodleGradingUrl ? { moodleGradingUrl: plan.moodleGradingUrl } : {}),
            updatedStudentsCount: 0,
            unchangedStudentsCount: plan.studentChanges.length,
            failedStudentsCount: 0,
            affectedStudents: Object.values(records),
            note: 'Plano não continha alterações efetivas de notas ou comentários. Nenhuma chamada de escrita ou notificação foi realizada no Moodle (operação idempotente e sem efeitos colaterais).',
          },
        };
      }

      // 5. Determine which student records are pending (all on first run, or failed/pending on recovery)
      const studentRecords: Record<number, StudentWriteRecord> = prevOp
        ? { ...prevOp.studentRecords }
        : {};
      const pendingChanges = plan.studentChanges.filter((sc) => {
        if (!prevOp || !resumeFailedOnly) return true;
        const prior = studentRecords[sc.studentId];
        return !prior || (prior.status !== 'updated' && prior.status !== 'unchanged_skipped');
      });

      // 6. Live optimistic concurrency check against current Moodle state BEFORE any write!
      const liveData = await buildAssignmentConsolidatedData(this.client, plan.assignmentId, {
        courseId: plan.courseId,
        fresh: true,
        includeFeedback: true,
      });

      const staleConflicts: Array<{
        studentId: number;
        fullname: string;
        field: 'grade' | 'gradingFeedbackComments' | 'workflowState' | 'locked';
        expectedBaseline: unknown;
        liveValue: unknown;
      }> = [];

      for (const sc of pendingChanges) {
        const liveEval = liveData.memberEvaluationsByUserId.get(sc.studentId);
        if (!liveEval) {
          staleConflicts.push({
            studentId: sc.studentId,
            fullname: sc.fullname,
            field: 'grade',
            expectedBaseline: sc.previousGrade,
            liveValue: 'student_not_found',
          });
          continue;
        }
        if (liveEval.gradeIsLocked || liveEval.userFlagLocked) {
          staleConflicts.push({
            studentId: sc.studentId,
            fullname: sc.fullname,
            field: 'locked',
            expectedBaseline: false,
            liveValue: true,
          });
        }
        const baselineNorm = formatNormalizedGrade(sc.previousGrade);
        const liveNorm = formatNormalizedGrade(liveEval.numericGrade);
        if (baselineNorm !== liveNorm) {
          staleConflicts.push({
            studentId: sc.studentId,
            fullname: sc.fullname,
            field: 'grade',
            expectedBaseline: sc.previousGrade,
            liveValue: liveEval.numericGrade,
          });
        }
        if (liveEval.gradingFeedbackSha256 !== sc.previousFeedbackSha256) {
          staleConflicts.push({
            studentId: sc.studentId,
            fullname: sc.fullname,
            field: 'gradingFeedbackComments',
            expectedBaseline: sc.previousFeedbackSha256,
            liveValue: liveEval.gradingFeedbackSha256,
          });
        }
        if (
          plan.markingWorkflowEnabled &&
          (liveEval.workflowState ?? null) !== (sc.baselineWorkflowState ?? null)
        ) {
          staleConflicts.push({
            studentId: sc.studentId,
            fullname: sc.fullname,
            field: 'workflowState',
            expectedBaseline: sc.baselineWorkflowState,
            liveValue: liveEval.workflowState,
          });
        }
      }

      if (staleConflicts.length > 0) {
        this.appendAuditEntry({
          operation: 'commit_grading_batch_blocked',
          operationId,
          planId,
          planHash: approvedPlanHash,
          actor,
          courseId: plan.courseId,
          assignmentId: plan.assignmentId,
          groupIds: [],
          affectedStudentIds: staleConflicts.map((c) => c.studentId),
          changeTypes: [],
          publicationState,
          notificationPolicy,
          operationStatus: 'blocked',
          reviewerNote,
          errorCode: 'stale_plan_conflict',
          errorMessage: `O estado no Moodle mudou após prepare_grading_batch para ${staleConflicts.length} registro(s).`,
        });
        throw new MoodleGradingError(
          'stale_plan_conflict',
          `Publicação bloqueada: avaliações no Moodle foram alteradas após a preparação do plano (${staleConflicts.length} divergência(s)). Execute prepare_grading_batch novamente para revisar os valores atuais.`,
          { staleConflicts }
        );
      }

      // 7. Execute writes per student explicitly (Moodle save_grade is non-atomic across multiple students)
      const changeTypesSet = new Set<'grade' | 'gradingFeedbackComments' | 'workflowState'>();
      for (const sc of plan.studentChanges) {
        if (sc.gradeChanged) changeTypesSet.add('grade');
        if (sc.feedbackChanged) changeTypesSet.add('gradingFeedbackComments');
      }
      if (plan.markingWorkflowEnabled) changeTypesSet.add('workflowState');
      if (changeTypesSet.size === 0) changeTypesSet.add('gradingFeedbackComments');

      let notificationPolicyApplied = 'moodle_default';

      for (const sc of pendingChanges) {
        try {
          // Pre-set user_flags mailed=1 when suppressing notifications, if supported
          let notifMechanism = 'moodle_default';
          if (notificationPolicy === 'suppress') {
            try {
              await this.client.call(
                'mod_assign_set_user_flags',
                {
                  assignmentid: plan.assignmentId,
                  userflags: [
                    {
                      userid: sc.studentId,
                      mailed: 1,
                      ...(plan.markingWorkflowEnabled ? { workflowstate: publicationState } : {}),
                    },
                  ],
                },
                false
              );
              notifMechanism = 'mod_assign_set_user_flags(mailed=1)';
              notificationPolicyApplied = notifMechanism;
            } catch {
              notifMechanism = 'user_flags_ws_unavailable_fallback';
            }
          }

          await this.client.call(
            'mod_assign_save_grade',
            {
              assignmentid: plan.assignmentId,
              userid: sc.studentId,
              grade: sc.effectiveMoodleGradeParam,
              attemptnumber: -1,
              addattempt: false,
              workflowstate: publicationState,
              applytoall: false,
              plugindata: {
                assignfeedbackcomments_editor: {
                  text: sc.effectiveFeedbackHtml,
                  format: 1,
                },
              },
            },
            false
          );

          // Ensure mailed flag post-save matches explicit notificationPolicy
          if (notificationPolicy === 'suppress') {
            try {
              await this.client.call(
                'mod_assign_set_user_flags',
                {
                  assignmentid: plan.assignmentId,
                  userflags: [
                    {
                      userid: sc.studentId,
                      mailed: 1,
                      ...(plan.markingWorkflowEnabled ? { workflowstate: publicationState } : {}),
                    },
                  ],
                },
                false
              );
              notifMechanism = 'mod_assign_set_user_flags(mailed=1)';
              notificationPolicyApplied = notifMechanism;
            } catch {
              // ignore if unavailable
            }
          } else if (notificationPolicy === 'notify_students') {
            try {
              await this.client.call(
                'mod_assign_set_user_flags',
                {
                  assignmentid: plan.assignmentId,
                  userflags: [
                    {
                      userid: sc.studentId,
                      mailed: 0,
                      ...(plan.markingWorkflowEnabled ? { workflowstate: publicationState } : {}),
                    },
                  ],
                },
                false
              );
              notifMechanism = 'mod_assign_set_user_flags(mailed=0)';
              notificationPolicyApplied = notifMechanism;
            } catch {
              notifMechanism = 'moodle_save_grade_default_notify';
              notificationPolicyApplied = notifMechanism;
            }
          }

          studentRecords[sc.studentId] = {
            studentId: sc.studentId,
            fullname: sc.fullname,
            assignmentGroupId: sc.assignmentGroupId,
            status: 'updated',
            previousGrade: sc.previousGrade,
            newGrade: sc.proposedGrade,
            previousFeedbackSha256: sc.previousFeedbackSha256,
            newFeedbackSha256: sc.proposedFeedbackSha256,
            notificationMechanism: notifMechanism,
            updatedAt: new Date().toISOString(),
          };
        } catch (writeErr) {
          studentRecords[sc.studentId] = {
            studentId: sc.studentId,
            fullname: sc.fullname,
            assignmentGroupId: sc.assignmentGroupId,
            status: 'failed',
            previousGrade: sc.previousGrade,
            newGrade: sc.proposedGrade,
            previousFeedbackSha256: sc.previousFeedbackSha256,
            newFeedbackSha256: sc.proposedFeedbackSha256,
            errorMessage: this.client.sanitizeErrorMessage(writeErr),
          };
        }
      }

      const allRecords = plan.studentChanges.map(
        (sc) =>
          studentRecords[sc.studentId] ?? {
            studentId: sc.studentId,
            fullname: sc.fullname,
            assignmentGroupId: sc.assignmentGroupId,
            status: 'pending' as const,
            previousGrade: sc.previousGrade,
            newGrade: sc.proposedGrade,
            previousFeedbackSha256: sc.previousFeedbackSha256,
            newFeedbackSha256: sc.proposedFeedbackSha256,
          }
      );

      const updatedList = allRecords.filter(
        (r) => r.status === 'updated' || r.status === 'unchanged_skipped'
      );
      const failedList = allRecords.filter((r) => r.status === 'failed' || r.status === 'pending');
      const finalStatus: 'succeeded' | 'partial_failure' =
        failedList.length === 0 ? 'succeeded' : 'partial_failure';

      const storedOp: StoredBatchOperation = {
        operationId,
        planId,
        approvedPlanHash,
        assignmentId: plan.assignmentId,
        courseId: plan.courseId,
        publicationState,
        notificationPolicy,
        status: finalStatus,
        createdAt: prevOp?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        moodleGradingUrl: plan.moodleGradingUrl,
        groupsExpected: plan.groupsTargetedCount,
        studentRecords,
      };

      this.operations.set(operationId, storedOp);
      this.persistOperationsToDisk();
      this.client.invalidateCourseParticipantsCache(plan.courseId);

      const groupIds = Array.from(
        new Set(
          allRecords
            .map((r) => r.assignmentGroupId)
            .filter((g): g is number => typeof g === 'number' && g > 0)
        )
      );

      const audit = this.appendAuditEntry({
        operation: 'commit_grading_batch',
        operationId,
        planId,
        planHash: approvedPlanHash,
        actor,
        courseId: plan.courseId,
        assignmentId: plan.assignmentId,
        groupIds,
        affectedStudentIds: allRecords.map((r) => r.studentId),
        changeTypes: Array.from(changeTypesSet),
        publicationState,
        notificationPolicy,
        operationStatus: finalStatus,
        studentDiffs: allRecords.map((r) => ({
          studentId: r.studentId,
          groupId: r.assignmentGroupId,
          previousGrade: r.previousGrade,
          newGrade: r.newGrade,
          previousFeedbackSha256: r.previousFeedbackSha256,
          newFeedbackSha256: r.newFeedbackSha256,
          outcome: r.status,
        })),
        reviewerNote,
        ...(failedList.length > 0
          ? {
              errorCode: 'partial_failure',
              errorMessage: `${failedList.length} de ${allRecords.length} avaliação(ões) falharam.`,
            }
          : {}),
      });

      const visibleToStudents = publicationState === 'released';

      return {
        isError: finalStatus === 'partial_failure',
        payload: {
          status: finalStatus,
          operationId,
          auditId: audit.auditId,
          planId,
          approvedPlanHash,
          assignmentId: plan.assignmentId,
          courseId: plan.courseId,
          commentTypeUpdated: 'gradingFeedbackComments',
          moodlePluginUpdated: 'assignfeedbackcomments_editor',
          submissionCommentsUntouched: true,
          publicationState,
          visibleToStudents,
          commentAvailableToStudents: visibleToStudents,
          notificationPolicy,
          notificationPolicyApplied,
          updatedStudentsCount: updatedList.length,
          failedStudentsCount: failedList.length,
          ...(plan.moodleGradingUrl ? { moodleGradingUrl: plan.moodleGradingUrl } : {}),
          summary: {
            groupsTargetedCount: plan.groupsTargetedCount,
            studentsTotalCount: allRecords.length,
            updatedStudentsCount: updatedList.length,
            failedStudentsCount: failedList.length,
          },
          updatedStudents: updatedList.map((u) => ({
            studentId: u.studentId,
            fullname: u.fullname,
            assignmentGroupId: u.assignmentGroupId,
            previousGrade: u.previousGrade,
            newGrade: u.newGrade,
            newFeedbackSha256: u.newFeedbackSha256,
            updatedAt: u.updatedAt,
          })),
          failedStudents: failedList.map((f) => ({
            studentId: f.studentId,
            fullname: f.fullname,
            assignmentGroupId: f.assignmentGroupId,
            status: f.status,
            errorMessage: f.errorMessage,
          })),
          ...(finalStatus === 'partial_failure'
            ? {
                recoveryInstructions: `A operação falhou parcialmente (${updatedList.length} atualizados, ${failedList.length} pendentes/falhos). Corrija a causa do erro e repita commit_grading_batch com o MESMO operationId="${operationId}" e resumeFailedOnly=true para processar apenas os registros pendentes.`,
              }
            : {
                verificationInstructions: `Execute verify_grading_batch(planId="${planId}", operationId="${operationId}") para consultar novamente o Moodle e confirmar independentemente todas as notas, comentários de feedback e estados de publicação.`,
              }),
        },
      };
    });
  }

  /**
   * Re-queries Moodle live (bypassing caches) and verifies every expected grade,
   * grading feedback comment, group member count, workflow state, and visibility state
   * against the approved plan.
   */
  public async verifyGradingBatch(params: {
    planId?: string;
    operationId?: string;
    expectedPublicationState?: PublicationStateOption;
  }): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
    const op = params.operationId ? this.operations.get(params.operationId) : undefined;
    const resolvedPlanId = params.planId ?? op?.planId;
    if (!resolvedPlanId) {
      throw new MoodleGradingError(
        'plan_not_found_or_expired',
        'Informe planId ou um operationId válido para verificar o lote no Moodle.'
      );
    }

    const plan = this.plans.get(resolvedPlanId);
    if (!plan) {
      throw new MoodleGradingError(
        'plan_not_found_or_expired',
        `Plano "${resolvedPlanId}" não encontrado na memória do servidor para verificação.`
      );
    }

    const expectedPubState = params.expectedPublicationState ?? op?.publicationState;
    const actor = await this.resolveActorInfo();

    // Re-query Moodle LIVE (never trusting the write response!)
    const liveData = await buildAssignmentConsolidatedData(this.client, plan.assignmentId, {
      courseId: plan.courseId,
      fresh: true,
      includeFeedback: true,
    });

    let studentsVerified = 0;
    let gradeMismatches = 0;
    let feedbackMismatches = 0;
    let workflowMismatches = 0;
    let visibilityMismatches = 0;
    let missingRecords = 0;

    const mismatches: Array<{
      studentId: number;
      fullname: string;
      assignmentGroupId: number | null;
      type:
        | 'missing_student_record'
        | 'grade_mismatch'
        | 'feedback_mismatch'
        | 'workflow_mismatch'
        | 'visibility_mismatch';
      expected: unknown;
      actual: unknown;
    }> = [];

    const verifiedGroupIds = new Set<number>();
    const failedGroups = new Set<number>();

    for (const sc of plan.studentChanges) {
      const liveEval = liveData.memberEvaluationsByUserId.get(sc.studentId);
      if (!liveEval) {
        missingRecords++;
        if (sc.assignmentGroupId) failedGroups.add(sc.assignmentGroupId);
        mismatches.push({
          studentId: sc.studentId,
          fullname: sc.fullname,
          assignmentGroupId: sc.assignmentGroupId,
          type: 'missing_student_record',
          expected: 'enrolled_participant',
          actual: null,
        });
        continue;
      }

      let studentOk = true;

      // 1. Grade verification
      const expGrade = sc.proposedGrade;
      const actGrade = liveEval.numericGrade;
      const gradeMatches =
        (expGrade === null && actGrade === null) ||
        (expGrade !== null && actGrade !== null && Math.abs(expGrade - actGrade) <= 1e-4);

      if (!gradeMatches) {
        studentOk = false;
        gradeMismatches++;
        mismatches.push({
          studentId: sc.studentId,
          fullname: sc.fullname,
          assignmentGroupId: sc.assignmentGroupId,
          type: 'grade_mismatch',
          expected: expGrade,
          actual: actGrade,
        });
      }

      // 2. Grading feedback comment verification
      const expFbNorm = normalizeTextForComparison(sc.proposedFeedbackText);
      const actFbNorm = normalizeTextForComparison(liveEval.gradingFeedbackComment);
      if (expFbNorm !== actFbNorm) {
        studentOk = false;
        feedbackMismatches++;
        mismatches.push({
          studentId: sc.studentId,
          fullname: sc.fullname,
          assignmentGroupId: sc.assignmentGroupId,
          type: 'feedback_mismatch',
          expected: {
            sha256: sc.proposedFeedbackSha256,
            preview: expFbNorm.slice(0, 120),
          },
          actual: {
            sha256: liveEval.gradingFeedbackSha256,
            preview: actFbNorm.slice(0, 120),
          },
        });
      }

      // 3. Workflow & visibility verification (when expectedPublicationState is known)
      if (expectedPubState) {
        if (plan.markingWorkflowEnabled && liveEval.workflowState !== expectedPubState) {
          studentOk = false;
          workflowMismatches++;
          mismatches.push({
            studentId: sc.studentId,
            fullname: sc.fullname,
            assignmentGroupId: sc.assignmentGroupId,
            type: 'workflow_mismatch',
            expected: expectedPubState,
            actual: liveEval.workflowState,
          });
        }

        const expectedVisible = expectedPubState === 'released' && !liveEval.gradeIsHidden;
        if (liveEval.visibleToStudents !== expectedVisible) {
          studentOk = false;
          visibilityMismatches++;
          mismatches.push({
            studentId: sc.studentId,
            fullname: sc.fullname,
            assignmentGroupId: sc.assignmentGroupId,
            type: 'visibility_mismatch',
            expected: expectedVisible,
            actual: liveEval.visibleToStudents,
          });
        }
      }

      if (studentOk) {
        studentsVerified++;
        if (sc.assignmentGroupId) verifiedGroupIds.add(sc.assignmentGroupId);
      } else if (sc.assignmentGroupId) {
        failedGroups.add(sc.assignmentGroupId);
      }
    }

    for (const fg of failedGroups) {
      verifiedGroupIds.delete(fg);
    }

    const allVerified =
      missingRecords === 0 &&
      gradeMismatches === 0 &&
      feedbackMismatches === 0 &&
      workflowMismatches === 0 &&
      visibilityMismatches === 0 &&
      studentsVerified === plan.studentsTargetedCount;

    const status: 'verified' | 'mismatch_detected' = allVerified
      ? 'verified'
      : 'mismatch_detected';

    this.appendAuditEntry({
      operation: 'verify_grading_batch',
      operationId: op?.operationId ?? params.operationId ?? `verify_${resolvedPlanId}`,
      planId: plan.planId,
      planHash: plan.planHash,
      actor,
      courseId: plan.courseId,
      assignmentId: plan.assignmentId,
      groupIds: Array.from(
        new Set(
          plan.studentChanges
            .map((s) => s.assignmentGroupId)
            .filter((g): g is number => typeof g === 'number' && g > 0)
        )
      ),
      affectedStudentIds: plan.studentChanges.map((s) => s.studentId),
      changeTypes: [],
      publicationState: expectedPubState,
      operationStatus: allVerified ? 'verified' : 'verification_mismatch',
      verificationSummary: {
        status,
        studentsExpected: plan.studentsTargetedCount,
        studentsVerified,
        gradeMismatches,
        feedbackMismatches,
        workflowMismatches,
        visibilityMismatches,
      },
    });

    return {
      isError: !allVerified,
      payload: {
        status,
        planId: plan.planId,
        planHash: plan.planHash,
        ...(op?.operationId ? { operationId: op.operationId } : {}),
        assignmentId: plan.assignmentId,
        courseId: plan.courseId,
        groupsExpected: plan.groupsTargetedCount,
        groupsVerified: verifiedGroupIds.size,
        studentsExpected: plan.studentsTargetedCount,
        studentsVerified,
        gradeMismatches,
        feedbackMismatches,
        workflowMismatches,
        visibilityMismatches,
        missingRecords,
        mismatches,
        ...(plan.moodleGradingUrl ? { moodleGradingUrl: plan.moodleGradingUrl } : {}),
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Safe single-student grading helper for backwards-compatible `provide_feedback`,
   * preserving omitted `grade`, preserving omitted `feedback`, and never defaulting
   * `workflowState` to `'released'` implicitly when omitted.
   */
  public async saveSingleFeedbackSafe(params: {
    assignmentId: number;
    studentId: number;
    grade?: number;
    feedback?: string;
    workflowState?: string;
    applyToAll?: boolean;
  }): Promise<Record<string, unknown>> {
    const {
      assignmentId,
      studentId,
      grade,
      feedback,
      workflowState,
      applyToAll = false,
    } = params;

    return this.withAssignmentLock(assignmentId, async () => {
      const actor = await this.resolveActorInfo();
      let existingGradeNum: number | null = null;
      let existingFeedbackHtml = '';
      let existingWorkflowState = '';

      try {
        const status = await this.client.call<any>('mod_assign_get_submission_status', {
          assignid: assignmentId,
          userid: studentId,
        });
        existingGradeNum = normalizeGradeNumber(status?.feedback?.grade?.grade);
        for (const fp of status?.feedback?.plugins || []) {
          if (fp.type === 'comments') {
            for (const ef of fp.editorfields || []) {
              if (ef?.text) existingFeedbackHtml = String(ef.text);
            }
          }
        }
        const rawGs = status?.lastattempt?.gradingstatus
          ? String(status.lastattempt.gradingstatus)
          : '';
        if (rawGs && rawGs !== 'graded' && rawGs !== 'notgraded') {
          existingWorkflowState = rawGs;
        }
      } catch {
        // Proceed with explicit values if status read is restricted
      }

      const effectiveGradeNum = grade !== undefined ? grade : existingGradeNum;
      const moodleGradeParam = effectiveGradeNum !== null ? effectiveGradeNum : -1;
      const effectiveFeedbackHtml =
        feedback !== undefined ? formatPlainOrHtmlFeedback(feedback) : existingFeedbackHtml;
      // Preserve existing workflow state when omitted rather than forcing 'released' implicitly!
      const effectiveWorkflowState =
        workflowState !== undefined ? workflowState : existingWorkflowState;

      const prevFbSha = sha256Text(htmlToText(existingFeedbackHtml));
      const newFbSha = sha256Text(htmlToText(effectiveFeedbackHtml));

      const result = await this.client.call<any>(
        'mod_assign_save_grade',
        {
          assignmentid: assignmentId,
          userid: studentId,
          grade: moodleGradeParam,
          attemptnumber: -1,
          addattempt: false,
          workflowstate: effectiveWorkflowState,
          applytoall: applyToAll,
          plugindata: {
            assignfeedbackcomments_editor: {
              text: effectiveFeedbackHtml,
              format: 1,
            },
          },
        },
        false
      );

      this.client.invalidateCourseParticipantsCache();

      const opId = `single_${assignmentId}_${studentId}_${Date.now()}`;
      this.appendAuditEntry({
        operation: 'provide_feedback',
        operationId: opId,
        actor,
        assignmentId,
        groupIds: [],
        affectedStudentIds: [studentId],
        changeTypes: [
          ...(grade !== undefined ? (['grade'] as const) : []),
          ...(feedback !== undefined ? (['gradingFeedbackComments'] as const) : []),
          ...(workflowState !== undefined ? (['workflowState'] as const) : []),
        ],
        publicationState: effectiveWorkflowState || 'preserved_current',
        operationStatus: 'succeeded',
        studentDiffs: [
          {
            studentId,
            groupId: null,
            previousGrade: existingGradeNum,
            newGrade: effectiveGradeNum,
            previousFeedbackSha256: prevFbSha,
            newFeedbackSha256: newFbSha,
            outcome: 'updated',
          },
        ],
      });

      return {
        success: true,
        assignmentId,
        studentId,
        grade: moodleGradeParam,
        effectiveGrade: effectiveGradeNum,
        gradePreserved: grade === undefined,
        feedbackPreserved: feedback === undefined,
        commentTypeUpdated: 'gradingFeedbackComments',
        workflowState: effectiveWorkflowState || 'preserved_current',
        applyToAll,
        moodleResult: result,
        recommendation:
          'Para avaliações de turmas ou grupos com etapa de revisão do professor, prefira prepare_grading_batch -> commit_grading_batch -> verify_grading_batch.',
      };
    });
  }
}

const batchManagersByClient = new WeakMap<MoodleClient, GradingBatchManager>();

export function getOrCreateGradingBatchManager(client: MoodleClient): GradingBatchManager {
  let mgr = batchManagersByClient.get(client);
  if (!mgr) {
    mgr = new GradingBatchManager(client);
    batchManagersByClient.set(client, mgr);
  }
  return mgr;
}
