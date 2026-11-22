import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiAgentStepConfig } from '@/types'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { AI_PROVIDER_DEFAULT_MODEL, buildSystemPrompt } from '@/lib/ai/defaults'
import type { AiConfig } from '@/lib/ai/types'

export interface AiAgentExecutionResult {
  replyText: string
  provider: string
  model: string
  handoff: boolean
}

/**
 * Execute the native `ai_agent` automation step using the account's
 * configured AI provider (Google Gemini, OpenAI, Anthropic, or
 * OpenAI-compatible) with automatic fallback to the server-side
 * `GEMINI_API_KEY` when available.
 */
export async function executeAiAgentStep(args: {
  db: SupabaseClient
  accountId: string
  config: AiAgentStepConfig
  promptText: string
  userInputText: string
}): Promise<AiAgentExecutionResult> {
  const { db, accountId, config, promptText, userInputText } = args

  let aiConfig: AiConfig | null = await loadAiConfig(db, accountId, {
    requireActive: false,
  })

  if (!aiConfig) {
    const serverGeminiKey = process.env.GEMINI_API_KEY?.trim()
    if (!serverGeminiKey) {
      throw new Error(
        'ai_agent: nenhum provedor de IA configurado na conta (nem GEMINI_API_KEY no servidor)',
      )
    }
    aiConfig = {
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

  const query = userInputText.trim() || promptText.trim()
  const knowledge = config.use_knowledge_base
    ? await retrieveKnowledge(db, accountId, aiConfig, query, 5)
    : []

  const combinedInstructions = [aiConfig.systemPrompt, promptText]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join('\n\n')

  const systemPrompt = buildSystemPrompt({
    userPrompt: combinedInstructions || null,
    mode: 'draft',
    knowledge,
  })

  const generated = await generateReply({
    config: aiConfig,
    systemPrompt,
    messages: [{ role: 'user', content: query }],
  })

  return {
    replyText: generated.text,
    provider: aiConfig.provider,
    model: aiConfig.model,
    handoff: generated.handoff,
  }
}
