import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { AI_PROVIDER_DEFAULT_MODEL, buildSystemPrompt } from '@/lib/ai/defaults'
import type { AiConfig } from '@/lib/ai/types'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { N8nActionType } from './events'

export class N8nActionError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'N8nActionError'
    this.status = status
  }
}

export interface N8nActionPayload {
  action: N8nActionType
  phone?: string
  contact_id?: string
  conversation_id?: string
  name?: string
  email?: string
  company?: string
  message?: string
  tag_id?: string
  tag_name?: string
  deal_id?: string
  pipeline_id?: string
  stage_id?: string
  stage_name?: string
  title?: string
  value?: number
  prompt?: string
  use_knowledge_base?: boolean
  send_whatsapp?: boolean
}

async function resolveAccountOwnerUserId(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle()
  if (account?.owner_user_id) return String(account.owner_user_id)

  const { data: profile } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .limit(1)
    .maybeSingle()
  if (profile?.user_id) return String(profile.user_id)
  throw new N8nActionError('Conta sem usuário proprietário vinculado.', 500)
}

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  input: { contact_id?: string; phone?: string; name?: string; email?: string; company?: string },
): Promise<{ id: string; name: string | null; phone: string }> {
  if (input.contact_id) {
    const { data } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('id', input.contact_id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!data) throw new N8nActionError('Contato não encontrado nesta conta.', 404)
    return data as { id: string; name: string | null; phone: string }
  }

  const rawPhone = (input.phone ?? '').trim()
  if (!rawPhone) {
    throw new N8nActionError('Informe "phone" ou "contact_id".', 400)
  }
  const normalized = normalizePhone(rawPhone)
  if (!normalized) {
    throw new N8nActionError('Número de telefone inválido.', 400)
  }

  const { data: existing } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .eq('phone_normalized', normalized)
    .maybeSingle()

  if (existing) {
    const updates: Record<string, unknown> = {}
    if (input.name && input.name.trim()) updates.name = input.name.trim()
    if (input.email && input.email.trim()) updates.email = input.email.trim()
    if (input.company && input.company.trim()) updates.company = input.company.trim()
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString()
      await db
        .from('contacts')
        .update(updates)
        .eq('id', existing.id)
        .eq('account_id', accountId)
    }
    return {
      id: String(existing.id),
      name: (updates.name as string | undefined) ?? (existing.name as string | null),
      phone: String(existing.phone),
    }
  }

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      name: input.name?.trim() || rawPhone,
      phone: rawPhone,
      phone_normalized: normalized,
      email: input.email?.trim() || null,
      company: input.company?.trim() || null,
    })
    .select('id, name, phone')
    .single()

  if (error || !created) {
    throw new N8nActionError(error?.message ?? 'Falha ao criar contato.', 500)
  }
  return created as { id: string; name: string | null; phone: string }
}

async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
  explicitConversationId?: string,
): Promise<string> {
  if (explicitConversationId) {
    const { data } = await db
      .from('conversations')
      .select('id')
      .eq('id', explicitConversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!data) throw new N8nActionError('Conversa não encontrada nesta conta.', 404)
    return String(data.id)
  }

  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing?.id) return String(existing.id)

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      status: 'open',
    })
    .select('id')
    .single()

  if (error || !created?.id) {
    throw new N8nActionError(error?.message ?? 'Falha ao criar conversa.', 500)
  }
  return String(created.id)
}

async function resolveAccountAiConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<AiConfig> {
  const saved = await loadAiConfig(db, accountId, { requireActive: false })
  if (saved) return saved

  const serverGeminiKey = process.env.GEMINI_API_KEY?.trim()
  if (serverGeminiKey) {
    return {
      provider: 'gemini',
      model: AI_PROVIDER_DEFAULT_MODEL.gemini,
      baseUrl: null,
      apiKey: serverGeminiKey,
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 5,
      handoffAgentId: null,
      embeddingsApiKey: null,
    }
  }

  throw new N8nActionError(
    'Nenhum provedor de IA configurado na conta (nem GEMINI_API_KEY no servidor). Configure o Google Gemini em Agente de IA.',
    400,
  )
}

export async function executeN8nAction(
  db: SupabaseClient,
  accountId: string,
  payload: N8nActionPayload,
): Promise<Record<string, unknown>> {
  const ownerUserId = await resolveAccountOwnerUserId(db, accountId)

  switch (payload.action) {
    case 'upsert_contact': {
      const contact = await findOrCreateContact(db, accountId, ownerUserId, payload)
      return { ok: true, action: 'upsert_contact', contact }
    }

    case 'send_whatsapp': {
      const text = (payload.message ?? '').trim()
      if (!text) throw new N8nActionError('O campo "message" é obrigatório.', 400)
      const contact = await findOrCreateContact(db, accountId, ownerUserId, payload)
      const conversationId = await findOrCreateConversation(
        db,
        accountId,
        ownerUserId,
        contact.id,
        payload.conversation_id,
      )
      const result = await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'text',
        contentText: text,
        senderId: ownerUserId,
      })
      return {
        ok: true,
        action: 'send_whatsapp',
        contact_id: contact.id,
        conversation_id: conversationId,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      }
    }

    case 'add_tag': {
      const contact = await findOrCreateContact(db, accountId, ownerUserId, payload)
      let tagId = payload.tag_id?.trim()
      if (!tagId && payload.tag_name?.trim()) {
        const tagName = payload.tag_name.trim()
        const { data: existingTag } = await db
          .from('tags')
          .select('id')
          .eq('account_id', accountId)
          .ilike('name', tagName)
          .maybeSingle()
        if (existingTag?.id) {
          tagId = String(existingTag.id)
        } else {
          const { data: newTag, error } = await db
            .from('tags')
            .insert({
              account_id: accountId,
              user_id: ownerUserId,
              name: tagName,
              color: '#3b82f6',
            })
            .select('id')
            .single()
          if (error || !newTag?.id) {
            throw new N8nActionError(error?.message ?? 'Falha ao criar tag.', 500)
          }
          tagId = String(newTag.id)
        }
      }
      if (!tagId) throw new N8nActionError('Informe "tag_id" ou "tag_name".', 400)

      const added = await addContactTagIfAbsent(db, {
        accountId,
        contactId: contact.id,
        tagId,
      })
      return { ok: true, action: 'add_tag', contact_id: contact.id, tag_id: tagId, added }
    }

    case 'create_deal': {
      const title = (payload.title ?? '').trim()
      if (!title) throw new N8nActionError('O campo "title" é obrigatório.', 400)

      const contact =
        payload.contact_id || payload.phone
          ? await findOrCreateContact(db, accountId, ownerUserId, payload)
          : null

      let pipelineId = payload.pipeline_id?.trim()
      if (!pipelineId) {
        const { data: firstPipe } = await db
          .from('pipelines')
          .select('id')
          .eq('account_id', accountId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        pipelineId = firstPipe?.id ? String(firstPipe.id) : undefined
      }
      if (!pipelineId) throw new N8nActionError('Nenhum funil encontrado nesta conta.', 404)

      let stageId = payload.stage_id?.trim()
      if (!stageId) {
        const { data: firstStage } = await db
          .from('pipeline_stages')
          .select('id')
          .eq('pipeline_id', pipelineId)
          .order('position', { ascending: true })
          .limit(1)
          .maybeSingle()
        stageId = firstStage?.id ? String(firstStage.id) : undefined
      }
      if (!stageId) throw new N8nActionError('Nenhuma etapa encontrada para este funil.', 404)

      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', accountId)
        .maybeSingle()

      const numericValue =
        typeof payload.value === 'number' && Number.isFinite(payload.value)
          ? payload.value
          : 0

      const { data: deal, error } = await db
        .from('deals')
        .insert({
          account_id: accountId,
          user_id: ownerUserId,
          pipeline_id: pipelineId,
          stage_id: stageId,
          contact_id: contact?.id ?? null,
          title,
          value: numericValue,
          currency: (acct?.default_currency as string | undefined) ?? 'BRL',
          status: 'open',
        })
        .select('id, title, value, pipeline_id, stage_id, status')
        .single()

      if (error || !deal) {
        throw new N8nActionError(error?.message ?? 'Falha ao criar negócio.', 500)
      }
      return { ok: true, action: 'create_deal', deal }
    }

    case 'move_deal_stage': {
      const dealId = payload.deal_id?.trim()
      if (!dealId) throw new N8nActionError('O campo "deal_id" é obrigatório.', 400)

      const { data: deal } = await db
        .from('deals')
        .select('id, pipeline_id')
        .eq('id', dealId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!deal) throw new N8nActionError('Negócio não encontrado nesta conta.', 404)

      let stageId = payload.stage_id?.trim()
      if (!stageId && payload.stage_name?.trim()) {
        const { data: stage } = await db
          .from('pipeline_stages')
          .select('id')
          .eq('pipeline_id', deal.pipeline_id)
          .ilike('name', payload.stage_name.trim())
          .maybeSingle()
        stageId = stage?.id ? String(stage.id) : undefined
      }
      if (!stageId) throw new N8nActionError('Informe "stage_id" ou "stage_name" válido.', 400)

      const { error } = await db
        .from('deals')
        .update({ stage_id: stageId, updated_at: new Date().toISOString() })
        .eq('id', dealId)
        .eq('account_id', accountId)

      if (error) throw new N8nActionError(error.message, 500)
      return { ok: true, action: 'move_deal_stage', deal_id: dealId, stage_id: stageId }
    }

    case 'run_ai_reply': {
      const userMessage = (payload.message ?? '').trim()
      if (!userMessage) {
        throw new N8nActionError('O campo "message" é obrigatório para run_ai_reply.', 400)
      }

      const aiConfig = await resolveAccountAiConfig(db, accountId)
      const knowledge = payload.use_knowledge_base
        ? await retrieveKnowledge(db, accountId, aiConfig, userMessage, 5)
        : []

      const combinedPrompt = [aiConfig.systemPrompt, payload.prompt]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join('\n\n')

      const systemPrompt = buildSystemPrompt({
        userPrompt: combinedPrompt || null,
        mode: 'draft',
        knowledge,
      })

      const generated = await generateReply({
        config: aiConfig,
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      })

      let delivery: Record<string, unknown> | undefined
      if (payload.send_whatsapp && generated.text) {
        const contact = await findOrCreateContact(db, accountId, ownerUserId, payload)
        const conversationId = await findOrCreateConversation(
          db,
          accountId,
          ownerUserId,
          contact.id,
          payload.conversation_id,
        )
        const sent = await sendMessageToConversation(db, accountId, {
          conversationId,
          messageType: 'text',
          contentText: generated.text,
          senderId: ownerUserId,
        })
        delivery = {
          contact_id: contact.id,
          conversation_id: conversationId,
          message_id: sent.messageId,
          whatsapp_message_id: sent.whatsappMessageId,
        }
      }

      return {
        ok: true,
        action: 'run_ai_reply',
        provider: aiConfig.provider,
        model: aiConfig.model,
        reply: generated.text,
        handoff: generated.handoff,
        ...(delivery ? { delivery } : {}),
      }
    }

    default:
      throw new N8nActionError(`Ação não suportada: ${String(payload.action)}`, 400)
  }
}
