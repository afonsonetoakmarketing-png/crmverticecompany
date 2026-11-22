// ============================================================
// Persistent local JSON database for Local Hybrid Mode.
//
// Runs ONLY on the Node.js server when Supabase env vars are absent.
// Persists to `.wacrm-local-db.json` (gitignored) so every edit made
// in the UI — users, contacts, conversations, pipelines, deals,
// templates, automations, flows, AI settings, WhatsApp configs —
// survives reloads during development and configuration.
// ============================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_LOCAL_ADMIN } from './mode';

export type Row = Record<string, unknown>;

export interface LocalUserRecord {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  created_at: string;
  updated_at: string;
}

export interface LocalDatabase {
  version: number;
  users: LocalUserRecord[];
  tables: Record<string, Row[]>;
  storage: Record<string, Record<string, { dataUrl: string; contentType: string }>>;
}

const DB_FILE_PATH = path.join(process.cwd(), '.wacrm-local-db.json');

const KNOWN_TABLES = [
  'accounts',
  'profiles',
  'account_invitations',
  'member_presence',
  'contacts',
  'tags',
  'contact_tags',
  'custom_fields',
  'contact_custom_values',
  'contact_notes',
  'conversations',
  'messages',
  'message_reactions',
  'whatsapp_config',
  'message_templates',
  'quick_replies',
  'pipelines',
  'pipeline_stages',
  'deals',
  'broadcasts',
  'broadcast_recipients',
  'automations',
  'automation_steps',
  'automation_logs',
  'automation_pending_steps',
  'automation_pending_executions',
  'flows',
  'flow_nodes',
  'flow_runs',
  'flow_run_events',
  'ai_configs',
  'ai_knowledge_sources',
  'ai_knowledge_chunks',
  'ai_usage_log',
  'ai_usage_logs',
  'notifications',
  'api_keys',
  'webhook_endpoints',
  'webhook_deliveries',
  'n8n_integrations',
] as const;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

function createSeedDatabase(): LocalDatabase {
  const now = new Date();
  const iso = (minutesAgo = 0) =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  const adminUserId = '11111111-1111-4111-8111-111111111111';
  const accountId = '22222222-2222-4222-8222-222222222222';
  const profileId = '33333333-3333-4333-8333-333333333333';

  const pipelineId = '44444444-4444-4444-8444-444444444444';
  const stageNewLead = '44444444-4444-4444-8444-000000000001';
  const stageQualified = '44444444-4444-4444-8444-000000000002';
  const stageProposal = '44444444-4444-4444-8444-000000000003';
  const stageNegotiation = '44444444-4444-4444-8444-000000000004';
  const stageWon = '44444444-4444-4444-8444-000000000005';

  const tagVip = '55555555-5555-4555-8555-000000000001';
  const tagHot = '55555555-5555-4555-8555-000000000002';
  const tagSupport = '55555555-5555-4555-8555-000000000003';

  const contact1 = '66666666-6666-4666-8666-000000000001';
  const contact2 = '66666666-6666-4666-8666-000000000002';
  const contact3 = '66666666-6666-4666-8666-000000000003';

  const conv1 = '77777777-7777-4777-8777-000000000001';
  const conv2 = '77777777-7777-4777-8777-000000000002';
  const conv3 = '77777777-7777-4777-8777-000000000003';

  const auto1 = '88888888-8888-4888-8888-000000000001';

  const tables: Record<string, Row[]> = {};
  for (const name of KNOWN_TABLES) {
    tables[name] = [];
  }

  tables.accounts = [
    {
      id: accountId,
      name: 'Meu Workspace CRM',
      owner_user_id: adminUserId,
      default_currency: 'BRL',
      reply_target_minutes: 15,
      created_at: iso(60 * 24 * 7),
      updated_at: iso(10),
    },
  ];

  tables.profiles = [
    {
      id: profileId,
      user_id: adminUserId,
      full_name: DEFAULT_LOCAL_ADMIN.fullName,
      email: DEFAULT_LOCAL_ADMIN.email,
      avatar_url: null,
      role: 'owner',
      beta_features: [],
      account_id: accountId,
      account_role: 'owner',
      created_at: iso(60 * 24 * 7),
      updated_at: iso(10),
    },
  ];

  tables.member_presence = [
    {
      account_id: accountId,
      user_id: adminUserId,
      status: 'online',
      last_seen_at: iso(0),
      updated_at: iso(0),
    },
  ];

  tables.tags = [
    {
      id: tagVip,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Cliente VIP',
      color: '#f59e0b',
      created_at: iso(60 * 24 * 5),
    },
    {
      id: tagHot,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Lead Quente',
      color: '#ef4444',
      created_at: iso(60 * 24 * 5),
    },
    {
      id: tagSupport,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Suporte',
      color: '#3b82f6',
      created_at: iso(60 * 24 * 5),
    },
  ];

  tables.contacts = [
    {
      id: contact1,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Mariana Silva',
      phone: '+55 11 98765-4321',
      phone_normalized: '5511987654321',
      email: 'mariana@studioaurora.com.br',
      company: 'Studio Aurora',
      avatar_url: null,
      created_at: iso(60 * 48),
      updated_at: iso(12),
    },
    {
      id: contact2,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Carlos Eduardo',
      phone: '+55 21 99123-4567',
      phone_normalized: '5521991234567',
      email: 'carlos@horizontedigital.com.br',
      company: 'Horizonte Digital',
      avatar_url: null,
      created_at: iso(60 * 30),
      updated_at: iso(45),
    },
    {
      id: contact3,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Fernanda Costa',
      phone: '+55 31 98444-1122',
      phone_normalized: '5531984441122',
      email: 'fernanda@clinicaessencia.com.br',
      company: 'Clínica Essência',
      avatar_url: null,
      created_at: iso(60 * 72),
      updated_at: iso(180),
    },
  ];

  tables.contact_tags = [
    { id: crypto.randomUUID(), contact_id: contact1, tag_id: tagHot },
    { id: crypto.randomUUID(), contact_id: contact1, tag_id: tagVip },
    { id: crypto.randomUUID(), contact_id: contact2, tag_id: tagHot },
    { id: crypto.randomUUID(), contact_id: contact3, tag_id: tagSupport },
  ];

  tables.conversations = [
    {
      id: conv1,
      account_id: accountId,
      user_id: adminUserId,
      contact_id: contact1,
      status: 'open',
      assigned_agent_id: adminUserId,
      last_message_text: 'Olá! Gostaria de saber os valores do plano anual para nossa equipe.',
      last_message_at: iso(12),
      unread_count: 1,
      last_inbound_at: iso(12),
      last_reply_at: iso(25),
      closed_at: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_handoff_summary: null,
      created_at: iso(60 * 24),
      updated_at: iso(12),
    },
    {
      id: conv2,
      account_id: accountId,
      user_id: adminUserId,
      contact_id: contact2,
      status: 'open',
      assigned_agent_id: null,
      last_message_text: 'Perfeito, fico aguardando a proposta atualizada por aqui.',
      last_message_at: iso(45),
      unread_count: 1,
      last_inbound_at: iso(45),
      last_reply_at: iso(60),
      closed_at: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_handoff_summary: null,
      created_at: iso(60 * 20),
      updated_at: iso(45),
    },
    {
      id: conv3,
      account_id: accountId,
      user_id: adminUserId,
      contact_id: contact3,
      status: 'closed',
      assigned_agent_id: adminUserId,
      last_message_text: 'Obrigada pelo atendimento rápido!',
      last_message_at: iso(180),
      unread_count: 0,
      last_inbound_at: iso(185),
      last_reply_at: iso(180),
      closed_at: iso(175),
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_handoff_summary: null,
      created_at: iso(60 * 50),
      updated_at: iso(175),
    },
  ];

  tables.messages = [
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      conversation_id: conv1,
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Oi, tudo bem? Vi o CRM de vocês e queria entender como funciona.',
      status: 'read',
      created_at: iso(40),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      conversation_id: conv1,
      sender_type: 'agent',
      sender_id: adminUserId,
      content_type: 'text',
      content_text: 'Olá Mariana! Tudo ótimo. Posso te mostrar uma demonstração personalizada.',
      status: 'read',
      created_at: iso(25),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      conversation_id: conv1,
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Olá! Gostaria de saber os valores do plano anual para nossa equipe.',
      status: 'delivered',
      created_at: iso(12),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      conversation_id: conv2,
      sender_type: 'agent',
      sender_id: adminUserId,
      content_type: 'text',
      content_text: 'Carlos, já estamos preparando os detalhes da integração com WhatsApp.',
      status: 'read',
      created_at: iso(60),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      conversation_id: conv2,
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Perfeito, fico aguardando a proposta atualizada por aqui.',
      status: 'delivered',
      created_at: iso(45),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      conversation_id: conv3,
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Obrigada pelo atendimento rápido!',
      status: 'read',
      created_at: iso(180),
    },
  ];

  tables.pipelines = [
    {
      id: pipelineId,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Funil de Vendas',
      created_at: iso(60 * 24 * 7),
    },
  ];

  tables.pipeline_stages = [
    { id: stageNewLead, pipeline_id: pipelineId, name: 'Novo Lead', color: '#3b82f6', position: 0, created_at: iso(60 * 24 * 7) },
    { id: stageQualified, pipeline_id: pipelineId, name: 'Qualificado', color: '#eab308', position: 1, created_at: iso(60 * 24 * 7) },
    { id: stageProposal, pipeline_id: pipelineId, name: 'Proposta Enviada', color: '#f97316', position: 2, created_at: iso(60 * 24 * 7) },
    { id: stageNegotiation, pipeline_id: pipelineId, name: 'Negociação', color: '#8b5cf6', position: 3, created_at: iso(60 * 24 * 7) },
    { id: stageWon, pipeline_id: pipelineId, name: 'Ganho', color: '#22c55e', position: 4, created_at: iso(60 * 24 * 7) },
  ];

  tables.deals = [
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      user_id: adminUserId,
      pipeline_id: pipelineId,
      stage_id: stageProposal,
      contact_id: contact1,
      conversation_id: conv1,
      assigned_to: adminUserId,
      title: 'Plano Anual — Studio Aurora',
      value: 4800,
      currency: 'BRL',
      status: 'open',
      notes: 'Equipe de 5 atendentes interessada em automações e IA.',
      created_at: iso(60 * 24),
      updated_at: iso(30),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      user_id: adminUserId,
      pipeline_id: pipelineId,
      stage_id: stageNegotiation,
      contact_id: contact2,
      conversation_id: conv2,
      assigned_to: adminUserId,
      title: 'Implementação CRM — Horizonte Digital',
      value: 7500,
      currency: 'BRL',
      status: 'open',
      notes: 'Aguardando aprovação final da diretoria.',
      created_at: iso(60 * 36),
      updated_at: iso(90),
    },
  ];

  tables.message_templates = [
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      user_id: adminUserId,
      name: 'boas_vindas_crm',
      category: 'Utility',
      language: 'pt_BR',
      body_text: 'Olá {{1}}! Bem-vindo(a) ao nosso atendimento pelo WhatsApp. Como podemos ajudar hoje?',
      footer_text: 'Equipe de Atendimento',
      status: 'APPROVED',
      quality_score: 'GREEN',
      created_at: iso(60 * 24 * 4),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      user_id: adminUserId,
      name: 'confirmacao_reuniao',
      category: 'Utility',
      language: 'pt_BR',
      body_text: 'Oi {{1}}, confirmamos sua reunião para {{2}}. Caso precise reagendar, responda esta mensagem.',
      status: 'APPROVED',
      quality_score: 'GREEN',
      created_at: iso(60 * 24 * 3),
    },
  ];

  tables.quick_replies = [
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      user_id: adminUserId,
      title: 'Saudação inicial',
      kind: 'text',
      content_text: 'Olá! Tudo bem? Sou da equipe de atendimento e já vou ajudar você.',
      interactive_payload: null,
      created_at: iso(60 * 24 * 3),
      updated_at: iso(60 * 24 * 3),
    },
    {
      id: crypto.randomUUID(),
      account_id: accountId,
      user_id: adminUserId,
      title: 'Horário de atendimento',
      kind: 'text',
      content_text: 'Nosso horário de atendimento é de segunda a sexta, das 09h às 18h (horário de Brasília).',
      interactive_payload: null,
      created_at: iso(60 * 24 * 3),
      updated_at: iso(60 * 24 * 3),
    },
  ];

  tables.automations = [
    {
      id: auto1,
      account_id: accountId,
      user_id: adminUserId,
      name: 'Boas-vindas para novos contatos',
      description: 'Envia uma mensagem automática na primeira mensagem recebida.',
      trigger_type: 'first_inbound_message',
      trigger_config: {},
      is_active: false,
      execution_count: 0,
      last_executed_at: null,
      created_at: iso(60 * 24 * 2),
      updated_at: iso(60 * 24 * 2),
    },
  ];

  tables.automation_steps = [
    {
      id: crypto.randomUUID(),
      automation_id: auto1,
      parent_step_id: null,
      branch: null,
      step_type: 'send_message',
      step_config: {
        text: 'Olá! Obrigado pelo contato. Um de nossos consultores responderá em instantes.',
      },
      position: 0,
      created_at: iso(60 * 24 * 2),
    },
  ];

  return {
    version: 1,
    users: [
      {
        id: adminUserId,
        email: DEFAULT_LOCAL_ADMIN.email,
        password_hash: hashPassword(DEFAULT_LOCAL_ADMIN.password),
        full_name: DEFAULT_LOCAL_ADMIN.fullName,
        created_at: iso(60 * 24 * 7),
        updated_at: iso(10),
      },
    ],
    tables,
    storage: {},
  };
}

declare global {
  var __wacrmLocalDb: LocalDatabase | undefined;
}

export function getLocalDb(): LocalDatabase {
  if (globalThis.__wacrmLocalDb) {
    return globalThis.__wacrmLocalDb;
  }

  try {
    if (fs.existsSync(DB_FILE_PATH)) {
      const raw = fs.readFileSync(DB_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as LocalDatabase;
      if (parsed && parsed.tables && Array.isArray(parsed.users)) {
        for (const name of KNOWN_TABLES) {
          if (!Array.isArray(parsed.tables[name])) {
            parsed.tables[name] = [];
          }
        }
        if (!parsed.storage) parsed.storage = {};
        globalThis.__wacrmLocalDb = parsed;
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[local-backend] Failed to read local DB file, re-seeding:', err);
  }

  const seeded = createSeedDatabase();
  globalThis.__wacrmLocalDb = seeded;
  saveLocalDb();
  return seeded;
}

export function saveLocalDb(): void {
  if (!globalThis.__wacrmLocalDb) return;
  try {
    fs.writeFileSync(
      DB_FILE_PATH,
      JSON.stringify(globalThis.__wacrmLocalDb, null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn('[local-backend] Failed to persist local DB to disk:', err);
  }
}

export function getTable(table: string): Row[] {
  const db = getLocalDb();
  if (!Array.isArray(db.tables[table])) {
    db.tables[table] = [];
  }
  return db.tables[table];
}

export function toSupabaseUser(user: LocalUserRecord) {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: user.created_at,
    confirmed_at: user.created_at,
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: user.full_name },
    identities: [],
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function findLocalUserById(userId: string): LocalUserRecord | undefined {
  return getLocalDb().users.find((u) => u.id === userId);
}

export function findLocalUserByEmail(email: string): LocalUserRecord | undefined {
  const normalized = email.trim().toLowerCase();
  return getLocalDb().users.find((u) => u.email.toLowerCase() === normalized);
}

export function registerLocalUser(input: {
  email: string;
  password: string;
  fullName?: string;
}): { user?: LocalUserRecord; error?: string } {
  const db = getLocalDb();
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return { error: 'Informe um e-mail válido.' };
  }
  if (!input.password || input.password.length < 6) {
    return { error: 'A senha deve ter pelo menos 6 caracteres.' };
  }
  if (db.users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
    return { error: 'Já existe uma conta cadastrada com este e-mail.' };
  }

  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const fullName = (input.fullName || normalizedEmail.split('@')[0]).trim();

  const user: LocalUserRecord = {
    id: userId,
    email: normalizedEmail,
    password_hash: hashPassword(input.password),
    full_name: fullName,
    created_at: now,
    updated_at: now,
  };

  db.users.push(user);

  getTable('accounts').push({
    id: accountId,
    name: `Workspace de ${fullName}`,
    owner_user_id: userId,
    default_currency: 'BRL',
    reply_target_minutes: 15,
    created_at: now,
    updated_at: now,
  });

  getTable('profiles').push({
    id: crypto.randomUUID(),
    user_id: userId,
    full_name: fullName,
    email: normalizedEmail,
    avatar_url: null,
    role: 'owner',
    beta_features: [],
    account_id: accountId,
    account_role: 'owner',
    created_at: now,
    updated_at: now,
  });

  getTable('member_presence').push({
    account_id: accountId,
    user_id: userId,
    status: 'online',
    last_seen_at: now,
    updated_at: now,
  });

  // Seed a clean default sales pipeline for the new workspace
  const pipelineId = crypto.randomUUID();
  getTable('pipelines').push({
    id: pipelineId,
    account_id: accountId,
    user_id: userId,
    name: 'Funil de Vendas',
    created_at: now,
  });

  const defaultStages = [
    { name: 'Novo Lead', color: '#3b82f6', position: 0 },
    { name: 'Qualificado', color: '#eab308', position: 1 },
    { name: 'Proposta Enviada', color: '#f97316', position: 2 },
    { name: 'Negociação', color: '#8b5cf6', position: 3 },
    { name: 'Ganho', color: '#22c55e', position: 4 },
  ];
  for (const st of defaultStages) {
    getTable('pipeline_stages').push({
      id: crypto.randomUUID(),
      pipeline_id: pipelineId,
      name: st.name,
      color: st.color,
      position: st.position,
      created_at: now,
    });
  }

  saveLocalDb();
  return { user };
}

export function authenticateLocalUser(input: {
  email: string;
  password: string;
}): { user?: LocalUserRecord; error?: string } {
  const user = findLocalUserByEmail(input.email);
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    return { error: 'E-mail ou senha inválidos.' };
  }
  return { user };
}

export function updateLocalUser(
  userId: string,
  updates: { password?: string; email?: string; data?: Record<string, unknown> }
): { user?: LocalUserRecord; error?: string } {
  const db = getLocalDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return { error: 'Usuário não encontrado.' };

  if (updates.email) {
    const normalized = updates.email.trim().toLowerCase();
    if (
      db.users.some(
        (u) => u.id !== userId && u.email.toLowerCase() === normalized
      )
    ) {
      return { error: 'Este e-mail já está em uso por outra conta.' };
    }
    user.email = normalized;
    const prof = getTable('profiles').find((p) => p.user_id === userId);
    if (prof) prof.email = normalized;
  }

  if (updates.password) {
    if (updates.password.length < 6) {
      return { error: 'A senha deve ter pelo menos 6 caracteres.' };
    }
    user.password_hash = hashPassword(updates.password);
  }

  if (updates.data && typeof updates.data.full_name === 'string') {
    user.full_name = updates.data.full_name;
    const prof = getTable('profiles').find((p) => p.user_id === userId);
    if (prof) prof.full_name = updates.data.full_name;
  }

  user.updated_at = new Date().toISOString();
  saveLocalDb();
  return { user };
}

export function storeLocalFile(
  bucket: string,
  filePath: string,
  dataUrl: string,
  contentType: string
): string {
  const db = getLocalDb();
  if (!db.storage[bucket]) db.storage[bucket] = {};
  db.storage[bucket][filePath] = { dataUrl, contentType };
  saveLocalDb();
  return dataUrl;
}

export function getLocalFilePublicUrl(bucket: string, filePath: string): string {
  const db = getLocalDb();
  return db.storage[bucket]?.[filePath]?.dataUrl ?? `/api/local-backend?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(filePath)}`;
}

export function removeLocalFiles(bucket: string, paths: string[]): void {
  const db = getLocalDb();
  if (!db.storage[bucket]) return;
  for (const p of paths) {
    delete db.storage[bucket][p];
  }
  saveLocalDb();
}
