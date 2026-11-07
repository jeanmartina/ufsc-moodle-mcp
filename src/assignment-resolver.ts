import crypto from 'node:crypto';
import { sanitizeFilenames } from './file-store.js';
import {
  computeFileKey,
  htmlToText,
  isNonStudentCourseRole,
  MoodleClient,
  stripTokenFromUrl,
  type AssignmentContext,
  type EnrolledUserSummary,
  type GroupInfo,
} from './moodle.js';
import { recordCacheHit } from './request-context.js';

export type AggregatedGradingStatus =
  | 'not_graded'
  | 'partially_graded'
  | 'fully_graded'
  | 'inconsistent';

export type GroupResolutionStatus =
  | 'resolved'
  | 'ambiguous'
  | 'no_assignment_group'
  | 'individual_assignment'
  | 'invalid_general_group';

export interface SubmissionFileSummary {
  filename: string;
  originalFilename: string;
  fileurl: string;
  fileKey: string;
  filesize?: number;
  mimetype?: string;
  timemodified: string | null;
  source: 'group_submission' | 'individual_submission';
  submissionId?: number;
  assignmentGroupId?: number | null;
}

export interface SubmissionCommentItem {
  id: number;
  authorUserId?: number;
  authorName?: string;
  content: string;
  timeCreated: string | null;
}

export interface SubmissionCommentsBlock {
  available: boolean;
  submissionId: number | null;
  count: number;
  comments: SubmissionCommentItem[];
  note?: string;
}

export interface MemberEvaluationDetail {
  userId: number;
  fullname: string;
  email?: string;
  assignmentGroupId: number | null;
  assignmentGroupName: string | null;
  evaluationStatus: 'graded' | 'not_graded';
  grade: string | null;
  numericGrade: number | null;
  gradeForDisplay?: string;
  hasGradingFeedbackComment: boolean;
  gradingFeedbackComment: string | null;
  gradingFeedbackHtml?: string | null;
  gradingFeedbackSha256: string;
  workflowState: string | null;
  publicationState: string;
  visibleToStudents: boolean;
  gradeIsHidden: boolean;
  gradeIsLocked: boolean;
  userFlagLocked: boolean;
  mailed: boolean | null;
  graderUserId: number | null;
  graderName?: string;
  gradedAt: string | null;
}

export interface ResolvedAssignmentGroupRecord {
  assignmentGroupId: number;
  assignmentGroupName: string;
  members: Array<{ id: number; fullname: string; email?: string }>;
  memberCount: number;
  hasSubmitted: boolean;
  groupSubmissionId: number | null;
  submissionStatus: string;
  submittedAt: string | null;
  rawCollectiveGradingStatus: string | null;
  onlineText?: string;
  filesCount: number;
  files: SubmissionFileSummary[];
  submissionComments?: SubmissionCommentsBlock;
  aggregatedGradingStatus: AggregatedGradingStatus;
  commonGroupGrade: string | null;
  hasGradeDivergence: boolean;
  distinctMemberGrades: string[];
  gradedMembersCount: number;
  membersWithFeedbackCount: number;
  workflowState: string | null;
  publicationState: string;
  allVisibleToStudents: boolean;
  lastGradedAt: string | null;
  lastGraderUserId: number | null;
  lastGraderName?: string;
  memberEvaluations: MemberEvaluationDetail[];
}

export interface AmbiguousGroupCandidate {
  id: number;
  name: string;
  memberCount: number;
  hasCollectiveSubmission: boolean;
}

export interface StudentGroupResolution {
  studentId: number;
  fullname: string;
  email?: string;
  groupResolutionStatus: GroupResolutionStatus;
  assignmentGroupId: number | null;
  assignmentGroupName: string | null;
  assignmentGroupMembers: Array<{ id: number; fullname: string; email?: string }>;
  courseGroupIds: number[];
  generalCourseGroupIds: number[];
  ambiguousGroupCandidates?: AmbiguousGroupCandidate[];
}

export interface AssignmentConsolidatedData {
  ctx: AssignmentContext;
  generalCourseGroupIds: Set<number>;
  configuredAssignmentGroupIds: Set<number>;
  groupsById: Map<number, GroupInfo>;
  studentIds: number[];
  studentResolutions: Map<number, StudentGroupResolution>;
  groupRecords: Map<number, ResolvedAssignmentGroupRecord>;
  memberEvaluationsByUserId: Map<number, MemberEvaluationDetail>;
  individualSubmissionsByUserId: Map<
    number,
    {
      submissionId: number;
      status: string;
      gradingstatus?: string;
      timemodified: number | undefined;
      onlineText?: string;
      files: SubmissionFileSummary[];
    }
  >;
  collectiveSubmissionsByGroupId: Map<
    number,
    {
      submissionId: number;
      status: string;
      gradingstatus?: string;
      timemodified: number | undefined;
      onlineText?: string;
      files: SubmissionFileSummary[];
    }
  >;
  distinctFileKeys: Set<string>;
}

export function formatIsoDate(unixSeconds: number | undefined | null): string | null {
  if (!unixSeconds || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

export function sha256Text(text: string | null | undefined): string {
  const normalized = (text ?? '').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function normalizeGradeNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100000) / 100000;
}

export function formatNormalizedGrade(num: number | null): string | null {
  if (num === null) return null;
  return num.toFixed(5);
}

export function extractSubmissionPlugins(
  plugins: any[] | undefined,
  source: 'group_submission' | 'individual_submission',
  submissionId?: number,
  assignmentGroupId?: number | null
): {
  onlineText?: string;
  files: SubmissionFileSummary[];
} {
  const onlineTexts: string[] = [];
  const files: SubmissionFileSummary[] = [];

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
            const cleanUrl = stripTokenFromUrl(String(f.fileurl));
            const { originalFilename } = sanitizeFilenames(String(f.filename || 'arquivo'));
            files.push({
              filename: originalFilename,
              originalFilename,
              fileurl: cleanUrl,
              fileKey: computeFileKey(cleanUrl),
              filesize: f.filesize !== undefined ? Number(f.filesize) : undefined,
              mimetype: f.mimetype ? String(f.mimetype) : undefined,
              timemodified: formatIsoDate(
                f.timemodified !== undefined ? Number(f.timemodified) : undefined
              ),
              source,
              ...(submissionId ? { submissionId } : {}),
              ...(assignmentGroupId !== undefined ? { assignmentGroupId } : {}),
            });
          }
        }
      }
    }
  }

  return {
    onlineText: onlineTexts.join('\n\n') || undefined,
    files,
  };
}

export function parseStatusSubmissionGroupId(statusData: any): {
  submissionGroupId?: number;
  submissionGroupName?: string;
  userGroupIds: number[];
} {
  const rawSubGroup = statusData?.lastattempt?.submissiongroup;
  let submissionGroupId: number | undefined;
  let submissionGroupName: string | undefined;

  if (typeof rawSubGroup === 'number' && rawSubGroup > 0) {
    submissionGroupId = rawSubGroup;
  } else if (rawSubGroup && typeof rawSubGroup === 'object' && Number(rawSubGroup.id) > 0) {
    submissionGroupId = Number(rawSubGroup.id);
    if (rawSubGroup.name) submissionGroupName = String(rawSubGroup.name);
  }

  const teamSubGid = Number(statusData?.lastattempt?.teamsubmission?.groupid || 0);
  if (!submissionGroupId && teamSubGid > 0) {
    submissionGroupId = teamSubGid;
  }

  const userGroupIds: number[] = [];
  if (Array.isArray(statusData?.lastattempt?.usergroups)) {
    for (const ug of statusData.lastattempt.usergroups) {
      const id = typeof ug === 'number' ? ug : Number(ug?.id || 0);
      if (id > 0) userGroupIds.push(id);
    }
  }

  return {
    submissionGroupId,
    submissionGroupName,
    userGroupIds,
  };
}

function looksLikeGeneralTurmaGroupName(groupName: string, courseName?: string): boolean {
  const trimmed = groupName.trim();
  if (/^turma\s+[0-9a-z_-]+$/i.test(trimmed)) return true;
  // UFSC standard class-section group pattern, e.g. "INE5458-08208 (20262)"
  if (/^[A-Z]{3}\d{4}[A-Z]?-\d{4,6}\s*\(\d{4,5}\)$/i.test(trimmed)) return true;
  if (courseName && trimmed.toLowerCase() === courseName.trim().toLowerCase()) return true;
  return false;
}

interface GroupingInspection {
  generalGroupIds: Set<number>;
  configuredGroupIds: Set<number>;
  groupNamesById: Map<number, string>;
}

const groupingCache = new Map<string, { expiresAtMs: number; value: GroupingInspection }>();

async function inspectCourseAndAssignmentGroupings(
  client: MoodleClient,
  courseId: number,
  teamSubmissionGroupingId: number,
  groupsById: Map<number, GroupInfo>,
  courseName?: string,
  forceRefresh = false
): Promise<GroupingInspection> {
  const cacheKey = `${courseId}:${teamSubmissionGroupingId}`;
  if (!forceRefresh) {
    const hit = groupingCache.get(cacheKey);
    if (hit && hit.expiresAtMs > Date.now()) {
      recordCacheHit();
      return hit.value;
    }
  }

  const generalGroupIds = new Set<number>();
  const configuredGroupIds = new Set<number>();
  const groupNamesById = new Map<number, string>();

  for (const [gid, gInfo] of groupsById.entries()) {
    groupNamesById.set(gid, gInfo.name);
  }

  // 1. Inspect official course groupings when available
  try {
    const groupings = await client.call<any[]>('core_group_get_course_groupings', {
      courseid: courseId,
    });
    if (Array.isArray(groupings) && groupings.length > 0) {
      const generalGroupingIds: number[] = [];
      const targetGroupingIds: number[] = [];

      for (const gp of groupings) {
        const gpId = Number(gp.id || 0);
        if (!gpId) continue;
        const idnum = String(gp.idnumber || '');
        const gpName = String(gp.name || '');
        const isTurmaGrouping =
          /^agrupamento_\d+$/i.test(idnum) || /agrupamento de turmas/i.test(gpName);
        if (isTurmaGrouping && gpId !== teamSubmissionGroupingId) {
          generalGroupingIds.push(gpId);
        }
        if (teamSubmissionGroupingId > 0 && gpId === teamSubmissionGroupingId) {
          targetGroupingIds.push(gpId);
        }
      }

      const toFetch = Array.from(new Set([...generalGroupingIds, ...targetGroupingIds]));
      if (toFetch.length > 0) {
        try {
          const detailed = await client.call<any[]>('core_group_get_groupings', {
            groupingids: toFetch,
            returngroups: 1,
          });
          for (const d of detailed || []) {
            const dId = Number(d.id || 0);
            const gList = Array.isArray(d.groups) ? d.groups : [];
            for (const g of gList) {
              const gid = Number(g.id || 0);
              if (!gid) continue;
              if (g.name) groupNamesById.set(gid, String(g.name));
              if (generalGroupingIds.includes(dId)) {
                generalGroupIds.add(gid);
              }
              if (teamSubmissionGroupingId > 0 && dId === teamSubmissionGroupingId) {
                configuredGroupIds.add(gid);
              }
            }
          }
        } catch {
          // core_group_get_groupings may not be enabled on mobile service; fall through
        }
      }
    }
  } catch {
    // Ignore when course groupings WS is unavailable
  }

  // 2. If teamSubmissionGroupingId > 0 and configuredGroupIds is still empty, try core_group_get_course_user_groups
  if (teamSubmissionGroupingId > 0 && configuredGroupIds.size === 0) {
    try {
      const ugRes = await client.call<any>('core_group_get_course_user_groups', {
        courseid: courseId,
        userid: 0,
        groupingid: teamSubmissionGroupingId,
      });
      for (const g of ugRes?.groups || []) {
        const gid = Number(g.id || 0);
        if (gid > 0) {
          configuredGroupIds.add(gid);
          if (g.name) groupNamesById.set(gid, String(g.name));
        }
      }
    } catch {
      // Ignore fallback error
    }
  }

  // 3. Structural heuristics on enrolled groups (teacher membership & UFSC turma naming)
  for (const [gid, gInfo] of groupsById.entries()) {
    if (configuredGroupIds.has(gid)) continue;
    if (gInfo.hasNonStudentMembers || looksLikeGeneralTurmaGroupName(gInfo.name, courseName)) {
      generalGroupIds.add(gid);
    }
  }

  const value: GroupingInspection = {
    generalGroupIds,
    configuredGroupIds,
    groupNamesById,
  };
  groupingCache.set(cacheKey, {
    expiresAtMs: Date.now() + 2 * 60 * 1000,
    value,
  });
  return value;
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const cap = Math.max(1, Math.min(concurrency, items.length || 1));

  const runners = Array.from({ length: cap }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

export async function fetchSubmissionComments(
  client: MoodleClient,
  cmid: number | undefined,
  submissionId: number | null | undefined
): Promise<SubmissionCommentsBlock> {
  if (!cmid || !submissionId || submissionId <= 0) {
    return {
      available: Boolean(cmid),
      submissionId: submissionId ?? null,
      count: 0,
      comments: [],
    };
  }

  try {
    const res = await client.call<any>('core_comment_get_comments', {
      contextlevel: 'module',
      instanceid: cmid,
      component: 'assignsubmission_comments',
      itemid: submissionId,
      area: 'submission_comments',
      page: 0,
    });
    const rawComments: any[] = Array.isArray(res?.comments) ? res.comments : [];
    const comments: SubmissionCommentItem[] = rawComments.map((c) => ({
      id: Number(c.id || 0),
      ...(c.userid !== undefined ? { authorUserId: Number(c.userid) } : {}),
      ...(c.fullname ? { authorName: String(c.fullname) } : {}),
      content: htmlToText(c.content),
      timeCreated: formatIsoDate(c.timecreated !== undefined ? Number(c.timecreated) : undefined),
    }));
    return {
      available: true,
      submissionId,
      count: res?.count !== undefined ? Number(res.count) : comments.length,
      comments,
    };
  } catch (err) {
    return {
      available: false,
      submissionId,
      count: 0,
      comments: [],
      note: `Comentários da entrega indisponíveis via WS: ${client.sanitizeErrorMessage(err)}`,
    };
  }
}

export function computeAggregatedGroupGrading(memberEvaluations: MemberEvaluationDetail[]): {
  aggregatedGradingStatus: AggregatedGradingStatus;
  commonGroupGrade: string | null;
  hasGradeDivergence: boolean;
  distinctMemberGrades: string[];
  gradedMembersCount: number;
  membersWithFeedbackCount: number;
} {
  const total = memberEvaluations.length;
  if (total === 0) {
    return {
      aggregatedGradingStatus: 'not_graded',
      commonGroupGrade: null,
      hasGradeDivergence: false,
      distinctMemberGrades: [],
      gradedMembersCount: 0,
      membersWithFeedbackCount: 0,
    };
  }

  const graded = memberEvaluations.filter((m) => m.numericGrade !== null);
  const membersWithFeedbackCount = memberEvaluations.filter(
    (m) => m.hasGradingFeedbackComment
  ).length;
  const distinctNumbers = Array.from(
    new Set(graded.map((m) => formatNormalizedGrade(m.numericGrade)!))
  );
  const hasGradeDivergence = distinctNumbers.length > 1;

  if (graded.length === 0) {
    return {
      aggregatedGradingStatus: 'not_graded',
      commonGroupGrade: null,
      hasGradeDivergence: false,
      distinctMemberGrades: [],
      gradedMembersCount: 0,
      membersWithFeedbackCount,
    };
  }

  if (hasGradeDivergence) {
    return {
      aggregatedGradingStatus: 'inconsistent',
      commonGroupGrade: null,
      hasGradeDivergence: true,
      distinctMemberGrades: distinctNumbers,
      gradedMembersCount: graded.length,
      membersWithFeedbackCount,
    };
  }

  if (graded.length < total) {
    return {
      aggregatedGradingStatus: 'partially_graded',
      commonGroupGrade: null,
      hasGradeDivergence: false,
      distinctMemberGrades: distinctNumbers,
      gradedMembersCount: graded.length,
      membersWithFeedbackCount,
    };
  }

  return {
    aggregatedGradingStatus: 'fully_graded',
    commonGroupGrade: distinctNumbers[0] ?? graded[0]?.grade ?? null,
    hasGradeDivergence: false,
    distinctMemberGrades: distinctNumbers,
    gradedMembersCount: graded.length,
    membersWithFeedbackCount,
  };
}

/**
 * Loads consolidated, authoritative group, submission, grade, feedback comment, workflow,
 * and visibility state for an entire Moodle assignment with minimal Web Service calls.
 */
export async function buildAssignmentConsolidatedData(
  client: MoodleClient,
  assignmentId: number,
  options: {
    courseId?: number;
    fresh?: boolean;
    includeFeedback?: boolean;
  } = {}
): Promise<AssignmentConsolidatedData> {
  const { courseId, fresh = false, includeFeedback = true } = options;

  if (fresh) {
    client.invalidateCourseParticipantsCache(courseId);
  }

  const ctx = await client.resolveAssignmentContext(assignmentId, courseId, fresh);
  if (!ctx) {
    throw new Error(
      `Tarefa assignmentId=${assignmentId} não encontrada nas disciplinas acessíveis pelo usuário autenticado.`
    );
  }

  // Execute Moodle WS queries in parallel!
  const [groupingInfo, subRes, gradeRes, flagsRes, participantsRes, gradebookRes] =
    await Promise.all([
      inspectCourseAndAssignmentGroupings(
        client,
        ctx.courseId,
        ctx.assignment.teamsubmissiongroupingid,
        ctx.groupsById,
        ctx.courseName,
        fresh
      ),
      client
        .call<any>('mod_assign_get_submissions', { assignmentids: [assignmentId] })
        .catch(() => ({ assignments: [] })),
      client
        .call<any>('mod_assign_get_grades', { assignmentids: [assignmentId] })
        .catch(() => ({ assignments: [] })),
      client
        .call<any>('mod_assign_get_user_flags', { assignmentids: [assignmentId] })
        .catch(() => ({ assignments: [] })),
      client
        .call<any[]>('mod_assign_list_participants', {
          assignid: assignmentId,
          groupid: 0,
          filter: '',
        })
        .catch(() => null),
      includeFeedback
        ? client
            .call<any>('gradereport_user_get_grade_items', { courseid: ctx.courseId })
            .catch(() => null)
        : Promise.resolve(null),
    ]);

  const generalCourseGroupIds = new Set(groupingInfo.generalGroupIds);
  const authoritativeGroupingGroupIds = new Set(groupingInfo.configuredGroupIds);
  const configuredAssignmentGroupIds = new Set(groupingInfo.configuredGroupIds);

  // Clone groupsById so we can enrich with any groups discovered from participants or submissions
  const groupsById = new Map<number, GroupInfo>();
  for (const [gid, g] of ctx.groupsById.entries()) {
    groupsById.set(gid, {
      id: g.id,
      name: g.name,
      members: [...g.members],
      hasNonStudentMembers: g.hasNonStudentMembers,
    });
  }

  // Index participants from mod_assign_list_participants (authoritative Moodle student list + resolved groupid!)
  const participantAssignedGroup = new Map<number, { groupId: number; groupName?: string }>();
  const participantStudentIds = new Set<number>();

  if (Array.isArray(participantsRes) && participantsRes.length > 0) {
    for (const p of participantsRes) {
      const uid = Number(p.id || 0);
      if (!uid) continue;
      // Double-check role in usersById if known
      const enrolled = ctx.usersById.get(uid);
      if (enrolled && isNonStudentCourseRole(enrolled.roles)) {
        continue;
      }
      participantStudentIds.add(uid);
      if (!enrolled) {
        ctx.usersById.set(uid, {
          id: uid,
          fullname: String(p.fullname || `Estudante ${uid}`),
          email: p.email ? String(p.email) : undefined,
          groups:
            Number(p.groupid || 0) > 0
              ? [{ id: Number(p.groupid), name: String(p.groupname || `Grupo ${p.groupid}`) }]
              : [],
          roles: ['student'],
        });
      }

      const pGid = Number(p.groupid || 0);
      const pGname = p.groupname ? String(p.groupname) : undefined;
      if (pGid > 0 && !generalCourseGroupIds.has(pGid)) {
        participantAssignedGroup.set(uid, { groupId: pGid, groupName: pGname });
        configuredAssignmentGroupIds.add(pGid);

        let gEntry = groupsById.get(pGid);
        if (!gEntry) {
          gEntry = {
            id: pGid,
            name: pGname || groupingInfo.groupNamesById.get(pGid) || `Grupo ${pGid}`,
            members: [],
          };
          groupsById.set(pGid, gEntry);
        } else if (pGname && gEntry.name.startsWith('Grupo ')) {
          gEntry.name = pGname;
        }
        if (!gEntry.members.some((m) => m.id === uid)) {
          gEntry.members.push({
            id: uid,
            fullname: String(p.fullname || enrolled?.fullname || `Estudante ${uid}`),
            email: p.email ? String(p.email) : enrolled?.email,
          });
        }
      }
    }
  } else {
    // Fallback when mod_assign_list_participants is not mocked/enabled: use all student users in course
    for (const [uid, u] of ctx.usersById.entries()) {
      if (!isNonStudentCourseRole(u.roles)) {
        participantStudentIds.add(uid);
      }
    }
  }

  // Index submissions (collective userid===0 and individual userid>0)
  const rawSubs: any[] = subRes?.assignments?.[0]?.submissions || [];
  const collectiveSubmissionsByGroupId = new Map<
    number,
    {
      submissionId: number;
      status: string;
      gradingstatus?: string;
      timemodified: number | undefined;
      onlineText?: string;
      files: SubmissionFileSummary[];
    }
  >();
  const individualSubmissionsByUserId = new Map<
    number,
    {
      submissionId: number;
      status: string;
      gradingstatus?: string;
      timemodified: number | undefined;
      onlineText?: string;
      files: SubmissionFileSummary[];
    }
  >();
  const distinctFileKeys = new Set<string>();

  for (const s of rawSubs) {
    const uid = Number(s.userid || 0);
    const gid = Number(s.groupid || 0);
    const subId = Number(s.id || 0);

    if (uid === 0 && gid > 0) {
      const parsed = extractSubmissionPlugins(s.plugins, 'group_submission', subId, gid);
      for (const f of parsed.files) distinctFileKeys.add(f.fileKey);
      collectiveSubmissionsByGroupId.set(gid, {
        submissionId: subId,
        status: String(s.status || 'new'),
        gradingstatus: s.gradingstatus ? String(s.gradingstatus) : undefined,
        timemodified: s.timemodified !== undefined ? Number(s.timemodified) : undefined,
        onlineText: parsed.onlineText,
        files: parsed.files,
      });

      if (!generalCourseGroupIds.has(gid)) {
        configuredAssignmentGroupIds.add(gid);
        if (!groupsById.has(gid)) {
          groupsById.set(gid, {
            id: gid,
            name: groupingInfo.groupNamesById.get(gid) || `Grupo ${gid}`,
            members: [],
          });
        }
      }
    } else if (uid > 0) {
      const isGroupRow = gid > 0 && !generalCourseGroupIds.has(gid);
      const parsed = extractSubmissionPlugins(
        s.plugins,
        isGroupRow ? 'group_submission' : 'individual_submission',
        subId,
        isGroupRow ? gid : null
      );
      for (const f of parsed.files) distinctFileKeys.add(f.fileKey);
      individualSubmissionsByUserId.set(uid, {
        submissionId: subId,
        status: String(s.status || 'new'),
        gradingstatus: s.gradingstatus ? String(s.gradingstatus) : undefined,
        timemodified: s.timemodified !== undefined ? Number(s.timemodified) : undefined,
        onlineText: parsed.onlineText,
        files: parsed.files,
      });
    }
  }

  // If teamSubmissionGroupingId > 0 and authoritativeGroupingGroupIds is populated from Moodle's
  // official grouping configuration, any course group outside that grouping (without a collective
  // submission on this assignment) is NOT an assignment project group.
  const hasAuthoritativeGroupingWhitelist =
    ctx.assignment.teamsubmission &&
    ctx.assignment.teamsubmissiongroupingid > 0 &&
    authoritativeGroupingGroupIds.size > 0;

  if (hasAuthoritativeGroupingWhitelist) {
    for (const gid of groupsById.keys()) {
      if (!authoritativeGroupingGroupIds.has(gid) && !collectiveSubmissionsByGroupId.has(gid)) {
        generalCourseGroupIds.add(gid);
      }
    }
  }

  // Resolve each student's assignment group deterministically (NEVER selecting groups[0] arbitrarily!)
  const studentIds = Array.from(participantStudentIds).sort((a, b) => a - b);
  const studentResolutions = new Map<number, StudentGroupResolution>();

  for (const uid of studentIds) {
    const u: EnrolledUserSummary = ctx.usersById.get(uid) ?? {
      id: uid,
      fullname: `Estudante ${uid}`,
      groups: [],
      roles: ['student'],
    };
    const courseGroupIds = u.groups.map((g) => g.id);
    const studentGeneralGroups = courseGroupIds.filter((gid) => generalCourseGroupIds.has(gid));

    if (!ctx.assignment.teamsubmission) {
      studentResolutions.set(uid, {
        studentId: uid,
        fullname: u.fullname,
        email: u.email,
        groupResolutionStatus: 'individual_assignment',
        assignmentGroupId: null,
        assignmentGroupName: null,
        assignmentGroupMembers: [],
        courseGroupIds,
        generalCourseGroupIds: studentGeneralGroups,
      });
      continue;
    }

    // Eligible project groups for this student
    let eligibleGroupIds = courseGroupIds.filter((gid) => {
      if (generalCourseGroupIds.has(gid)) return false;
      if (hasAuthoritativeGroupingWhitelist) {
        return (
          authoritativeGroupingGroupIds.has(gid) || collectiveSubmissionsByGroupId.has(gid)
        );
      }
      return true;
    });

    const participantHit = participantAssignedGroup.get(uid);
    if (
      participantHit &&
      participantHit.groupId > 0 &&
      !generalCourseGroupIds.has(participantHit.groupId) &&
      !eligibleGroupIds.includes(participantHit.groupId)
    ) {
      eligibleGroupIds.push(participantHit.groupId);
    }
    eligibleGroupIds = Array.from(new Set(eligibleGroupIds));

    if (eligibleGroupIds.length === 0) {
      studentResolutions.set(uid, {
        studentId: uid,
        fullname: u.fullname,
        email: u.email,
        groupResolutionStatus: 'no_assignment_group',
        assignmentGroupId: null,
        assignmentGroupName: null,
        assignmentGroupMembers: [],
        courseGroupIds,
        generalCourseGroupIds: studentGeneralGroups,
      });
      continue;
    }

    if (eligibleGroupIds.length > 1) {
      // Explicit ambiguity! Never pick groups[0] silently when a student belongs to >1 project group.
      const candidates: AmbiguousGroupCandidate[] = eligibleGroupIds.map((gid) => {
        const gObj = groupsById.get(gid);
        const col = collectiveSubmissionsByGroupId.get(gid);
        const hasSub = Boolean(
          col && (col.status === 'submitted' || col.files.length > 0 || Boolean(col.onlineText))
        );
        return {
          id: gid,
          name: gObj?.name || groupingInfo.groupNamesById.get(gid) || `Grupo ${gid}`,
          memberCount: gObj?.members.length ?? 0,
          hasCollectiveSubmission: hasSub,
        };
      });

      studentResolutions.set(uid, {
        studentId: uid,
        fullname: u.fullname,
        email: u.email,
        groupResolutionStatus: 'ambiguous',
        assignmentGroupId: null,
        assignmentGroupName: null,
        assignmentGroupMembers: [],
        courseGroupIds,
        generalCourseGroupIds: studentGeneralGroups,
        ambiguousGroupCandidates: candidates,
      });
      continue;
    }

    const resolvedGid = eligibleGroupIds[0];
    const gObj = groupsById.get(resolvedGid);
    const gName =
      gObj?.name ||
      participantHit?.groupName ||
      groupingInfo.groupNamesById.get(resolvedGid) ||
      `Grupo ${resolvedGid}`;
    const members = (gObj?.members ?? []).filter((m) => {
      const mUser = ctx.usersById.get(m.id);
      return !mUser || !isNonStudentCourseRole(mUser.roles);
    });

    studentResolutions.set(uid, {
      studentId: uid,
      fullname: u.fullname,
      email: u.email,
      groupResolutionStatus: 'resolved',
      assignmentGroupId: resolvedGid,
      assignmentGroupName: gName,
      assignmentGroupMembers: members,
      courseGroupIds,
      generalCourseGroupIds: studentGeneralGroups,
    });
  }

  // Index grades, user flags, and gradebook feedback/visibility
  const gradesByUser = new Map<
    number,
    {
      grade: string;
      numericGrade: number | null;
      grader: number | null;
      timemodified: number | null;
    }
  >();
  for (const g of gradeRes?.assignments?.[0]?.grades || []) {
    const uid = Number(g.userid || 0);
    if (!uid) continue;
    const norm = normalizeGradeNumber(g.grade);
    gradesByUser.set(uid, {
      grade: norm !== null ? String(g.grade) : '',
      numericGrade: norm,
      grader: g.grader !== undefined && Number(g.grader) > 0 ? Number(g.grader) : null,
      timemodified: g.timemodified !== undefined ? Number(g.timemodified) : null,
    });
  }

  const flagsByUser = new Map<
    number,
    {
      locked: boolean;
      mailed: boolean;
      workflowstate: string | null;
      allocatedmarker: number | null;
    }
  >();
  for (const f of flagsRes?.assignments?.[0]?.userflags || []) {
    const uid = Number(f.userid || 0);
    if (!uid) continue;
    flagsByUser.set(uid, {
      locked: Boolean(f.locked),
      mailed: Boolean(f.mailed),
      workflowstate: f.workflowstate ? String(f.workflowstate) : null,
      allocatedmarker:
        f.allocatedmarker !== undefined && Number(f.allocatedmarker) > 0
          ? Number(f.allocatedmarker)
          : null,
    });
  }

  const gradebookByUser = new Map<
    number,
    {
      feedbackHtml: string;
      feedbackText: string;
      gradeIsHidden: boolean;
      gradeIsLocked: boolean;
      gradeFormatted?: string;
      gradedAtUnix?: number;
      gradeRaw?: number | null;
    }
  >();

  let hasGradebookItems = false;
  if (gradebookRes && Array.isArray(gradebookRes.usergrades)) {
    for (const ug of gradebookRes.usergrades) {
      const uid = Number(ug.userid || 0);
      if (!uid || !Array.isArray(ug.gradeitems)) continue;
      const item = ug.gradeitems.find(
        (gi: any) =>
          (gi.itemmodule === 'assign' && Number(gi.iteminstance) === assignmentId) ||
          (ctx.assignment.cmid && Number(gi.cmid) === ctx.assignment.cmid)
      );
      if (!item) continue;
      hasGradebookItems = true;
      const fbHtml = item.feedback ? String(item.feedback) : '';
      const fbText = htmlToText(fbHtml);
      gradebookByUser.set(uid, {
        feedbackHtml: fbHtml,
        feedbackText: fbText,
        gradeIsHidden: Boolean(item.gradeishidden),
        gradeIsLocked: Boolean(item.gradeislocked),
        gradeFormatted: item.gradeformatted ? htmlToText(String(item.gradeformatted)) : undefined,
        gradedAtUnix: item.gradedategraded ? Number(item.gradedategraded) : undefined,
        gradeRaw: normalizeGradeNumber(item.graderaw),
      });
    }
  }

  // Fallback for unit-test mocks that don't implement gradereport_user_get_grade_items
  if (includeFeedback && !hasGradebookItems && studentIds.length > 0) {
    await runWithConcurrency(studentIds, 6, async (uid) => {
      try {
        const st = await client.call<any>('mod_assign_get_submission_status', {
          assignid: assignmentId,
          userid: uid,
        });
        let fbHtml = '';
        for (const fp of st?.feedback?.plugins || []) {
          if (fp.type === 'comments') {
            for (const ef of fp.editorfields || []) {
              if (ef?.text) fbHtml = String(ef.text);
            }
          }
        }
        const fbText = htmlToText(fbHtml);
        const stGrade = normalizeGradeNumber(st?.feedback?.grade?.grade);
        gradebookByUser.set(uid, {
          feedbackHtml: fbHtml,
          feedbackText: fbText,
          gradeIsHidden: false,
          gradeIsLocked: false,
          gradeFormatted: st?.feedback?.gradefordisplay
            ? htmlToText(String(st.feedback.gradefordisplay))
            : undefined,
          gradedAtUnix: st?.feedback?.gradeddate ? Number(st.feedback.gradeddate) : undefined,
          gradeRaw: stGrade,
        });
        if (!flagsByUser.has(uid) && st?.lastattempt?.gradingstatus) {
          const gs = String(st.lastattempt.gradingstatus);
          if (gs !== 'graded' && gs !== 'notgraded') {
            flagsByUser.set(uid, {
              locked: Boolean(st?.lastattempt?.locked),
              mailed: false,
              workflowstate: gs,
              allocatedmarker: null,
            });
          }
        }
      } catch {
        // Ignore individual fallback failure
      }
    });
  }

  // Build MemberEvaluationDetail for every student
  const memberEvaluationsByUserId = new Map<number, MemberEvaluationDetail>();
  for (const uid of studentIds) {
    const res = studentResolutions.get(uid)!;
    const gEntry = gradesByUser.get(uid);
    const fEntry = flagsByUser.get(uid);
    const gbEntry = gradebookByUser.get(uid);

    const numericGrade = gEntry?.numericGrade ?? gbEntry?.gradeRaw ?? null;
    const gradeStr =
      numericGrade !== null
        ? gEntry?.grade || formatNormalizedGrade(numericGrade)
        : null;
    const fbText = gbEntry?.feedbackText || null;
    const fbHtml = gbEntry?.feedbackHtml || null;
    const hasFb = Boolean(fbText && fbText.trim().length > 0);
    const workflowState = fEntry?.workflowstate ?? null;
    const gradeIsHidden = Boolean(gbEntry?.gradeIsHidden);
    const gradeIsLocked = Boolean(gbEntry?.gradeIsLocked);
    const userFlagLocked = Boolean(fEntry?.locked);

    let publicationState: string;
    let visibleToStudents: boolean;
    if (ctx.assignment.markingworkflow) {
      if (workflowState === 'released' && !gradeIsHidden) {
        publicationState = 'released';
        visibleToStudents = true;
      } else {
        publicationState = workflowState || 'not_released';
        visibleToStudents = false;
      }
    } else {
      if (numericGrade !== null || hasFb) {
        if (gradeIsHidden) {
          publicationState = 'hidden_in_gradebook';
          visibleToStudents = false;
        } else {
          publicationState = 'released';
          visibleToStudents = true;
        }
      } else {
        publicationState = 'not_graded';
        visibleToStudents = false;
      }
    }

    const graderUserId = gEntry?.grader ?? null;
    const graderName = graderUserId ? ctx.usersById.get(graderUserId)?.fullname : undefined;
    const gradedUnix = gEntry?.timemodified ?? gbEntry?.gradedAtUnix ?? null;

    memberEvaluationsByUserId.set(uid, {
      userId: uid,
      fullname: res.fullname,
      email: res.email,
      assignmentGroupId: res.assignmentGroupId,
      assignmentGroupName: res.assignmentGroupName,
      evaluationStatus: numericGrade !== null ? 'graded' : 'not_graded',
      grade: gradeStr,
      numericGrade,
      ...(gbEntry?.gradeFormatted ? { gradeForDisplay: gbEntry.gradeFormatted } : {}),
      hasGradingFeedbackComment: hasFb,
      gradingFeedbackComment: fbText,
      gradingFeedbackHtml: fbHtml,
      gradingFeedbackSha256: sha256Text(fbText),
      workflowState,
      publicationState,
      visibleToStudents,
      gradeIsHidden,
      gradeIsLocked,
      userFlagLocked,
      mailed: fEntry ? fEntry.mailed : null,
      graderUserId,
      ...(graderName ? { graderName } : {}),
      gradedAt: formatIsoDate(gradedUnix),
    });
  }

  // Build ResolvedAssignmentGroupRecord for every assignment project group
  const candidateProjectGroupIds = new Set<number>();
  if (ctx.assignment.teamsubmission) {
    for (const gid of configuredAssignmentGroupIds) {
      if (!generalCourseGroupIds.has(gid)) candidateProjectGroupIds.add(gid);
    }
    for (const gid of collectiveSubmissionsByGroupId.keys()) {
      if (!generalCourseGroupIds.has(gid)) candidateProjectGroupIds.add(gid);
    }
    for (const res of studentResolutions.values()) {
      if (res.assignmentGroupId) candidateProjectGroupIds.add(res.assignmentGroupId);
      for (const amb of res.ambiguousGroupCandidates || []) {
        if (!generalCourseGroupIds.has(amb.id)) candidateProjectGroupIds.add(amb.id);
      }
    }
    if (!hasAuthoritativeGroupingWhitelist) {
      for (const gid of groupsById.keys()) {
        if (!generalCourseGroupIds.has(gid)) candidateProjectGroupIds.add(gid);
      }
    }
  }

  const groupRecords = new Map<number, ResolvedAssignmentGroupRecord>();
  const sortedGroupIds = Array.from(candidateProjectGroupIds).sort((a, b) => a - b);

  for (const gid of sortedGroupIds) {
    const gObj = groupsById.get(gid);
    const gName = gObj?.name || groupingInfo.groupNamesById.get(gid) || `Grupo ${gid}`;

    // Strictly include only students resolved to this project group (or student members of gObj if unambiguous)
    const memberMap = new Map<number, { id: number; fullname: string; email?: string }>();
    for (const m of gObj?.members || []) {
      const mUser = ctx.usersById.get(m.id);
      if (mUser && isNonStudentCourseRole(mUser.roles)) continue;
      memberMap.set(m.id, m);
    }
    for (const res of studentResolutions.values()) {
      if (res.assignmentGroupId === gid && !memberMap.has(res.studentId)) {
        memberMap.set(res.studentId, {
          id: res.studentId,
          fullname: res.fullname,
          email: res.email,
        });
      }
    }

    const members = Array.from(memberMap.values()).sort((a, b) => a.id - b.id);
    const memberEvals = members
      .map((m) => memberEvaluationsByUserId.get(m.id))
      .filter((x): x is MemberEvaluationDetail => Boolean(x));

    const colSub = collectiveSubmissionsByGroupId.get(gid);
    const dedupFiles = new Map<string, SubmissionFileSummary>();
    const onlineTexts: string[] = [];

    if (colSub) {
      if (colSub.onlineText) onlineTexts.push(colSub.onlineText);
      for (const f of colSub.files) dedupFiles.set(f.fileKey, f);
    }
    // Also check if any member row held files directly
    for (const m of members) {
      const indSub = individualSubmissionsByUserId.get(m.id);
      if (indSub) {
        if (indSub.onlineText && !onlineTexts.includes(indSub.onlineText)) {
          onlineTexts.push(indSub.onlineText);
        }
        for (const f of indSub.files) {
          if (!dedupFiles.has(f.fileKey)) dedupFiles.set(f.fileKey, f);
        }
      }
    }

    const files = Array.from(dedupFiles.values());
    const onlineText = onlineTexts.join('\n\n') || undefined;
    const hasSubmitted = Boolean(
      (colSub && colSub.status === 'submitted') || files.length > 0 || Boolean(onlineText)
    );

    const agg = computeAggregatedGroupGrading(memberEvals);

    const wfStates = Array.from(
      new Set(memberEvals.map((m) => m.workflowState).filter((w): w is string => Boolean(w)))
    );
    const pubStates = Array.from(new Set(memberEvals.map((m) => m.publicationState)));

    let latestGradedAt: string | null = null;
    let latestGraderId: number | null = null;
    let latestGraderName: string | undefined;
    for (const me of memberEvals) {
      if (me.gradedAt && (!latestGradedAt || me.gradedAt > latestGradedAt)) {
        latestGradedAt = me.gradedAt;
        latestGraderId = me.graderUserId;
        latestGraderName = me.graderName;
      }
    }

    groupRecords.set(gid, {
      assignmentGroupId: gid,
      assignmentGroupName: gName,
      members,
      memberCount: members.length,
      hasSubmitted,
      groupSubmissionId: colSub?.submissionId ?? null,
      submissionStatus: colSub?.status ?? (hasSubmitted ? 'submitted' : 'new'),
      submittedAt: formatIsoDate(colSub?.timemodified),
      rawCollectiveGradingStatus: colSub?.gradingstatus ?? null,
      ...(onlineText ? { onlineText } : {}),
      filesCount: files.length,
      files,
      ...agg,
      workflowState: wfStates.length === 1 ? wfStates[0] : wfStates.length > 1 ? 'mixed' : null,
      publicationState:
        pubStates.length === 1 ? pubStates[0] : pubStates.length > 1 ? 'mixed' : 'not_graded',
      allVisibleToStudents:
        memberEvals.length > 0 && memberEvals.every((m) => m.visibleToStudents),
      lastGradedAt: latestGradedAt,
      lastGraderUserId: latestGraderId,
      ...(latestGraderName ? { lastGraderName: latestGraderName } : {}),
      memberEvaluations: memberEvals,
    });
  }

  return {
    ctx,
    generalCourseGroupIds,
    configuredAssignmentGroupIds,
    groupsById,
    studentIds,
    studentResolutions,
    groupRecords,
    memberEvaluationsByUserId,
    individualSubmissionsByUserId,
    collectiveSubmissionsByGroupId,
    distinctFileKeys,
  };
}

export function sanitizeMemberForOutput(
  member: { id: number; fullname: string; email?: string },
  includePersonalData: boolean
): { id: number; fullname: string; email?: string } {
  return includePersonalData && member.email
    ? { id: member.id, fullname: member.fullname, email: member.email }
    : { id: member.id, fullname: member.fullname };
}

export function sanitizeMemberEvalForOutput(
  ev: MemberEvaluationDetail,
  opts: {
    includeGrades?: boolean;
    includeFeedback?: boolean;
    includeWorkflow?: boolean;
    includeVisibility?: boolean;
    includePersonalData?: boolean;
  }
): Record<string, unknown> {
  const {
    includeGrades = true,
    includeFeedback = true,
    includeWorkflow = true,
    includeVisibility = true,
    includePersonalData = false,
  } = opts;

  return {
    userId: ev.userId,
    fullname: ev.fullname,
    ...(includePersonalData && ev.email ? { email: ev.email } : {}),
    assignmentGroupId: ev.assignmentGroupId,
    assignmentGroupName: ev.assignmentGroupName,
    evaluationStatus: ev.evaluationStatus,
    ...(includeGrades
      ? {
          grade: ev.grade,
          numericGrade: ev.numericGrade,
          ...(ev.gradeForDisplay ? { gradeForDisplay: ev.gradeForDisplay } : {}),
          graderUserId: ev.graderUserId,
          ...(ev.graderName ? { graderName: ev.graderName } : {}),
          gradedAt: ev.gradedAt,
        }
      : {}),
    hasGradingFeedbackComment: ev.hasGradingFeedbackComment,
    ...(includeFeedback
      ? {
          gradingFeedbackComment: ev.gradingFeedbackComment,
          gradingFeedbackSha256: ev.gradingFeedbackSha256,
        }
      : {}),
    ...(includeWorkflow ? { workflowState: ev.workflowState } : {}),
    ...(includeVisibility
      ? {
          publicationState: ev.publicationState,
          visibleToStudents: ev.visibleToStudents,
          gradeIsHidden: ev.gradeIsHidden,
          gradeIsLocked: ev.gradeIsLocked,
          userFlagLocked: ev.userFlagLocked,
        }
      : {}),
  };
}

export async function getAssignmentGradingOverview(
  client: MoodleClient,
  params: {
    assignmentId: number;
    courseId?: number;
    includeGroups?: boolean;
    includeMembers?: boolean;
    includeGrades?: boolean;
    includeFeedback?: boolean;
    includeSubmissionComments?: boolean;
    includeWorkflow?: boolean;
    includeVisibility?: boolean;
    includePersonalData?: boolean;
    limit?: number;
    cursor?: string;
  }
): Promise<Record<string, unknown>> {
  const {
    assignmentId,
    courseId,
    includeGroups = true,
    includeMembers = true,
    includeGrades = true,
    includeFeedback = true,
    includeSubmissionComments = false,
    includeWorkflow = true,
    includeVisibility = true,
    includePersonalData = false,
    limit,
    cursor,
  } = params;

  const data = await buildAssignmentConsolidatedData(client, assignmentId, {
    courseId,
    includeFeedback,
  });

  const { ctx } = data;
  const siteUrl = client.getConfig().siteUrl.replace(/\/+$/, '');
  const gradingUrl = ctx.assignment.cmid
    ? `${siteUrl}/mod/assign/view.php?id=${ctx.assignment.cmid}&action=grading`
    : undefined;

  const allGroups = Array.from(data.groupRecords.values());
  const submittedGroups = allGroups.filter((g) => g.hasSubmitted);
  const unsubmittedGroups = allGroups.filter((g) => !g.hasSubmitted);

  //Optionally fetch submission comments for submitted groups when requested
  if (includeSubmissionComments && ctx.assignment.cmid) {
    await runWithConcurrency(submittedGroups, 5, async (g) => {
      if (g.groupSubmissionId) {
        g.submissionComments = await fetchSubmissionComments(
          client,
          ctx.assignment.cmid,
          g.groupSubmissionId
        );
      }
    });
  }

  // Classify students
  const studentsWithoutSubmission: Array<{
    userId: number;
    fullname: string;
    email?: string;
    reason: 'no_assignment_group' | 'group_not_submitted' | 'ambiguous_group' | 'not_submitted';
    assignmentGroupId: number | null;
    assignmentGroupName: string | null;
  }> = [];
  const ambiguousStudents: Array<{
    userId: number;
    fullname: string;
    candidates: AmbiguousGroupCandidate[];
  }> = [];

  let studentsWithEffectiveSubmissionCount = 0;
  let submittedAndGradedStudentsCount = 0;
  let submittedAndFeedbackStudentsCount = 0;
  let studentsWithoutAssignmentGroupCount = 0;
  let gradedStudentsCount = 0;
  let studentsWithFeedbackCount = 0;

  for (const uid of data.studentIds) {
    const res = data.studentResolutions.get(uid)!;
    const ev = data.memberEvaluationsByUserId.get(uid)!;
    if (ev.numericGrade !== null) gradedStudentsCount++;
    if (ev.hasGradingFeedbackComment) studentsWithFeedbackCount++;

    let studentHasEffectiveSubmission = false;
    if (ctx.assignment.teamsubmission) {
      if (res.groupResolutionStatus === 'ambiguous') {
        ambiguousStudents.push({
          userId: uid,
          fullname: res.fullname,
          candidates: res.ambiguousGroupCandidates ?? [],
        });
        studentsWithoutSubmission.push({
          userId: uid,
          fullname: res.fullname,
          ...(includePersonalData && res.email ? { email: res.email } : {}),
          reason: 'ambiguous_group',
          assignmentGroupId: null,
          assignmentGroupName: null,
        });
      } else if (res.groupResolutionStatus === 'no_assignment_group' || !res.assignmentGroupId) {
        studentsWithoutAssignmentGroupCount++;
        const indSub = data.individualSubmissionsByUserId.get(uid);
        const indSubmitted = Boolean(
          indSub && (indSub.status === 'submitted' || indSub.files.length > 0 || indSub.onlineText)
        );
        if (indSubmitted) {
          studentHasEffectiveSubmission = true;
        } else {
          studentsWithoutSubmission.push({
            userId: uid,
            fullname: res.fullname,
            ...(includePersonalData && res.email ? { email: res.email } : {}),
            reason: 'no_assignment_group',
            assignmentGroupId: null,
            assignmentGroupName: null,
          });
        }
      } else {
        const gRec = data.groupRecords.get(res.assignmentGroupId);
        if (gRec?.hasSubmitted) {
          studentHasEffectiveSubmission = true;
        } else {
          studentsWithoutSubmission.push({
            userId: uid,
            fullname: res.fullname,
            ...(includePersonalData && res.email ? { email: res.email } : {}),
            reason: 'group_not_submitted',
            assignmentGroupId: res.assignmentGroupId,
            assignmentGroupName: res.assignmentGroupName,
          });
        }
      }
    } else {
      const indSub = data.individualSubmissionsByUserId.get(uid);
      const indSubmitted = Boolean(
        indSub && (indSub.status === 'submitted' || indSub.files.length > 0 || indSub.onlineText)
      );
      if (indSubmitted) {
        studentHasEffectiveSubmission = true;
      } else {
        studentsWithoutSubmission.push({
          userId: uid,
          fullname: res.fullname,
          ...(includePersonalData && res.email ? { email: res.email } : {}),
          reason: 'not_submitted',
          assignmentGroupId: null,
          assignmentGroupName: null,
        });
      }
    }

    if (studentHasEffectiveSubmission) {
      studentsWithEffectiveSubmissionCount++;
      if (ev.numericGrade !== null) submittedAndGradedStudentsCount++;
      if (ev.hasGradingFeedbackComment) submittedAndFeedbackStudentsCount++;
    }
  }

  const groupsByGradingStatus = {
    fully_graded: 0,
    partially_graded: 0,
    not_graded: 0,
    inconsistent: 0,
  };
  let groupsWithGradeDivergenceCount = 0;
  const inconsistencies: Array<{
    type: string;
    severity: 'warning' | 'info';
    groupId?: number;
    studentId?: number;
    message: string;
  }> = [];

  for (const g of submittedGroups) {
    groupsByGradingStatus[g.aggregatedGradingStatus]++;
    if (g.hasGradeDivergence) {
      groupsWithGradeDivergenceCount++;
      inconsistencies.push({
        type: 'member_grade_divergence',
        severity: 'warning',
        groupId: g.assignmentGroupId,
        message: `Grupo "${g.assignmentGroupName}" (${g.assignmentGroupId}) possui notas divergentes entre seus integrantes: [${g.distinctMemberGrades.join(', ')}].`,
      });
    } else if (g.aggregatedGradingStatus === 'partially_graded') {
      inconsistencies.push({
        type: 'partially_graded_group',
        severity: 'warning',
        groupId: g.assignmentGroupId,
        message: `Grupo "${g.assignmentGroupName}" (${g.assignmentGroupId}) está parcialmente avaliado (${g.gradedMembersCount}/${g.memberCount} integrantes com nota).`,
      });
    }
    if (
      g.rawCollectiveGradingStatus === 'notgraded' &&
      g.aggregatedGradingStatus === 'fully_graded'
    ) {
      // Informational note explaining Moodle's userid=0 row behavior
    }
  }

  for (const amb of ambiguousStudents) {
    inconsistencies.push({
      type: 'student_in_multiple_groups',
      severity: 'warning',
      studentId: amb.userId,
      message: `Estudante "${amb.fullname}" (${amb.userId}) pertence a múltiplos grupos candidatos na tarefa: [${amb.candidates.map((c) => `${c.id} (${c.name})`).join(', ')}].`,
    });
  }

  for (const g of unsubmittedGroups) {
    inconsistencies.push({
      type: 'group_without_submission',
      severity: 'info',
      groupId: g.assignmentGroupId,
      message: `Grupo "${g.assignmentGroupName}" (${g.assignmentGroupId}) possui ${g.memberCount} integrante(s), mas não tem entrega enviada.`,
    });
  }

  const totalStudents = data.studentIds.length;
  const pct = (num: number, den: number) =>
    den > 0 ? Math.round((num / den) * 10000) / 100 : 0;

  // Pagination support over groups (or individual students when non-team assignment)
  const rawOffset = cursor && /^\d+$/.test(cursor) ? Math.max(0, Number(cursor)) : 0;
  const effectiveLimit = limit ? Math.max(1, Math.min(200, limit)) : 200;

  let formattedGroups: Record<string, unknown>[] | undefined;
  let formattedIndividuals: Record<string, unknown>[] | undefined;
  let totalPaginatedItems = 0;
  let returnedPaginatedItems = 0;
  let nextCursor: string | null = null;

  if (ctx.assignment.teamsubmission) {
    totalPaginatedItems = allGroups.length;
    const sliced = includeGroups
      ? allGroups.slice(rawOffset, rawOffset + effectiveLimit)
      : [];
    returnedPaginatedItems = sliced.length;
    if (includeGroups && rawOffset + effectiveLimit < allGroups.length) {
      nextCursor = String(rawOffset + effectiveLimit);
    }

    if (includeGroups) {
      formattedGroups = sliced.map((g) => ({
        assignmentGroupId: g.assignmentGroupId,
        assignmentGroupName: g.assignmentGroupName,
        memberCount: g.memberCount,
        ...(includeMembers
          ? {
              members: g.members.map((m) => sanitizeMemberForOutput(m, includePersonalData)),
            }
          : {}),
        hasSubmitted: g.hasSubmitted,
        groupSubmissionId: g.groupSubmissionId,
        submissionStatus: g.submissionStatus,
        submittedAt: g.submittedAt,
        rawCollectiveGradingStatus: g.rawCollectiveGradingStatus,
        filesCount: g.filesCount,
        files: g.files,
        ...(includeSubmissionComments && g.submissionComments
          ? { submissionComments: g.submissionComments }
          : {}),
        aggregatedGradingStatus: g.aggregatedGradingStatus,
        ...(includeGrades
          ? {
              commonGroupGrade: g.commonGroupGrade,
              hasGradeDivergence: g.hasGradeDivergence,
              distinctMemberGrades: g.distinctMemberGrades,
              gradedMembersCount: g.gradedMembersCount,
              lastGradedAt: g.lastGradedAt,
              lastGraderUserId: g.lastGraderUserId,
              ...(g.lastGraderName ? { lastGraderName: g.lastGraderName } : {}),
            }
          : {}),
        membersWithFeedbackCount: g.membersWithFeedbackCount,
        ...(includeWorkflow ? { workflowState: g.workflowState } : {}),
        ...(includeVisibility
          ? {
              publicationState: g.publicationState,
              allVisibleToStudents: g.allVisibleToStudents,
            }
          : {}),
        ...(includeMembers
          ? {
              memberEvaluations: g.memberEvaluations.map((ev) =>
                sanitizeMemberEvalForOutput(ev, {
                  includeGrades,
                  includeFeedback,
                  includeWorkflow,
                  includeVisibility,
                  includePersonalData,
                })
              ),
            }
          : {}),
      }));
    }
  } else {
    totalPaginatedItems = data.studentIds.length;
    const slicedIds = data.studentIds.slice(rawOffset, rawOffset + effectiveLimit);
    returnedPaginatedItems = slicedIds.length;
    if (rawOffset + effectiveLimit < data.studentIds.length) {
      nextCursor = String(rawOffset + effectiveLimit);
    }
    formattedIndividuals = slicedIds.map((uid) => {
      const ev = data.memberEvaluationsByUserId.get(uid)!;
      const sub = data.individualSubmissionsByUserId.get(uid);
      return {
        ...sanitizeMemberEvalForOutput(ev, {
          includeGrades,
          includeFeedback,
          includeWorkflow,
          includeVisibility,
          includePersonalData,
        }),
        hasSubmitted: Boolean(
          sub && (sub.status === 'submitted' || sub.files.length > 0 || sub.onlineText)
        ),
        submissionId: sub?.submissionId ?? null,
        submissionStatus: sub?.status ?? 'new',
        submittedAt: formatIsoDate(sub?.timemodified),
        filesCount: sub?.files.length ?? 0,
        files: sub?.files ?? [],
      };
    });
  }

  return {
    assignment: {
      id: ctx.assignment.id,
      cmid: ctx.assignment.cmid ?? null,
      courseId: ctx.courseId,
      courseName: ctx.courseName ?? null,
      name: ctx.assignment.name,
      maxGrade: ctx.assignment.maxGrade,
      isTeamSubmission: ctx.assignment.teamsubmission,
      teamSubmissionGroupingId: ctx.assignment.teamsubmissiongroupingid,
      preventSubmissionNotInGroup: ctx.assignment.preventsubmissionnotingroup,
      markingWorkflowEnabled: ctx.assignment.markingworkflow,
      markingAllocationEnabled: ctx.assignment.markingallocation,
      blindMarking: ctx.assignment.blindmarking,
      dueDate: formatIsoDate(ctx.assignment.duedate),
      ...(gradingUrl ? { gradingUrl } : {}),
    },
    generalCourseGroupIdsExcluded: Array.from(data.generalCourseGroupIds).sort((a, b) => a - b),
    summary: {
      totalEnrolledStudents: totalStudents,
      totalConfiguredGroups: allGroups.length,
      groupsWithSubmissionsCount: submittedGroups.length,
      groupsWithoutSubmissionsCount: unsubmittedGroups.length,
      collectiveSubmissionsCount: Array.from(data.collectiveSubmissionsByGroupId.entries()).filter(
        ([gid, s]) =>
          !data.generalCourseGroupIds.has(gid) &&
          (s.status === 'submitted' || s.files.length > 0 || Boolean(s.onlineText))
      ).length,
      individualSubmissionsCount: Array.from(data.individualSubmissionsByUserId.values()).filter(
        (s) => s.files.length > 0 || Boolean(s.onlineText)
      ).length,
      distinctFilesCount: data.distinctFileKeys.size,
      studentsWithEffectiveSubmissionCount,
      studentsWithoutSubmissionCount: studentsWithoutSubmission.length,
      studentsWithoutAssignmentGroupCount,
      ambiguousStudentsCount: ambiguousStudents.length,
      gradedStudentsCount,
      ungradedStudentsCount: Math.max(0, totalStudents - gradedStudentsCount),
      studentsWithFeedbackCount,
      groupsByGradingStatus,
      groupsWithGradeDivergenceCount,
    },
    coverage: {
      submissionCoveragePercent: pct(studentsWithEffectiveSubmissionCount, totalStudents),
      gradingCoverageOfSubmittedPercent: pct(
        submittedAndGradedStudentsCount,
        studentsWithEffectiveSubmissionCount
      ),
      gradingCoverageOfTotalPercent: pct(gradedStudentsCount, totalStudents),
      feedbackCoverageOfSubmittedPercent: pct(
        submittedAndFeedbackStudentsCount,
        studentsWithEffectiveSubmissionCount
      ),
      inconsistenciesCount: inconsistencies.length,
      inconsistencies,
    },
    ...(formattedGroups !== undefined ? { groups: formattedGroups } : {}),
    ...(formattedIndividuals !== undefined ? { students: formattedIndividuals } : {}),
    unsubmittedGroups: unsubmittedGroups.map((g) => ({
      assignmentGroupId: g.assignmentGroupId,
      assignmentGroupName: g.assignmentGroupName,
      memberCount: g.memberCount,
      ...(includeMembers
        ? { members: g.members.map((m) => sanitizeMemberForOutput(m, includePersonalData)) }
        : {}),
    })),
    studentsWithoutSubmission,
    ...(ambiguousStudents.length > 0 ? { ambiguousStudents } : {}),
    pagination: {
      totalItems: totalPaginatedItems,
      returnedItems: returnedPaginatedItems,
      offset: rawOffset,
      limit: effectiveLimit,
      cursor: cursor ?? null,
      nextCursor,
    },
  };
}
