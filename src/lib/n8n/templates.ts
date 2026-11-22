// ============================================================
// Exportable n8n Workflow JSON templates (v1 schema).
//
// Each template generates a genuine n8n workflow JSON that the user
// can copy (Ctrl+V directly onto the n8n.akm canvas) or download as
// `.json` and import via "Import from File".
// ============================================================

export type N8nTemplateCategory = 'ai' | 'sales' | 'followup' | 'sync'

export interface N8nWorkflowTemplate {
  id: string
  category: N8nTemplateCategory
  title: string
  description: string
  nodesSummary: string[]
  filename: string
  workflow: Record<string, unknown>
}

function normalizeOrigin(origin?: string): string {
  const cleaned = (origin || 'https://seu-crm.vercel.app').trim().replace(/\/+$/, '')
  return cleaned || 'https://seu-crm.vercel.app'
}

export function buildN8nTemplates(crmOrigin?: string): N8nWorkflowTemplate[] {
  const base = normalizeOrigin(crmOrigin)
  const inboundEndpoint = `${base}/api/integrations/n8n/webhook`
  const automationsCronEndpoint = `${base}/api/automations/cron`
  const flowsCronEndpoint = `${base}/api/flows/cron`

  return [
    {
      id: 'whatsapp-gemini-crm',
      category: 'ai',
      title: 'Atendimento WhatsApp + Google Gemini + CRM',
      description:
        'Recebe mensagens do CRM via Webhook, gera resposta contextualizada com Google Gemini no n8n e devolve a resposta automaticamente no WhatsApp (Oficial ou QR Code).',
      nodesSummary: ['Webhook CRM', 'Filtro Mensagem', 'CRM AI Reply (Gemini)', 'WhatsApp Send'],
      filename: 'crm-whatsapp-gemini-n8n.json',
      workflow: {
        name: 'CRM WhatsApp + Google Gemini (n8n.akm)',
        nodes: [
          {
            parameters: {
              httpMethod: 'POST',
              path: 'crm-whatsapp-inbound',
              responseMode: 'onReceived',
              options: {},
            },
            id: 'node-webhook-in',
            name: 'Webhook CRM (Nova Mensagem)',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2,
            position: [220, 300],
          },
          {
            parameters: {
              conditions: {
                options: { caseSensitive: false },
                conditions: [
                  {
                    id: 'cond-event',
                    leftValue: '={{ $json.body.event }}',
                    rightValue: 'message.received',
                    operator: { type: 'string', operation: 'equals' },
                  },
                ],
                combinator: 'and',
              },
            },
            id: 'node-if-msg',
            name: 'É Nova Mensagem?',
            type: 'n8n-nodes-base.if',
            typeVersion: 2,
            position: [460, 300],
          },
          {
            parameters: {
              method: 'POST',
              url: inboundEndpoint,
              sendHeaders: true,
              headerParameters: {
                parameters: [
                  {
                    name: 'Authorization',
                    value: 'Bearer COLE_SEU_TOKEN_N8N_AQUI',
                  },
                  {
                    name: 'Content-Type',
                    value: 'application/json',
                  },
                ],
              },
              sendBody: true,
              specifyBody: 'json',
              jsonBody:
                '={\n  "action": "run_ai_reply",\n  "phone": "{{ $json.body.data.contact_phone }}",\n  "message": "{{ $json.body.data.message_text }}",\n  "prompt": "Responda de forma cordial, objetiva e em português como consultor comercial.",\n  "use_knowledge_base": true,\n  "send_whatsapp": true\n}',
              options: {},
            },
            id: 'node-crm-ai',
            name: 'Gerar e Enviar via Gemini no CRM',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [720, 280],
          },
        ],
        connections: {
          'Webhook CRM (Nova Mensagem)': {
            main: [[{ node: 'É Nova Mensagem?', type: 'main', index: 0 }]],
          },
          'É Nova Mensagem?': {
            main: [[{ node: 'Gerar e Enviar via Gemini no CRM', type: 'main', index: 0 }], []],
          },
        },
        active: false,
        settings: { executionOrder: 'v1' },
        meta: { templateId: 'whatsapp-gemini-crm', source: 'whatsapp-crm' },
      },
    },
    {
      id: 'lead-qualification-pipeline',
      category: 'sales',
      title: 'Qualificação de Lead → Funil e Tag no CRM',
      description:
        'Quando um lead entra por formulário externo ou mensagem, faz upsert do contato no CRM, aplica a tag de interesse e abre um negócio automaticamente no funil de vendas.',
      nodesSummary: ['Webhook Lead', 'Upsert Contato', 'Aplicar Tag', 'Criar Negócio'],
      filename: 'crm-qualificacao-lead-pipeline.json',
      workflow: {
        name: 'Qualificação de Lead → Funil CRM (n8n.akm)',
        nodes: [
          {
            parameters: {
              httpMethod: 'POST',
              path: 'novo-lead-landing',
              responseMode: 'onReceived',
              options: {},
            },
            id: 'node-lead-hook',
            name: 'Webhook Novo Lead',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2,
            position: [200, 300],
          },
          {
            parameters: {
              method: 'POST',
              url: inboundEndpoint,
              sendHeaders: true,
              headerParameters: {
                parameters: [
                  { name: 'Authorization', value: 'Bearer COLE_SEU_TOKEN_N8N_AQUI' },
                ],
              },
              sendBody: true,
              specifyBody: 'json',
              jsonBody:
                '={\n  "action": "upsert_contact",\n  "phone": "{{ $json.body.phone }}",\n  "name": "{{ $json.body.name }}",\n  "email": "{{ $json.body.email }}",\n  "company": "{{ $json.body.company }}"\n}',
              options: {},
            },
            id: 'node-upsert',
            name: 'CRM: Criar ou Atualizar Contato',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [440, 300],
          },
          {
            parameters: {
              method: 'POST',
              url: inboundEndpoint,
              sendHeaders: true,
              headerParameters: {
                parameters: [
                  { name: 'Authorization', value: 'Bearer COLE_SEU_TOKEN_N8N_AQUI' },
                ],
              },
              sendBody: true,
              specifyBody: 'json',
              jsonBody:
                '={\n  "action": "create_deal",\n  "contact_id": "{{ $json.contact.id }}",\n  "title": "Lead Landing: {{ $json.contact.name }}",\n  "value": 1500\n}',
              options: {},
            },
            id: 'node-deal',
            name: 'CRM: Abrir Negócio no Funil',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [690, 300],
          },
          {
            parameters: {
              method: 'POST',
              url: inboundEndpoint,
              sendHeaders: true,
              headerParameters: {
                parameters: [
                  { name: 'Authorization', value: 'Bearer COLE_SEU_TOKEN_N8N_AQUI' },
                ],
              },
              sendBody: true,
              specifyBody: 'json',
              jsonBody:
                '={\n  "action": "send_whatsapp",\n  "phone": "{{ $(\'CRM: Criar ou Atualizar Contato\').item.json.contact.phone }}",\n  "message": "Olá {{ $(\'CRM: Criar ou Atualizar Contato\').item.json.contact.name }}! Recebemos seu cadastro e já estamos preparando sua proposta."\n}',
              options: {},
            },
            id: 'node-welcome',
            name: 'CRM: Boas-vindas no WhatsApp',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [940, 300],
          },
        ],
        connections: {
          'Webhook Novo Lead': {
            main: [[{ node: 'CRM: Criar ou Atualizar Contato', type: 'main', index: 0 }]],
          },
          'CRM: Criar ou Atualizar Contato': {
            main: [[{ node: 'CRM: Abrir Negócio no Funil', type: 'main', index: 0 }]],
          },
          'CRM: Abrir Negócio no Funil': {
            main: [[{ node: 'CRM: Boas-vindas no WhatsApp', type: 'main', index: 0 }]],
          },
        },
        active: false,
        settings: { executionOrder: 'v1' },
        meta: { templateId: 'lead-qualification-pipeline', source: 'whatsapp-crm' },
      },
    },
    {
      id: 'scheduled-followup-whatsapp',
      category: 'followup',
      title: 'Agendador 1 min para Vercel Cron + Follow-up WhatsApp',
      description:
        'Usa o Schedule Trigger gratuito do n8n para acionar os endpoints de Cron do CRM na Vercel a cada 5 minutos (mesmo no plano Hobby!) sem custo extra.',
      nodesSummary: ['Schedule 5 min', 'Cron Automações Vercel', 'Cron Fluxos Vercel'],
      filename: 'crm-vercel-cron-runner-n8n.json',
      workflow: {
        name: 'CRM Vercel Cron Runner (5 min via n8n.akm)',
        nodes: [
          {
            parameters: {
              rule: {
                interval: [{ field: 'minutes', minutesInterval: 5 }],
              },
            },
            id: 'node-schedule',
            name: 'A cada 5 minutos',
            type: 'n8n-nodes-base.scheduleTrigger',
            typeVersion: 1.2,
            position: [220, 300],
          },
          {
            parameters: {
              method: 'GET',
              url: automationsCronEndpoint,
              sendHeaders: true,
              headerParameters: {
                parameters: [
                  { name: 'Authorization', value: 'Bearer COLE_SEU_CRON_SECRET_AQUI' },
                ],
              },
              options: {},
            },
            id: 'node-auto-cron',
            name: 'Executar Fila de Automações CRM',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [490, 220],
          },
          {
            parameters: {
              method: 'GET',
              url: flowsCronEndpoint,
              sendHeaders: true,
              headerParameters: {
                parameters: [
                  { name: 'Authorization', value: 'Bearer COLE_SEU_CRON_SECRET_AQUI' },
                ],
              },
              options: {},
            },
            id: 'node-flows-cron',
            name: 'Executar Timeouts de Fluxos CRM',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [490, 380],
          },
        ],
        connections: {
          'A cada 5 minutos': {
            main: [
              [
                { node: 'Executar Fila de Automações CRM', type: 'main', index: 0 },
                { node: 'Executar Timeouts de Fluxos CRM', type: 'main', index: 0 },
              ],
            ],
          },
        },
        active: false,
        settings: { executionOrder: 'v1' },
        meta: { templateId: 'scheduled-followup-whatsapp', source: 'whatsapp-crm' },
      },
    },
    {
      id: 'crm-sheets-sync',
      category: 'sync',
      title: 'Sincronização Bidirecional CRM ↔ ERP / Planilha',
      description:
        'Escuta eventos do CRM (negócio criado, tag aplicada ou contato criado), normaliza os campos no nó Set e envia para sua planilha, ERP ou webhook externo.',
      nodesSummary: ['Webhook CRM', 'Normalizar Campos (Set)', 'HTTP Request ERP / Planilha'],
      filename: 'crm-sync-erp-planilha-n8n.json',
      workflow: {
        name: 'Sincronização CRM → ERP / Planilha (n8n.akm)',
        nodes: [
          {
            parameters: {
              httpMethod: 'POST',
              path: 'crm-sync-events',
              responseMode: 'onReceived',
              options: {},
            },
            id: 'node-sync-in',
            name: 'Webhook Eventos CRM',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2,
            position: [220, 300],
          },
          {
            parameters: {
              assignments: {
                assignments: [
                  { id: 'f1', name: 'evento', value: '={{ $json.body.event }}', type: 'string' },
                  { id: 'f2', name: 'data_hora', value: '={{ $json.body.timestamp }}', type: 'string' },
                  { id: 'f3', name: 'contato_nome', value: '={{ $json.body.data.contact_name || "" }}', type: 'string' },
                  { id: 'f4', name: 'contato_telefone', value: '={{ $json.body.data.contact_phone || "" }}', type: 'string' },
                  { id: 'f5', name: 'payload_json', value: '={{ JSON.stringify($json.body.data) }}', type: 'string' },
                ],
              },
              options: {},
            },
            id: 'node-set-fields',
            name: 'Normalizar Dados do CRM',
            type: 'n8n-nodes-base.set',
            typeVersion: 3.4,
            position: [480, 300],
          },
          {
            parameters: {
              method: 'POST',
              url: 'https://seu-erp-ou-webhook-externo.com/api/sync',
              sendBody: true,
              specifyBody: 'json',
              jsonBody: '={{ JSON.stringify($json) }}',
              options: {},
            },
            id: 'node-erp-out',
            name: 'Enviar para ERP / Planilha',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [740, 300],
          },
        ],
        connections: {
          'Webhook Eventos CRM': {
            main: [[{ node: 'Normalizar Dados do CRM', type: 'main', index: 0 }]],
          },
          'Normalizar Dados do CRM': {
            main: [[{ node: 'Enviar para ERP / Planilha', type: 'main', index: 0 }]],
          },
        },
        active: false,
        settings: { executionOrder: 'v1' },
        meta: { templateId: 'crm-sheets-sync', source: 'whatsapp-crm' },
      },
    },
  ]
}
