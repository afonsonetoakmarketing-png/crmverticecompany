'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  CheckCircle2,
  CloudUpload,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  AlertCircle,
  Clock,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsPanelHead } from './settings-panel-head'
import { SettingsChip, StatusDot } from './settings-chip'
import { useAuth } from '@/hooks/use-auth'
import {
  buildN8nTemplates,
  type N8nTemplateCategory,
} from '@/lib/n8n/templates'
import { cn } from '@/lib/utils'

interface N8nIntegrationState {
  configured: boolean
  is_active: boolean
  instance_url: string
  webhook_url: string
  auth_header_name: string
  has_auth_header_value: boolean
  subscribed_events: string[]
  has_inbound_token: boolean
  inbound_token_prefix: string | null
  inbound_token: string | null
  last_outbound_at: string | null
  last_outbound_status: number | null
  last_outbound_error: string | null
  last_inbound_at: string | null
}

interface DeployReadinessData {
  runtime: {
    mode: 'local-hybrid' | 'supabase'
    isVercel: boolean
    siteUrl: string | null
  }
  workspaceStatus: {
    aiConfigured: boolean
    aiProvider: string | null
    whatsappMode: string | null
    whatsappConfigured: boolean
    n8nConfigured: boolean
    n8nActive: boolean
  }
  checks: {
    key: string
    category: 'core' | 'ai' | 'whatsapp' | 'cron'
    requiredForVercel: boolean
    configured: boolean
    hint: string
  }[]
  cronEndpoints: {
    path: string
    schedule: string
    authHeader: string
  }[]
}

type HubTab = 'connection' | 'templates' | 'deploy'

const EVENT_OPTIONS: { id: string; label: string; desc: string }[] = [
  {
    id: 'message.received',
    label: 'Nova mensagem recebida',
    desc: 'Dispara quando um cliente envia mensagem no WhatsApp (Oficial ou QR Code)',
  },
  {
    id: 'contact.created',
    label: 'Novo contato criado',
    desc: 'Dispara quando um novo lead entra no CRM',
  },
  {
    id: 'deal.created',
    label: 'Negócio criado no funil',
    desc: 'Dispara ao abrir uma nova oportunidade de venda',
  },
  {
    id: 'deal.stage_changed',
    label: 'Negócio mudou de etapa',
    desc: 'Dispara ao mover cards entre estágios do pipeline',
  },
  {
    id: 'tag.added',
    label: 'Tag aplicada ao contato',
    desc: 'Ideal para disparar sequências de qualificação no n8n',
  },
  {
    id: 'ai.handoff',
    label: 'Transferência de IA para humano',
    desc: 'Notifica equipe ou registra ticket externo quando a IA solicita atendimento humano',
  },
]

const INBOUND_ACTIONS_DOCS: { action: string; summary: string; sample: Record<string, unknown> }[] = [
  {
    action: 'send_whatsapp',
    summary: 'Envia texto no WhatsApp (API Oficial ou QR Code ativo na conta)',
    sample: {
      action: 'send_whatsapp',
      phone: '+5511999999999',
      message: 'Olá! Sua solicitação foi atualizada.',
    },
  },
  {
    action: 'run_ai_reply',
    summary: 'Gera resposta com Google Gemini (ou LLM da conta) e opcionalmente envia no WhatsApp',
    sample: {
      action: 'run_ai_reply',
      phone: '+5511999999999',
      message: 'Quais os horários de atendimento?',
      use_knowledge_base: true,
      send_whatsapp: true,
    },
  },
  {
    action: 'upsert_contact',
    summary: 'Cria ou atualiza contato pelo telefone normalizado',
    sample: {
      action: 'upsert_contact',
      phone: '+5511999999999',
      name: 'Maria Oliveira',
      email: 'maria@empresa.com',
      company: 'Studio Solar',
    },
  },
  {
    action: 'add_tag',
    summary: 'Aplica uma tag existente (ou cria automaticamente por nome)',
    sample: {
      action: 'add_tag',
      phone: '+5511999999999',
      tag_name: 'Lead Qualificado n8n',
    },
  },
  {
    action: 'create_deal',
    summary: 'Abre um novo negócio no funil padrão (ou pipeline/etapa informados)',
    sample: {
      action: 'create_deal',
      phone: '+5511999999999',
      title: 'Proposta Plano Enterprise',
      value: 2500,
    },
  },
  {
    action: 'move_deal_stage',
    summary: 'Move um negócio existente para outra etapa por ID ou nome',
    sample: {
      action: 'move_deal_stage',
      deal_id: 'UUID-DO-NEGOCIO',
      stage_name: 'Proposta Enviada',
    },
  },
]

const VERCEL_ENV_TEMPLATE = `# Variáveis obrigatórias para produção na Vercel
NEXT_PUBLIC_SUPABASE_URL=https://SEU-PROJETO.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-chave-anon-supabase
SUPABASE_SERVICE_ROLE_KEY=sua-chave-service-role-supabase
ENCRYPTION_KEY=gere-64-caracteres-hex-aleatorios
NEXT_PUBLIC_SITE_URL=https://seu-crm.vercel.app
NEXT_PUBLIC_APP_LOCALE=pt
CRON_SECRET=gere-um-segredo-forte-para-vercel-cron
AUTOMATION_CRON_SECRET=mesmo-segredo-ou-outro-para-pinger-externo

# Opcionais (IA e WhatsApp Oficial)
GEMINI_API_KEY=sua-chave-google-ai-studio
META_APP_SECRET=seu-app-secret-da-meta`

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

export function N8nHubPanel() {
  const { accountRole } = useAuth()
  const isAdmin = accountRole === 'owner' || accountRole === 'admin'

  const [activeTab, setActiveTab] = useState<HubTab>('connection')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [rotating, setRotating] = useState(false)

  const [integration, setIntegration] = useState<N8nIntegrationState | null>(null)
  const [isActive, setIsActive] = useState(false)
  const [instanceUrl, setInstanceUrl] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [authHeaderName, setAuthHeaderName] = useState('x-n8n-secret')
  const [authHeaderValue, setAuthHeaderValue] = useState('')
  const [subscribedEvents, setSubscribedEvents] = useState<string[]>(
    EVENT_OPTIONS.map((e) => e.id),
  )
  const [showToken, setShowToken] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selectedActionDoc, setSelectedActionDoc] = useState<string>('send_whatsapp')
  const [templateFilter, setTemplateFilter] = useState<'all' | N8nTemplateCategory>('all')

  const [readiness, setReadiness] = useState<DeployReadinessData | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(false)

  const origin = useMemo(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin
    }
    return readiness?.runtime.siteUrl || 'https://seu-crm.vercel.app'
  }, [readiness?.runtime.siteUrl])

  const inboundWebhookUrl = `${origin}/api/integrations/n8n/webhook`
  const templates = useMemo(() => buildN8nTemplates(origin), [origin])
  const filteredTemplates = useMemo(
    () =>
      templateFilter === 'all'
        ? templates
        : templates.filter((tpl) => tpl.category === templateFilter),
    [templates, templateFilter],
  )

  const loadIntegration = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/integrations/n8n', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar integração n8n')
      const item = data.integration as N8nIntegrationState
      setIntegration(item)
      setIsActive(item.is_active)
      setInstanceUrl(item.instance_url)
      setWebhookUrl(item.webhook_url)
      setAuthHeaderName(item.auth_header_name || 'x-n8n-secret')
      setSubscribedEvents(
        item.subscribed_events.length > 0
          ? item.subscribed_events
          : EVENT_OPTIONS.map((e) => e.id),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao carregar Hub n8n')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadReadiness = useCallback(async () => {
    if (!isAdmin) return
    setReadinessLoading(true)
    try {
      const res = await fetch('/api/deploy/readiness', { cache: 'no-store' })
      const data = await res.json()
      if (res.ok) setReadiness(data as DeployReadinessData)
    } catch {
      // non-fatal
    } finally {
      setReadinessLoading(false)
    }
  }, [isAdmin])

  useEffect(() => {
    void loadIntegration()
  }, [loadIntegration])

  useEffect(() => {
    if (activeTab === 'deploy' && !readiness && !readinessLoading) {
      void loadReadiness()
    }
  }, [activeTab, readiness, readinessLoading, loadReadiness])

  const copyText = async (id: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      toast.success(`${label} copiado para a área de transferência`)
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000)
    } catch {
      toast.error('Não foi possível copiar automaticamente')
    }
  }

  const handleSave = async () => {
    if (!isAdmin) {
      toast.error('Apenas administradores podem alterar a integração n8n.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/n8n', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_active: isActive,
          instance_url: instanceUrl,
          webhook_url: webhookUrl,
          auth_header_name: authHeaderName,
          ...(authHeaderValue.trim() ? { auth_header_value: authHeaderValue.trim() } : {}),
          subscribed_events: subscribedEvents,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar configuração n8n')
      setIntegration(data.integration as N8nIntegrationState)
      setAuthHeaderValue('')
      toast.success('Configuração do Hub n8n salva com sucesso')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar')
    } finally {
      setSaving(false)
    }
  }

  const handleRotateToken = async () => {
    if (!isAdmin) return
    setRotating(true)
    try {
      const res = await fetch('/api/integrations/n8n', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro ao gerar token')
      setIntegration(data.integration as N8nIntegrationState)
      setShowToken(true)
      toast.success('Novo token de entrada do n8n gerado e salvo')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao gerar token')
    } finally {
      setRotating(false)
    }
  }

  const handleTestOutbound = async () => {
    if (!isAdmin) return
    setTesting(true)
    try {
      const res = await fetch('/api/integrations/n8n/test', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        toast.error(data.error || 'O n8n retornou erro no teste')
      } else {
        toast.success(`Webhook do n8n respondeu HTTP ${data.status} em ${data.latencyMs}ms`)
      }
      await loadIntegration()
    } catch {
      toast.error('Erro de rede ao testar o webhook do n8n')
    } finally {
      setTesting(false)
    }
  }

  const toggleEvent = (eventId: string) => {
    setSubscribedEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId],
    )
  }

  const downloadTemplate = (filename: string, workflow: Record<string, unknown>) => {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.success(`Template ${filename} baixado`)
  }

  const activeDoc =
    INBOUND_ACTIONS_DOCS.find((d) => d.action === selectedActionDoc) ?? INBOUND_ACTIONS_DOCS[0]

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-5">
      <SettingsPanelHead
        title="Integrações, Hub n8n & Deploy Vercel"
        description="Conecte seu CRM na Vercel ao repositório n8n.akm (VPS, Railway ou Cloud), importe fluxos JSON prontos e valide todas as variáveis para deploy."
        action={
          <SettingsChip variant={isActive && webhookUrl ? 'ok' : 'muted'}>
            <StatusDot tone={isActive && webhookUrl ? 'ok' : 'muted'} />
            {isActive && webhookUrl ? 'Hub n8n ativo' : 'Pronto para conectar'}
          </SettingsChip>
        }
      />

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'connection' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('connection')}
          className="gap-1.5 whitespace-nowrap"
        >
          <Workflow className="size-3.5" />
          Conexão n8n
        </Button>
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'templates' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('templates')}
          className="gap-1.5 whitespace-nowrap"
        >
          <Code2 className="size-3.5" />
          Templates JSON ({templates.length})
        </Button>
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'deploy' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('deploy')}
          className="gap-1.5 whitespace-nowrap"
        >
          <CloudUpload className="size-3.5" />
          GitHub &amp; Vercel
        </Button>
      </div>

      {/* TAB 1: CONEXÃO N8N */}
      {activeTab === 'connection' && (
        <div className="space-y-5">
          {loading ? (
            <div className="space-y-4">
              <div className="h-44 animate-pulse rounded-xl border border-border bg-card" />
              <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
            </div>
          ) : (
            <>
              {/* Inbound n8n -> CRM */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Terminal className="size-4 text-primary" />
                      1. Webhook de Entrada (n8n → CRM)
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Use este endpoint no nó <strong>HTTP Request</strong> do seu n8n.akm para
                      enviar WhatsApp, acionar o Google Gemini, criar contatos, aplicar tags ou
                      movimentar negócios.
                    </p>
                  </div>
                  {integration?.last_inbound_at && (
                    <span className="text-xs font-mono tabular-nums text-muted-foreground">
                      Último comando: {formatTimestamp(integration.last_inbound_at)}
                    </span>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      URL do Webhook de Ações (POST)
                    </label>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={inboundWebhookUrl}
                        className="font-mono text-xs bg-muted"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => copyText('inbound-url', inboundWebhookUrl, 'URL de entrada')}
                        title="Copiar URL"
                      >
                        {copiedId === 'inbound-url' ? (
                          <Check className="size-4 text-emerald-500" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Token de Autenticação (Header Authorization: Bearer)
                    </label>
                    {integration?.has_inbound_token ? (
                      <div className="flex gap-2">
                        <Input
                          readOnly
                          value={
                            showToken && integration.inbound_token
                              ? integration.inbound_token
                              : integration.inbound_token_prefix || 'n8n_••••••••••••'
                          }
                          className="font-mono text-xs bg-muted"
                        />
                        {integration.inbound_token && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => setShowToken((v) => !v)}
                              title={showToken ? 'Ocultar token' : 'Mostrar token'}
                            >
                              {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() =>
                                copyText('inbound-token', integration.inbound_token!, 'Token n8n')
                              }
                              title="Copiar token"
                            >
                              {copiedId === 'inbound-token' ? (
                                <Check className="size-4 text-emerald-500" />
                              ) : (
                                <Copy className="size-4" />
                              )}
                            </Button>
                          </>
                        )}
                        {isAdmin && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={rotating}
                            onClick={handleRotateToken}
                            className="shrink-0 whitespace-nowrap gap-1.5"
                          >
                            {rotating ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="size-3.5" />
                            )}
                            Rotacionar
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2">
                        <span className="text-xs text-muted-foreground">
                          Nenhum token gerado ainda para esta conta.
                        </span>
                        {isAdmin && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={rotating}
                            onClick={handleRotateToken}
                            className="shrink-0 whitespace-nowrap gap-1.5"
                          >
                            {rotating ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <KeyRound className="size-3.5" />
                            )}
                            Gerar token
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Supported Actions Reference */}
                <div className="border-t border-border pt-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      Ações aceitas pelo CRM (envie no corpo JSON):
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {INBOUND_ACTIONS_DOCS.map((doc) => (
                        <button
                          key={doc.action}
                          type="button"
                          onClick={() => setSelectedActionDoc(doc.action)}
                          className={cn(
                            'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                            selectedActionDoc === doc.action
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {doc.action}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/50 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs text-muted-foreground">{activeDoc.summary}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() =>
                          copyText(
                            `doc-${activeDoc.action}`,
                            JSON.stringify(activeDoc.sample, null, 2),
                            `JSON ${activeDoc.action}`,
                          )
                        }
                      >
                        {copiedId === `doc-${activeDoc.action}` ? (
                          <Check className="size-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        Copiar payload
                      </Button>
                    </div>
                    <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground">
                      {JSON.stringify(activeDoc.sample, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>

              {/* Outbound CRM -> n8n */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Send className="size-4 text-primary" />
                      2. Disparo de Eventos (CRM → n8n)
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Envie eventos do CRM em tempo real para um nó <strong>Webhook</strong> da sua
                      instância n8n.akm hospedada em VPS, Railway ou Cloud.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Switch
                      checked={isActive}
                      onCheckedChange={setIsActive}
                      disabled={!isAdmin}
                    />
                    Ativar disparos
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      URL do Webhook no n8n (Production URL)
                    </label>
                    <Input
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="https://n8n.seudominio.com/webhook/crm-whatsapp-inbound"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      URL base do seu n8n.akm (opcional — atalho rápido)
                    </label>
                    <div className="flex gap-2">
                      <Input
                        value={instanceUrl}
                        onChange={(e) => setInstanceUrl(e.target.value)}
                        disabled={!isAdmin}
                        placeholder="https://n8n.seudominio.com"
                        className="font-mono text-xs"
                      />
                      {instanceUrl && /^https?:\/\//.test(instanceUrl) && (
                        <a
                          href={instanceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground"
                          title="Abrir painel do n8n"
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Nome do Header de Autenticação
                    </label>
                    <Input
                      value={authHeaderName}
                      onChange={(e) => setAuthHeaderName(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="x-n8n-secret"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Segredo / API Key do n8n{' '}
                      {integration?.has_auth_header_value ? '(já salvo e criptografado)' : '(opcional)'}
                    </label>
                    <Input
                      type="password"
                      value={authHeaderValue}
                      onChange={(e) => setAuthHeaderValue(e.target.value)}
                      disabled={!isAdmin}
                      placeholder={
                        integration?.has_auth_header_value
                          ? 'Deixe em branco para manter o segredo atual'
                          : 'Cole o segredo configurado no Header Auth do n8n'
                      }
                      className="font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <span className="block text-xs font-medium text-muted-foreground">
                    Eventos enviados para o n8n:
                  </span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {EVENT_OPTIONS.map((evt) => {
                      const checked = subscribedEvents.includes(evt.id)
                      return (
                        <label
                          key={evt.id}
                          className={cn(
                            'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer',
                            checked
                              ? 'border-primary/40 bg-primary/5'
                              : 'border-border bg-background hover:bg-muted/40',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!isAdmin}
                            onChange={() => toggleEvent(evt.id)}
                            className="mt-0.5 h-3.5 w-3.5 accent-primary"
                          />
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-foreground">
                              {evt.label}
                            </span>
                            <span className="block text-[11px] text-muted-foreground">
                              {evt.desc}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                {/* Delivery status + actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <div className="text-xs text-muted-foreground font-mono tabular-nums">
                    {integration?.last_outbound_at ? (
                      <span className="flex items-center gap-1.5">
                        <StatusDot
                          tone={
                            integration.last_outbound_status &&
                            integration.last_outbound_status >= 200 &&
                            integration.last_outbound_status < 300
                              ? 'ok'
                              : 'muted'
                          }
                        />
                        Último envio: {formatTimestamp(integration.last_outbound_at)}
                        {integration.last_outbound_status
                          ? ` (HTTP ${integration.last_outbound_status})`
                          : ''}
                        {integration.last_outbound_error
                          ? ` — ${integration.last_outbound_error}`
                          : ''}
                      </span>
                    ) : (
                      <span>Nenhum envio de teste registrado ainda.</span>
                    )}
                  </div>

                  {isAdmin && (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={testing || !webhookUrl.trim()}
                        onClick={handleTestOutbound}
                        className="gap-1.5 whitespace-nowrap"
                      >
                        {testing ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Send className="size-3.5" />
                        )}
                        Testar envio para n8n
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving}
                        onClick={handleSave}
                        className="gap-1.5 whitespace-nowrap"
                      >
                        {saving ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="size-3.5" />
                        )}
                        Salvar conexão
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: TEMPLATES JSON EXPORTÁVEIS */}
      {activeTab === 'templates' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Todos os templates já saem pré-preenchidos com a URL{' '}
              <code className="font-mono text-foreground">{origin}</code>. Basta copiar o JSON e
              pressionar <kbd className="rounded border border-border px-1 py-0.5 font-mono text-[10px]">Ctrl+V</kbd>{' '}
              no canvas do seu n8n.akm.
            </p>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  { id: 'all', label: 'Todos' },
                  { id: 'ai', label: 'Atendimento IA' },
                  { id: 'sales', label: 'Vendas & Funil' },
                  { id: 'followup', label: 'Agendador Cron' },
                  { id: 'sync', label: 'Sincronização' },
                ] as const
              ).map((cat) => (
                <Button
                  key={cat.id}
                  type="button"
                  size="sm"
                  variant={templateFilter === cat.id ? 'default' : 'outline'}
                  onClick={() => setTemplateFilter(cat.id)}
                  className="h-7 text-xs whitespace-nowrap"
                >
                  {cat.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {filteredTemplates.map((tpl) => {
              const jsonString = JSON.stringify(tpl.workflow, null, 2)
              return (
                <div
                  key={tpl.id}
                  className="flex flex-col justify-between rounded-xl border border-border bg-card p-4 space-y-4"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-sm font-semibold text-foreground">{tpl.title}</h4>
                      <Sparkles className="size-4 shrink-0 text-primary" />
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {tpl.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 font-mono text-[11px] text-muted-foreground">
                      {tpl.nodesSummary.map((node, idx) => (
                        <span key={node} className="inline-flex items-center gap-1.5">
                          <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-foreground">
                            {node}
                          </span>
                          {idx < tpl.nodesSummary.length - 1 ? <span>→</span> : null}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 border-t border-border pt-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="flex-1 gap-1.5 whitespace-nowrap"
                      onClick={() => copyText(`tpl-${tpl.id}`, jsonString, tpl.title)}
                    >
                      {copiedId === `tpl-${tpl.id}` ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      Copiar JSON
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="gap-1.5 whitespace-nowrap"
                      onClick={() => downloadTemplate(tpl.filename, tpl.workflow)}
                    >
                      <Download className="size-3.5" />
                      Baixar .json
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* TAB 3: DEPLOY GITHUB & VERCEL */}
      {activeTab === 'deploy' && (
        <div className="space-y-5">
          {/* Runtime & Workspace Summary */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Server className="size-4 text-primary" />
                  Diagnóstico de Prontidão para Vercel
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Verifica apenas se cada variável existe no servidor (nenhum segredo é exibido).
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={loadReadiness}
                disabled={readinessLoading}
                className="gap-1.5 whitespace-nowrap"
              >
                {readinessLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Revalidar ambiente
              </Button>
            </div>

            {readinessLoading && !readiness ? (
              <div className="h-44 animate-pulse rounded-lg bg-muted/50" />
            ) : readiness ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3 border-b border-border pb-4">
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <span className="block text-[11px] text-muted-foreground">Modo atual</span>
                    <span className="mt-0.5 block text-sm font-semibold text-foreground font-mono">
                      {readiness.runtime.mode === 'supabase' ? 'Supabase Produção' : 'Local Híbrido'}
                    </span>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <span className="block text-[11px] text-muted-foreground">Agente IA</span>
                    <span className="mt-0.5 block text-sm font-semibold text-foreground">
                      {readiness.workspaceStatus.aiConfigured
                        ? `Ativo (${readiness.workspaceStatus.aiProvider})`
                        : 'Usando fallback Gemini'}
                    </span>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <span className="block text-[11px] text-muted-foreground">WhatsApp</span>
                    <span className="mt-0.5 block text-sm font-semibold text-foreground">
                      {readiness.workspaceStatus.whatsappConfigured
                        ? readiness.workspaceStatus.whatsappMode === 'qr_code'
                          ? 'QR Code Web'
                          : 'API Oficial Meta'
                        : 'Pendente de pareamento'}
                    </span>
                  </div>
                </div>

                {/* Dense Env Checklist Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Variável de Ambiente</th>
                        <th className="py-2 pr-3 font-medium">Status Atual</th>
                        <th className="py-2 font-medium">Finalidade na Vercel</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {readiness.checks.map((item) => (
                        <tr key={item.key} className="hover:bg-muted/30">
                          <td className="py-2.5 pr-3 font-mono text-foreground whitespace-nowrap">
                            {item.key}
                          </td>
                          <td className="py-2.5 pr-3 whitespace-nowrap">
                            {item.configured ? (
                              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                                <CheckCircle2 className="size-3.5" />
                                Configurada
                              </span>
                            ) : item.requiredForVercel ? (
                              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium">
                                <AlertCircle className="size-3.5" />
                                Preencher na Vercel
                              </span>
                            ) : (
                              <span className="text-muted-foreground">Opcional</span>
                            )}
                          </td>
                          <td className="py-2.5 text-muted-foreground">{item.hint}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Disponível para administradores da conta.
              </p>
            )}
          </div>

          {/* Vercel Cron & Env Template */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Clock className="size-4 text-primary" />
                  Vercel Cron já configurado em vercel.json
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  O projeto inclui <code className="font-mono">vercel.json</code> com agendamento
                  diário compatível com o plano Hobby gratuito. Para executar a cada 5 minutos sem
                  upgrade, importe o template <strong>Agendador 1 min para Vercel Cron</strong> no
                  seu n8n.akm.
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 font-mono text-xs">
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <div className="font-semibold text-foreground">GET /api/automations/cron</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Header: Authorization: Bearer &lt;CRON_SECRET&gt;
                </div>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <div className="font-semibold text-foreground">GET /api/flows/cron</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Header: Authorization: Bearer &lt;CRON_SECRET&gt;
                </div>
              </div>
            </div>

            <div className="space-y-2 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">
                  Modelo de variáveis para colar em Vercel → Settings → Environment Variables:
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5 whitespace-nowrap"
                  onClick={() =>
                    copyText('vercel-env', VERCEL_ENV_TEMPLATE, 'Modelo .env da Vercel')
                  }
                >
                  {copiedId === 'vercel-env' ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  Copiar bloco .env
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                {VERCEL_ENV_TEMPLATE}
              </pre>
            </div>
          </div>

          {/* Step-by-Step GitHub + Vercel + n8n.akm Guide */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <GitBranch className="size-4 text-primary" />
              Passo a passo: GitHub → Vercel → n8n.akm
            </h3>
            <ol className="space-y-2.5 text-xs text-muted-foreground list-decimal pl-5 leading-relaxed">
              <li>
                <strong className="text-foreground">Sincronize com o GitHub:</strong> faça push ou
                exporte o projeto para o seu repositório GitHub. Os checks de lint, TypeScript,
                testes e build já estão alinhados para passar no GitHub Actions.
              </li>
              <li>
                <strong className="text-foreground">Importe na Vercel:</strong> crie um novo projeto
                na Vercel apontando para o repositório, cole as variáveis do bloco acima (incluindo{' '}
                <code className="font-mono text-foreground">CRON_SECRET</code> e{' '}
                <code className="font-mono text-foreground">ENCRYPTION_KEY</code>) e clique em
                Deploy.
              </li>
              <li>
                <strong className="text-foreground">Aplique as migrations no Supabase:</strong>{' '}
                execute os arquivos SQL até{' '}
                <code className="font-mono text-foreground">063_n8n_integration_and_steps.sql</code>{' '}
                no SQL Editor do seu projeto Supabase para habilitar Gemini, WhatsApp QR Code e o
                Hub n8n em produção.
              </li>
              <li>
                <strong className="text-foreground">Vincule sua instância do n8n.akm:</strong> suba
                seu repositório <code className="font-mono text-foreground">n8n.akm</code> no
                Railway, Easypanel ou VPS, importe os JSONs da aba{' '}
                <strong className="text-foreground">Templates JSON</strong> e cole a URL do webhook
                na aba <strong className="text-foreground">Conexão n8n</strong>.
              </li>
            </ol>
            <div className="pt-2 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Globe className="size-3.5 text-primary" />
                Dica: no construtor de Automações agora também existem os passos nativos{' '}
                <strong className="text-foreground">HTTP Request Avançado</strong> e{' '}
                <strong className="text-foreground">Agente de IA (Gemini)</strong> — funcionando
                100% na Vercel mesmo antes de ligar o n8n!
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
