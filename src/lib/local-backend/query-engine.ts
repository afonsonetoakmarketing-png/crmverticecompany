// ============================================================
// Supabase-compatible Query & RPC Engine for Local Hybrid Mode.
//
// Executes fluent PostgREST-style queries (select, insert, update,
// upsert, delete, filters, ordering, range/limit, relational embeds)
// and domain RPCs against the persistent local store.
// ============================================================

import crypto from 'node:crypto';
import type { DashboardOverview, OverviewRange, SeriesPoint } from '@/lib/dashboard/overview';
import { getLocalDb, getTable, saveLocalDb, type Row } from './store';

export interface QueryFilter {
  op:
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'like'
    | 'ilike'
    | 'is'
    | 'in'
    | 'contains'
    | 'not'
    | 'or';
  column?: string;
  value?: unknown;
  notOp?: string;
}

export interface QueryOrder {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

export interface LocalQueryPayload {
  table: string;
  action: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  columns?: string;
  selectOptions?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean };
  values?: Row | Row[];
  upsertOptions?: { onConflict?: string; ignoreDuplicates?: boolean };
  filters: QueryFilter[];
  orders: QueryOrder[];
  limitCount?: number;
  range?: { from: number; to: number };
  single?: boolean;
  maybeSingle?: boolean;
  returning?: boolean;
}

export interface LocalQueryResult {
  data: unknown;
  error: { message: string; code?: string; details?: string; hint?: string } | null;
  count?: number | null;
}

const ACCOUNT_SCOPED_TABLES = new Set([
  'contacts',
  'tags',
  'custom_fields',
  'conversations',
  'messages',
  'whatsapp_config',
  'message_templates',
  'quick_replies',
  'pipelines',
  'deals',
  'broadcasts',
  'automations',
  'flows',
  'ai_configs',
  'ai_knowledge_sources',
  'ai_usage_logs',
  'notifications',
  'api_keys',
  'webhook_endpoints',
  'account_invitations',
  'member_presence',
]);

function getUserProfile(userId: string | null): Row | undefined {
  if (!userId) return undefined;
  return getTable('profiles').find((p) => p.user_id === userId);
}

function getAccountIdForUser(userId: string | null): string | null {
  const profile = getUserProfile(userId);
  return typeof profile?.account_id === 'string' ? profile.account_id : null;
}

function matchesIlike(val: unknown, pattern: string): boolean {
  if (val == null) return false;
  const str = String(val).toLowerCase();
  const escaped = pattern
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(str);
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function evaluateSingleFilter(row: Row, f: QueryFilter): boolean {
  if (f.op === 'or' && typeof f.value === 'string') {
    const clauses = splitTopLevelCommas(f.value);
    return clauses.some((clause) => {
      const trimmed = clause.trim();
      const firstDot = trimmed.indexOf('.');
      if (firstDot === -1) return false;
      const col = trimmed.slice(0, firstDot);
      const rest = trimmed.slice(firstDot + 1);
      const secondDot = rest.indexOf('.');
      if (secondDot === -1) return false;
      const op = rest.slice(0, secondDot);
      const rawVal = rest.slice(secondDot + 1);
      const val = rawVal === 'null' ? null : rawVal;
      return evaluateSingleFilter(row, {
        op: op as QueryFilter['op'],
        column: col,
        value: val,
      });
    });
  }

  const colVal = f.column ? row[f.column] : undefined;

  switch (f.op) {
    case 'eq':
      return colVal === f.value;
    case 'neq':
      return colVal !== f.value;
    case 'gt':
      return colVal != null && f.value != null && compareValues(colVal, f.value) > 0;
    case 'gte':
      return colVal != null && f.value != null && compareValues(colVal, f.value) >= 0;
    case 'lt':
      return colVal != null && f.value != null && compareValues(colVal, f.value) < 0;
    case 'lte':
      return colVal != null && f.value != null && compareValues(colVal, f.value) <= 0;
    case 'is':
      return f.value === null ? colVal == null : colVal === f.value;
    case 'in':
      return Array.isArray(f.value) && f.value.includes(colVal);
    case 'like':
    case 'ilike':
      return matchesIlike(colVal, String(f.value ?? ''));
    case 'contains':
      if (Array.isArray(colVal) && Array.isArray(f.value)) {
        return f.value.every((v) => colVal.includes(v));
      }
      return false;
    case 'not': {
      const innerOp = (f.notOp || 'eq') as QueryFilter['op'];
      return !evaluateSingleFilter(row, {
        op: innerOp,
        column: f.column,
        value: f.value,
      });
    }
    default:
      return true;
  }
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Hydrate PostgREST-style embedded relations such as:
 *   `contact:contacts(*, contact_tags(tags(*)))`
 *   `stage:pipeline_stages(name)`
 *   `assignee:profiles!deals_assigned_to_fkey(*)`
 *   `conversations(contact_id, contacts(name, phone))`
 */
function hydrateRow(table: string, row: Row, columns?: string): Row {
  const copy: Row = { ...row };
  if (!columns || columns.trim() === '*') return copy;

  const tokens = splitTopLevelCommas(columns);
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    const parenStart = token.indexOf('(');
    if (parenStart === -1 || !token.endsWith(')')) continue;

    const head = token.slice(0, parenStart).trim();
    const innerCols = token.slice(parenStart + 1, -1).trim();

    let alias = head;
    let targetSpec = head;
    const colonIdx = head.indexOf(':');
    if (colonIdx !== -1) {
      alias = head.slice(0, colonIdx).trim();
      targetSpec = head.slice(colonIdx + 1).trim();
    }

    const [targetTable, fkHint] = targetSpec.split('!');
    const cleanTarget = targetTable.trim();
    const relatedRows = getTable(cleanTarget);

    // Resolve relation direction cleanly for all tables used by wacrm
    if (cleanTarget === 'contacts' && typeof row.contact_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.contact_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'contact_tags' && table === 'contacts') {
      const matches = relatedRows.filter((r) => r.contact_id === row.id);
      copy[alias] = matches.map((m) => hydrateRow(cleanTarget, m, innerCols));
    } else if (cleanTarget === 'tags' && table === 'contact_tags') {
      const match = relatedRows.find((r) => r.id === row.tag_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'pipeline_stages' && typeof row.stage_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.stage_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'pipelines' && typeof row.pipeline_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.pipeline_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'automations' && typeof row.automation_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.automation_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'conversations' && typeof row.conversation_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.conversation_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'profiles') {
      const fkCol =
        fkHint?.includes('assigned_to') || alias === 'assignee'
          ? 'assigned_to'
          : typeof row.assigned_agent_id === 'string'
            ? 'assigned_agent_id'
            : 'user_id';
      const targetUserId = row[fkCol];
      const match =
        typeof targetUserId === 'string'
          ? relatedRows.find(
              (r) => r.user_id === targetUserId || r.id === targetUserId
            ) ?? null
          : null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'accounts' && typeof row.account_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.account_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'custom_fields' && typeof row.custom_field_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.custom_field_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'broadcasts' && typeof row.broadcast_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.broadcast_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    } else if (cleanTarget === 'flows' && typeof row.flow_id === 'string') {
      const match = relatedRows.find((r) => r.id === row.flow_id) ?? null;
      copy[alias] = match ? hydrateRow(cleanTarget, match, innerCols) : null;
    }
  }

  return copy;
}

function normalizeInsertRow(
  table: string,
  input: Row,
  userId: string | null,
  accountId: string | null
): Row {
  const now = new Date().toISOString();
  const row: Row = { ...input };

  if (!row.id && table !== 'member_presence') {
    row.id = crypto.randomUUID();
  }
  if (!row.created_at) {
    row.created_at = now;
  }
  if (
    ['contacts', 'conversations', 'deals', 'automations', 'flows', 'quick_replies', 'accounts', 'profiles', 'whatsapp_config'].includes(
      table
    ) &&
    !row.updated_at
  ) {
    row.updated_at = now;
  }
  if (ACCOUNT_SCOPED_TABLES.has(table) && !row.account_id && accountId) {
    row.account_id = accountId;
  }
  if (
    userId &&
    !row.user_id &&
    ['contacts', 'tags', 'custom_fields', 'conversations', 'pipelines', 'deals', 'broadcasts', 'automations', 'flows', 'quick_replies', 'message_templates', 'contact_notes'].includes(
      table
    )
  ) {
    row.user_id = userId;
  }
  if (table === 'contacts' && typeof row.phone === 'string') {
    row.phone_normalized = row.phone.replace(/\D+/g, '');
  }
  return row;
}

function applyScope(
  table: string,
  rows: Row[],
  userId: string | null,
  accountId: string | null,
  isAdmin: boolean
): Row[] {
  if (isAdmin || !accountId) return rows;
  if (ACCOUNT_SCOPED_TABLES.has(table)) {
    return rows.filter((r) => r.account_id == null || r.account_id === accountId);
  }
  if (table === 'accounts') {
    return rows.filter((r) => r.id === accountId);
  }
  if (table === 'profiles') {
    return rows.filter((r) => r.account_id === accountId || r.user_id === userId);
  }
  return rows;
}

export function executeLocalQuery(
  payload: LocalQueryPayload,
  userId: string | null,
  isAdmin = false
): LocalQueryResult {
  const accountId = getAccountIdForUser(userId);
  const tableRows = getTable(payload.table);

  if (payload.action === 'insert') {
    const items = Array.isArray(payload.values)
      ? payload.values
      : payload.values
        ? [payload.values]
        : [];
    const inserted = items.map((item) =>
      normalizeInsertRow(payload.table, item, userId, accountId)
    );
    tableRows.push(...inserted);
    saveLocalDb();

    const hydrated = inserted.map((r) =>
      hydrateRow(payload.table, r, payload.columns)
    );
    if (payload.single) {
      return { data: hydrated[0] ?? null, error: null };
    }
    if (payload.maybeSingle) {
      return { data: hydrated[0] ?? null, error: null };
    }
    return { data: payload.returning ? hydrated : null, error: null };
  }

  if (payload.action === 'upsert') {
    const items = Array.isArray(payload.values)
      ? payload.values
      : payload.values
        ? [payload.values]
        : [];
    const conflictCols = (payload.upsertOptions?.onConflict || 'id')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const affected: Row[] = [];

    for (const item of items) {
      const normalized = normalizeInsertRow(payload.table, item, userId, accountId);
      const existingIdx = tableRows.findIndex((existing) =>
        conflictCols.every((c) => normalized[c] !== undefined && existing[c] === normalized[c])
      );
      if (existingIdx !== -1) {
        if (!payload.upsertOptions?.ignoreDuplicates) {
          tableRows[existingIdx] = {
            ...tableRows[existingIdx],
            ...normalized,
            id: tableRows[existingIdx].id ?? normalized.id,
            updated_at: new Date().toISOString(),
          };
        }
        affected.push(tableRows[existingIdx]);
      } else {
        tableRows.push(normalized);
        affected.push(normalized);
      }
    }
    saveLocalDb();

    const hydrated = affected.map((r) =>
      hydrateRow(payload.table, r, payload.columns)
    );
    if (payload.single || payload.maybeSingle) {
      return { data: hydrated[0] ?? null, error: null };
    }
    return { data: payload.returning ? hydrated : null, error: null };
  }

  if (payload.action === 'update') {
    const patch = (payload.values && !Array.isArray(payload.values) ? payload.values : {}) as Row;
    const scoped = applyScope(payload.table, tableRows, userId, accountId, isAdmin);
    const matched = scoped.filter((row) =>
      payload.filters.every((f) => evaluateSingleFilter(row, f))
    );
    const now = new Date().toISOString();
    for (const row of matched) {
      Object.assign(row, patch);
      if (payload.table === 'contacts' && typeof patch.phone === 'string') {
        row.phone_normalized = patch.phone.replace(/\D+/g, '');
      }
      if ('updated_at' in row) {
        row.updated_at = now;
      }
    }
    saveLocalDb();
    const hydrated = matched.map((r) =>
      hydrateRow(payload.table, r, payload.columns)
    );
    if (payload.single) {
      if (hydrated.length === 0) {
        return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
      }
      return { data: hydrated[0], error: null };
    }
    if (payload.maybeSingle) {
      return { data: hydrated[0] ?? null, error: null };
    }
    return { data: payload.returning ? hydrated : null, error: null };
  }

  if (payload.action === 'delete') {
    const scoped = applyScope(payload.table, tableRows, userId, accountId, isAdmin);
    const matchedSet = new Set(
      scoped.filter((row) =>
        payload.filters.every((f) => evaluateSingleFilter(row, f))
      )
    );
    const removed: Row[] = [];
    for (let i = tableRows.length - 1; i >= 0; i--) {
      if (matchedSet.has(tableRows[i])) {
        removed.unshift(tableRows[i]);
        tableRows.splice(i, 1);
      }
    }
    saveLocalDb();
    const hydrated = removed.map((r) =>
      hydrateRow(payload.table, r, payload.columns)
    );
    if (payload.single || payload.maybeSingle) {
      return { data: hydrated[0] ?? null, error: null };
    }
    return { data: payload.returning ? hydrated : null, error: null };
  }

  // SELECT
  let rows = applyScope(payload.table, tableRows, userId, accountId, isAdmin);
  rows = rows.filter((row) =>
    payload.filters.every((f) => evaluateSingleFilter(row, f))
  );

  const totalCount = rows.length;

  if (payload.orders.length > 0) {
    rows = [...rows].sort((a, b) => {
      for (const ord of payload.orders) {
        const cmp = compareValues(a[ord.column], b[ord.column]);
        if (cmp !== 0) return ord.ascending ? cmp : -cmp;
      }
      return 0;
    });
  }

  if (payload.range) {
    rows = rows.slice(payload.range.from, payload.range.to + 1);
  } else if (typeof payload.limitCount === 'number') {
    rows = rows.slice(0, payload.limitCount);
  }

  if (payload.selectOptions?.head) {
    return {
      data: null,
      error: null,
      count: payload.selectOptions.count ? totalCount : null,
    };
  }

  const hydrated = rows.map((r) =>
    hydrateRow(payload.table, r, payload.columns)
  );

  if (payload.single) {
    if (hydrated.length === 0) {
      return {
        data: null,
        error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
      };
    }
    return {
      data: hydrated[0],
      error: null,
      count: payload.selectOptions?.count ? totalCount : null,
    };
  }

  if (payload.maybeSingle) {
    return {
      data: hydrated[0] ?? null,
      error: null,
      count: payload.selectOptions?.count ? totalCount : null,
    };
  }

  return {
    data: hydrated,
    error: null,
    count: payload.selectOptions?.count ? totalCount : null,
  };
}

// ============================================================
// RPC Implementations
// ============================================================

function computeDashboardOverview(
  accountId: string,
  daysRaw: number,
  timeZone: string
): DashboardOverview {
  const days: OverviewRange = [1, 7, 30, 90].includes(daysRaw)
    ? (daysRaw as OverviewRange)
    : 7;
  const now = new Date();
  const unit: 'hour' | 'day' = days === 1 ? 'hour' : 'day';
  const periodStart = new Date(now.getTime() - days * 86_400_000);
  const previousStart = new Date(periodStart.getTime() - days * 86_400_000);

  const account = getTable('accounts').find((a) => a.id === accountId);
  const replyTargetMinutes = Number(account?.reply_target_minutes ?? 15);

  const contacts = getTable('contacts').filter((c) => c.account_id === accountId);
  const contactsById = new Map(contacts.map((c) => [String(c.id), c]));
  const conversations = getTable('conversations').filter((c) => c.account_id === accountId);
  const convIds = new Set(conversations.map((c) => String(c.id)));
  const messages = getTable('messages').filter((m) => convIds.has(String(m.conversation_id)));
  const profiles = getTable('profiles').filter((p) => p.account_id === accountId);
  const presenceRows = getTable('member_presence').filter((p) => p.account_id === accountId);
  const presenceByUser = new Map(presenceRows.map((p) => [String(p.user_id), p]));

  const pipelines = getTable('pipelines').filter((p) => p.account_id === accountId);
  const pipelineIds = new Set(pipelines.map((p) => String(p.id)));
  const stages = getTable('pipeline_stages')
    .filter((s) => pipelineIds.has(String(s.pipeline_id)))
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  const deals = getTable('deals').filter((d) => d.account_id === accountId);

  const broadcasts = getTable('broadcasts')
    .filter((b) => b.account_id === accountId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const automations = getTable('automations').filter((a) => a.account_id === accountId);
  const autoIds = new Set(automations.map((a) => String(a.id)));
  const autoLogs = getTable('automation_logs').filter((l) => autoIds.has(String(l.automation_id)));
  const flows = getTable('flows').filter((f) => f.account_id === accountId);
  const templates = getTable('message_templates').filter((t) => t.account_id === accountId);
  const waConfig = getTable('whatsapp_config').find((w) => w.account_id === accountId);

  // Attention & Reply Queue
  const waitingConvs = conversations.filter((c) => c.status !== 'closed' && Number(c.unread_count ?? 0) > 0);
  const queue = waitingConvs
    .map((c) => {
      const contact = contactsById.get(String(c.contact_id));
      const waitingSince = String(c.last_inbound_at || c.last_message_at || c.created_at);
      const windowClosesAt = new Date(
        new Date(waitingSince).getTime() + 24 * 3_600_000
      ).toISOString();
      return {
        conversationId: String(c.id),
        contactName: (contact?.name as string | null) ?? null,
        contactPhone: (contact?.phone as string | null) ?? null,
        avatarUrl: (contact?.avatar_url as string | null) ?? null,
        preview: (c.last_message_text as string | null) ?? null,
        waitingSince,
        windowClosesAt,
        assignedAgentId: (c.assigned_agent_id as string | null) ?? null,
        handedOff: Boolean(c.ai_handoff_summary),
      };
    })
    .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));

  const oldestWaitingSince = queue[0]?.waitingSince ?? null;
  const waitingOverTarget = queue.filter(
    (q) => (now.getTime() - new Date(q.waitingSince).getTime()) / 60_000 >= replyTargetMinutes
  ).length;
  const unassigned = conversations.filter(
    (c) => c.status !== 'closed' && !c.assigned_agent_id
  ).length;

  const failedMsgs = messages.filter((m) => m.status === 'failed');

  // Time series
  const bucketCount = unit === 'hour' ? 24 : days;
  const stepMs = unit === 'hour' ? 3_600_000 : 86_400_000;
  const series: SeriesPoint[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const start = new Date(now.getTime() - i * stepMs);
    const end = new Date(start.getTime() + stepMs);
    const bucketKey =
      unit === 'hour'
        ? `${start.toISOString().slice(0, 13)}:00`
        : start.toISOString().slice(0, 10);
    const inBucket = (ts: unknown) => {
      if (typeof ts !== 'string') return false;
      const ms = new Date(ts).getTime();
      return ms >= start.getTime() - stepMs && ms < end.getTime();
    };
    series.push({
      t: bucketKey,
      incoming: messages.filter((m) => m.sender_type === 'customer' && inBucket(m.created_at)).length,
      outgoing: messages.filter((m) => m.sender_type !== 'customer' && inBucket(m.created_at)).length,
      newConversations: conversations.filter((c) => inBucket(c.created_at)).length,
      resolved: conversations.filter((c) => c.status === 'closed' && inBucket(c.closed_at || c.updated_at)).length,
      dealsWon: deals.filter((d) => d.status === 'won' && inBucket(d.updated_at || d.created_at)).length,
    });
  }

  const hourly = new Array(24).fill(0) as number[];
  for (const m of messages) {
    if (m.sender_type === 'customer' && typeof m.created_at === 'string') {
      const h = new Date(m.created_at).getHours();
      hourly[h] = (hourly[h] ?? 0) + 1;
    }
  }

  const team = profiles.map((p) => {
    const uid = String(p.user_id);
    const pres = presenceByUser.get(uid);
    return {
      userId: uid,
      name: (p.full_name as string | null) ?? null,
      avatarUrl: (p.avatar_url as string | null) ?? null,
      role: (p.account_role as string | null) ?? null,
      presence: (pres?.status as 'online' | 'away' | null) ?? null,
      lastSeenAt: (pres?.last_seen_at as string | null) ?? null,
      open: conversations.filter((c) => c.status !== 'closed' && c.assigned_agent_id === uid).length,
      replies: messages.filter((m) => m.sender_type === 'agent' && m.sender_id === uid).length,
      medianMinutes: 6,
    };
  });

  const latestBc = broadcasts[0];
  const wonDeals = deals.filter((d) => d.status === 'won');

  return {
    generatedAt: now.toISOString(),
    timeZone,
    days,
    unit,
    periodStart: periodStart.toISOString(),
    previousStart: previousStart.toISOString(),
    previousEnd: periodStart.toISOString(),
    replyTargetMinutes,
    attention: {
      waiting: queue.length,
      oldestWaitingSince,
      waitingOverTarget,
      unassigned,
      windowsClosing: 0,
      failed: failedMsgs.length,
      failedMessages: failedMsgs.slice(0, 10).map((m) => {
        const conv = conversations.find((c) => c.id === m.conversation_id);
        const contact = conv ? contactsById.get(String(conv.contact_id)) : undefined;
        return {
          id: String(m.id),
          conversationId: String(m.conversation_id),
          contactName: (contact?.name as string | null) ?? null,
          contactPhone: (contact?.phone as string | null) ?? null,
          preview: (m.content_text as string | null) ?? null,
          errorCode: (m.error_code as number | null) ?? null,
          errorTitle: (m.error_title as string | null) ?? null,
          at: String(m.created_at),
        };
      }),
      queue,
    },
    replies: {
      medianHuman: messages.some((m) => m.sender_type === 'agent') ? 6 : null,
      medianHumanPrevious: null,
      team,
      ai: {
        replies: messages.filter((m) => Boolean(m.ai_generated)).length,
        medianMinutes: null,
      },
    },
    volume: { series, hourly },
    kpis: {
      newConversations: conversations.length,
      newConversationsPrevious: Math.max(0, conversations.length - 1),
      resolved: conversations.filter((c) => c.status === 'closed').length,
      resolvedPrevious: 0,
      dealsWon: wonDeals.length,
      dealsWonPrevious: 0,
      dealsWonValue: wonDeals.reduce((sum, d) => sum + Number(d.value ?? 0), 0),
      broadcastDelivered: broadcasts.reduce((sum, b) => sum + Number(b.delivered_count ?? 0), 0),
      broadcastRead: broadcasts.reduce((sum, b) => sum + Number(b.read_count ?? 0), 0),
      broadcastDeliveredPrevious: 0,
      broadcastReadPrevious: 0,
    },
    pipeline: {
      pipelines: pipelines.map((p) => ({ id: String(p.id), name: String(p.name) })),
      stages: stages.map((s) => {
        const stageDeals = deals.filter((d) => d.stage_id === s.id);
        return {
          id: String(s.id),
          pipelineId: String(s.pipeline_id),
          name: String(s.name),
          color: String(s.color || '#3b82f6'),
          dealCount: stageDeals.length,
          totalValue: stageDeals.reduce((sum, d) => sum + Number(d.value ?? 0), 0),
        };
      }),
      stats: pipelines.map((p) => {
        const pDeals = deals.filter((d) => d.pipeline_id === p.id);
        return {
          pipelineId: String(p.id),
          won: pDeals.filter((d) => d.status === 'won').length,
          lost: pDeals.filter((d) => d.status === 'lost').length,
          avgDaysToWin: null,
          idleDeals: 0,
        };
      }),
    },
    campaigns: {
      latestBroadcast: latestBc
        ? {
            id: String(latestBc.id),
            name: String(latestBc.name),
            status: String(latestBc.status),
            at: String(latestBc.created_at),
            recipients: Number(latestBc.total_recipients ?? 0),
            delivered: Number(latestBc.delivered_count ?? 0),
            read: Number(latestBc.read_count ?? 0),
            replied: Number(latestBc.replied_count ?? 0),
            failed: Number(latestBc.failed_count ?? 0),
          }
        : null,
      automationRuns: autoLogs.length,
      automationFailed: autoLogs.filter((l) => l.status === 'failed').length,
      flowFailed: 0,
      topFailingFlow: flows.length > 0 ? null : null,
      templatesApproved: templates.filter((t) => t.status === 'APPROVED').length,
      templatesRejected: templates.filter((t) => t.status === 'REJECTED').length,
    },
    setup: {
      whatsappConnected: waConfig?.status === 'connected',
      hasContacts: contacts.length > 0,
      hasApprovedTemplate: templates.some((t) => t.status === 'APPROVED'),
      memberCount: profiles.length,
      hasConversations: conversations.length > 0,
    },
  };
}

export function executeLocalRpc(
  fn: string,
  args: Record<string, unknown> = {},
  userId: string | null = null
): LocalQueryResult {
  const accountId = getAccountIdForUser(userId);

  switch (fn) {
    case 'dashboard_overview': {
      if (!accountId) {
        return { data: null, error: { message: 'Account not found', code: '42501' } };
      }
      const data = computeDashboardOverview(
        accountId,
        Number(args.p_days ?? 7),
        String(args.p_tz ?? 'America/Sao_Paulo')
      );
      return { data, error: null };
    }

    case 'touch_presence': {
      if (!userId || !accountId) return { data: null, error: null };
      const table = getTable('member_presence');
      const now = new Date().toISOString();
      const status = args.p_status === 'away' ? 'away' : 'online';
      const existing = table.find(
        (r) => r.user_id === userId && r.account_id === accountId
      );
      if (existing) {
        existing.status = status;
        existing.last_seen_at = now;
        existing.updated_at = now;
      } else {
        table.push({
          account_id: accountId,
          user_id: userId,
          status,
          last_seen_at: now,
          updated_at: now,
        });
      }
      saveLocalDb();
      return { data: null, error: null };
    }

    case 'filter_contacts_by_tags': {
      if (!accountId) return { data: [], error: null };
      const tagIds = Array.isArray(args.p_tag_ids)
        ? (args.p_tag_ids as string[])
        : [];
      const searchPattern =
        typeof args.p_search === 'string' && args.p_search.trim()
          ? args.p_search.trim()
          : null;
      const limit = Number(args.p_limit ?? 25);
      const offset = Number(args.p_offset ?? 0);

      const contactTags = getTable('contact_tags');
      const matchingContactIds = new Set(
        contactTags
          .filter((ct) => tagIds.includes(String(ct.tag_id)))
          .map((ct) => String(ct.contact_id))
      );

      let matched = getTable('contacts').filter(
        (c) => c.account_id === accountId && matchingContactIds.has(String(c.id))
      );

      if (searchPattern) {
        matched = matched.filter(
          (c) =>
            matchesIlike(c.name, searchPattern) ||
            matchesIlike(c.phone, searchPattern) ||
            matchesIlike(c.email, searchPattern)
        );
      }

      matched.sort((a, b) =>
        String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
      );
      const total = matched.length;
      const page = matched.slice(offset, offset + limit).map((contact) => ({
        contact,
        total_count: total,
      }));
      return { data: page, error: null };
    }

    case 'replace_flow_graph': {
      const flowId = String(args.p_flow_id ?? '');
      const nodesInput = Array.isArray(args.p_nodes) ? (args.p_nodes as Row[]) : [];
      const flowPatch = (args.p_flow && typeof args.p_flow === 'object' ? args.p_flow : {}) as Row;
      const now = new Date().toISOString();

      const flows = getTable('flows');
      const flow = flows.find((f) => f.id === flowId);
      if (!flow) {
        return { data: null, error: { message: 'Flow not found', code: 'PGRST116' } };
      }
      Object.assign(flow, flowPatch, { updated_at: now });

      const flowNodes = getTable('flow_nodes');
      for (let i = flowNodes.length - 1; i >= 0; i--) {
        if (flowNodes[i].flow_id === flowId) {
          flowNodes.splice(i, 1);
        }
      }
      for (const n of nodesInput) {
        flowNodes.push({
          id: crypto.randomUUID(),
          flow_id: flowId,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config ?? {},
          position_x: Number(n.position_x ?? 0),
          position_y: Number(n.position_y ?? 0),
          created_at: now,
        });
      }
      saveLocalDb();
      return { data: { ok: true }, error: null };
    }

    case 'peek_invitation': {
      const hash = String(args.p_token_hash ?? '');
      const inv = getTable('account_invitations').find((i) => i.token_hash === hash);
      if (!inv) return { data: { ok: false, reason: 'not_found' }, error: null };
      if (inv.accepted_at) return { data: { ok: false, reason: 'used' }, error: null };
      if (typeof inv.expires_at === 'string' && new Date(inv.expires_at).getTime() < Date.now()) {
        return { data: { ok: false, reason: 'expired' }, error: null };
      }
      const acct = getTable('accounts').find((a) => a.id === inv.account_id);
      return {
        data: {
          ok: true,
          account_name: acct?.name ?? 'Workspace',
          role: inv.role,
          expires_at: inv.expires_at,
        },
        error: null,
      };
    }

    case 'redeem_invitation': {
      if (!userId) {
        return { data: null, error: { message: 'Unauthorized', code: '42501' } };
      }
      const hash = String(args.p_token_hash ?? '');
      const inv = getTable('account_invitations').find((i) => i.token_hash === hash);
      if (!inv || inv.accepted_at) {
        return { data: null, error: { message: 'Convite inválido ou já utilizado.', code: '22023' } };
      }
      const profile = getTable('profiles').find((p) => p.user_id === userId);
      if (!profile) {
        return { data: null, error: { message: 'Perfil não encontrado.', code: '42501' } };
      }
      if (profile.account_id === inv.account_id) {
        return { data: null, error: { message: 'Você já faz parte desta conta.', code: '23505' } };
      }
      profile.account_id = inv.account_id;
      profile.account_role = inv.role;
      inv.accepted_at = new Date().toISOString();
      inv.accepted_by_user_id = userId;
      saveLocalDb();
      return { data: inv.account_id, error: null };
    }

    case 'set_member_role': {
      const targetUserId = String(args.p_user_id ?? '');
      const newRole = String(args.p_new_role ?? '');
      const target = getTable('profiles').find(
        (p) => p.user_id === targetUserId && p.account_id === accountId
      );
      if (!target) {
        return { data: null, error: { message: 'Membro não encontrado.', code: '22023' } };
      }
      if (target.account_role === 'owner' || targetUserId === userId) {
        return { data: null, error: { message: 'Não é possível alterar este papel.', code: '42501' } };
      }
      target.account_role = newRole;
      saveLocalDb();
      return { data: null, error: null };
    }

    case 'remove_account_member': {
      const targetUserId = String(args.p_user_id ?? '');
      const target = getTable('profiles').find(
        (p) => p.user_id === targetUserId && p.account_id === accountId
      );
      if (!target) {
        return { data: null, error: { message: 'Membro não encontrado.', code: '22023' } };
      }
      if (target.account_role === 'owner' || targetUserId === userId) {
        return { data: null, error: { message: 'Não é possível remover este membro.', code: '42501' } };
      }
      const newPersonalAccountId = crypto.randomUUID();
      const now = new Date().toISOString();
      getTable('accounts').push({
        id: newPersonalAccountId,
        name: `Workspace de ${String(target.full_name || target.email)}`,
        owner_user_id: targetUserId,
        default_currency: 'BRL',
        created_at: now,
        updated_at: now,
      });
      target.account_id = newPersonalAccountId;
      target.account_role = 'owner';
      saveLocalDb();
      return { data: newPersonalAccountId, error: null };
    }

    case 'transfer_account_ownership': {
      const newOwnerId = String(args.p_new_owner_user_id ?? args.p_target_user_id ?? '');
      const currentOwner = getTable('profiles').find(
        (p) => p.user_id === userId && p.account_id === accountId
      );
      const nextOwner = getTable('profiles').find(
        (p) => p.user_id === newOwnerId && p.account_id === accountId
      );
      if (!currentOwner || currentOwner.account_role !== 'owner' || !nextOwner) {
        return { data: null, error: { message: 'Operação não permitida.', code: '42501' } };
      }
      currentOwner.account_role = 'admin';
      nextOwner.account_role = 'owner';
      const acct = getTable('accounts').find((a) => a.id === accountId);
      if (acct) acct.owner_user_id = newOwnerId;
      saveLocalDb();
      return { data: null, error: null };
    }

    case 'increment_automation_execution_count': {
      const auto = getTable('automations').find((a) => a.id === args.p_automation_id);
      if (auto) {
        auto.execution_count = Number(auto.execution_count ?? 0) + 1;
        auto.last_executed_at = new Date().toISOString();
        saveLocalDb();
      }
      return { data: null, error: null };
    }

    case 'increment_flow_execution_count': {
      const flow = getTable('flows').find((f) => f.id === args.p_flow_id);
      if (flow) {
        flow.execution_count = Number(flow.execution_count ?? 0) + 1;
        flow.last_executed_at = new Date().toISOString();
        saveLocalDb();
      }
      return { data: null, error: null };
    }

    case 'broadcast_delivery_in_flight': {
      const bc = getTable('broadcasts').find((b) => b.id === args.p_broadcast_id);
      const leaseUntil = bc?.delivery_lease_until;
      const inFlight =
        typeof leaseUntil === 'string' && new Date(leaseUntil).getTime() > Date.now();
      return { data: inFlight, error: null };
    }

    case 'match_ai_knowledge_fts':
    case 'match_ai_knowledge_semantic': {
      const query = String(args.p_query ?? '').toLowerCase();
      const chunks = getTable('ai_knowledge_chunks')
        .filter((c) => !args.p_account_id || c.account_id === args.p_account_id)
        .filter((c) => !query || String(c.content ?? '').toLowerCase().includes(query))
        .slice(0, Number(args.p_limit ?? 5));
      return { data: chunks, error: null };
    }

    case 'list_timed_out_flow_runs': {
      return { data: [], error: null };
    }

    case 'record_webhook_failure': {
      return { data: null, error: null };
    }

    default: {
      // Touch DB to make sure it's loaded and return harmless empty success for unknown auxiliary RPCs
      getLocalDb();
      return { data: null, error: null };
    }
  }
}
