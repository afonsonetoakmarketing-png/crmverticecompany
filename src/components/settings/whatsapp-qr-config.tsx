'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Unplug,
  Webhook,
  XCircle,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

type QrProvider = 'evolution' | 'waha' | 'custom_webhook';
type QrStatus = 'disconnected' | 'qr_ready' | 'connected';

const MASKED_KEY = '••••••••••••••••';

const QR_PROVIDER_LABELS: Record<QrProvider, string> = {
  evolution: 'Evolution API v2 (Recomendado)',
  waha: 'WAHA (WhatsApp HTTP API)',
  custom_webhook: 'Webhook Personalizado (Baileys / n8n)',
};

interface QrStatePayload {
  configured: boolean;
  connection_mode: 'official_api' | 'qr_code';
  qr_provider: QrProvider;
  qr_api_url: string;
  qr_instance_name: string;
  has_qr_api_key: boolean;
  has_webhook_secret: boolean;
  qr_status: QrStatus;
  qr_phone_number: string | null;
  qr_connected_at: string | null;
  webhook_url: string;
  webhook_secret: string | null;
}

interface WhatsAppQrConfigProps {
  onModeActivated?: (mode: 'official_api' | 'qr_code') => void;
}

export function WhatsAppQrConfig({ onModeActivated }: WhatsAppQrConfigProps) {
  const { accountId, canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [rotatingSecret, setRotatingSecret] = useState(false);

  const [connectionMode, setConnectionMode] = useState<'official_api' | 'qr_code'>('official_api');
  const [provider, setProvider] = useState<QrProvider>('evolution');
  const [apiUrl, setApiUrl] = useState('');
  const [instanceName, setInstanceName] = useState('wacrm');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyEdited, setApiKeyEdited] = useState(false);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  const [qrStatus, setQrStatus] = useState<QrStatus>('disconnected');
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const loadedAccountRef = useRef<string | null>(null);

  const loadConfig = useCallback(async (poll = false) => {
    if (!poll) setLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/qr${poll ? '?poll=1' : ''}`, {
        cache: 'no-store',
      });
      const data = (await res.json()) as QrStatePayload & { error?: string };
      if (!res.ok) {
        if (!poll) toast.error(data.error || 'Falha ao carregar configuração QR Code.');
        return;
      }
      setConnectionMode(data.connection_mode);
      setProvider(data.qr_provider || 'evolution');
      if (!poll) {
        setApiUrl(data.qr_api_url || '');
        setInstanceName(data.qr_instance_name || 'wacrm');
        setHasStoredApiKey(Boolean(data.has_qr_api_key));
        setApiKey(data.has_qr_api_key ? MASKED_KEY : '');
        setApiKeyEdited(false);
      }
      setQrStatus(data.qr_status || 'disconnected');
      setPhoneNumber(data.qr_phone_number || null);
      setWebhookUrl(data.webhook_url || '');
      setWebhookSecret(data.webhook_secret || null);

      if (data.qr_status === 'connected') {
        setQrCodeDataUrl(null);
        setPairingCode(null);
      }
    } catch {
      if (!poll) toast.error('Não foi possível carregar o status do WhatsApp QR Code.');
    } finally {
      if (!poll) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountRef.current === accountId) return;
    loadedAccountRef.current = accountId;
    void loadConfig(false);
  }, [accountId, loadConfig]);

  // Poll automatically every 5s while waiting for the user to scan the QR Code.
  useEffect(() => {
    if (qrStatus !== 'qr_ready' || !qrCodeDataUrl) return;
    const interval = setInterval(() => {
      void loadConfig(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [qrStatus, qrCodeDataUrl, loadConfig]);

  const buildPayload = (action: 'save' | 'connect') => ({
    action,
    qr_provider: provider,
    qr_api_url: apiUrl.trim(),
    qr_instance_name: instanceName.trim() || 'wacrm',
    qr_api_key: apiKeyEdited ? apiKey.trim() : undefined,
  });

  async function handleSave() {
    if (!canEditSettings) return;
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload('save')),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Falha ao salvar configuração QR Code.');
        return;
      }
      setConnectionMode('qr_code');
      if (data.webhook_url) setWebhookUrl(data.webhook_url);
      if (data.webhook_secret) setWebhookSecret(data.webhook_secret);
      if (apiKeyEdited && apiKey.trim()) {
        setHasStoredApiKey(true);
        setApiKey(MASKED_KEY);
        setApiKeyEdited(false);
      }
      onModeActivated?.('qr_code');
      toast.success('Configuração do WhatsApp Web (QR Code) salva e ativada.');
    } catch {
      toast.error('Erro de rede ao salvar configuração QR Code.');
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateQr() {
    if (!canEditSettings) return;
    if (!apiUrl.trim()) {
      toast.error('Informe a URL HTTPS do seu gateway (Evolution API ou WAHA) para gerar o QR Code.');
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch('/api/whatsapp/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload('connect')),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Não foi possível gerar o QR Code.', {
          duration: 9000,
        });
        return;
      }
      setConnectionMode('qr_code');
      setQrStatus(data.qr_status || 'qr_ready');
      setQrCodeDataUrl(data.qr_code_data_url || null);
      setPairingCode(data.pairing_code || null);
      setPhoneNumber(data.qr_phone_number || null);
      if (data.webhook_url) setWebhookUrl(data.webhook_url);
      if (data.webhook_secret) setWebhookSecret(data.webhook_secret);
      if (apiKeyEdited && apiKey.trim()) {
        setHasStoredApiKey(true);
        setApiKey(MASKED_KEY);
        setApiKeyEdited(false);
      }
      onModeActivated?.('qr_code');

      if (data.qr_status === 'connected') {
        toast.success('WhatsApp Web já está conectado!');
      } else if (data.qr_code_data_url) {
        toast.success('QR Code gerado! Escaneie com o WhatsApp do seu celular.');
      } else {
        toast.info('Conexão iniciada. Clique em "Verificar status" após escanear.');
      }
    } catch {
      toast.error('Erro de rede ao solicitar o QR Code ao gateway.');
    } finally {
      setConnecting(false);
    }
  }

  async function handleCheckStatus() {
    setChecking(true);
    try {
      const res = await fetch('/api/whatsapp/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status' }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Falha ao consultar status no gateway.');
        return;
      }
      setQrStatus(data.qr_status || 'disconnected');
      setPhoneNumber(data.qr_phone_number || null);
      if (data.qr_status === 'connected') {
        setQrCodeDataUrl(null);
        setPairingCode(null);
        toast.success(
          data.qr_phone_number
            ? `WhatsApp Web conectado (${data.qr_phone_number})!`
            : 'WhatsApp Web conectado!',
        );
      } else if (data.qr_status === 'qr_ready') {
        toast.info('Aguardando leitura do QR Code no WhatsApp.');
      } else {
        toast.warning('Sessão desconectada no gateway.');
      }
    } catch {
      toast.error('Não foi possível verificar o status da sessão.');
    } finally {
      setChecking(false);
    }
  }

  async function handleDisconnect() {
    if (!canEditSettings) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Falha ao desconectar sessão.');
        return;
      }
      setQrStatus('disconnected');
      setPhoneNumber(null);
      setQrCodeDataUrl(null);
      setPairingCode(null);
      toast.success('Sessão do WhatsApp Web desconectada.');
    } catch {
      toast.error('Erro ao desconectar sessão.');
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleRotateSecret() {
    if (!canEditSettings) return;
    setRotatingSecret(true);
    try {
      const res = await fetch('/api/whatsapp/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rotate_secret' }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Falha ao gerar novo token.');
        return;
      }
      setWebhookSecret(data.webhook_secret || null);
      if (data.webhook_url) setWebhookUrl(data.webhook_url);
      setShowSecret(true);
      toast.success('Novo token de webhook gerado. Atualize-o no seu gateway.');
    } catch {
      toast.error('Erro ao gerar token de webhook.');
    } finally {
      setRotatingSecret(false);
    }
  }

  function copyValue(value: string, label: string) {
    if (!value) return;
    navigator.clipboard.writeText(value);
    toast.success(`${label} copiado para a área de transferência.`);
  }

  const webhookUrlWithToken =
    webhookUrl && webhookSecret
      ? `${webhookUrl}&token=${encodeURIComponent(webhookSecret)}`
      : webhookUrl;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main column */}
      <div className="space-y-6">
        {/* Connection Status Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {qrStatus === 'connected' ? (
                  <div className="flex size-10 items-center justify-center rounded-full bg-emerald-500/15">
                    <CheckCircle2 className="size-5 text-emerald-500" />
                  </div>
                ) : qrStatus === 'qr_ready' ? (
                  <div className="flex size-10 items-center justify-center rounded-full bg-amber-500/15">
                    <QrCode className="size-5 text-amber-500" />
                  </div>
                ) : (
                  <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                    <XCircle className="size-5 text-muted-foreground" />
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">
                      {qrStatus === 'connected'
                        ? 'WhatsApp Web conectado'
                        : qrStatus === 'qr_ready'
                          ? 'Aguardando leitura do QR Code'
                          : 'WhatsApp Web desconectado'}
                    </h3>
                    {connectionMode === 'qr_code' && (
                      <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                        Modo ativo
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {qrStatus === 'connected'
                      ? phoneNumber
                        ? `Sessão pareada com o número +${phoneNumber}. Mensagens recebidas e enviadas passam por este canal.`
                        : 'Sessão pareada e pronta para enviar e receber mensagens na Caixa de Entrada.'
                      : qrStatus === 'qr_ready'
                        ? 'Abra o WhatsApp no celular e escaneie o QR Code abaixo. O status atualiza automaticamente.'
                        : 'Configure seu gateway WhatsApp Web (Evolution API v2 ou WAHA) abaixo e gere o QR Code.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCheckStatus}
                  disabled={checking || !apiUrl.trim()}
                >
                  {checking ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 size-3.5" />
                  )}
                  Verificar status
                </Button>
                {qrStatus === 'connected' && canEditSettings && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    className="text-destructive hover:text-destructive"
                  >
                    {disconnecting ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <Unplug className="mr-1.5 size-3.5" />
                    )}
                    Desconectar
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Live QR Code Display Card */}
        {qrCodeDataUrl && qrStatus !== 'connected' && (
          <Card className="border-primary/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone className="size-4 text-primary" />
                Escaneie o QR Code no seu WhatsApp
              </CardTitle>
              <CardDescription>
                No celular, abra o WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-4">
              <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrCodeDataUrl}
                  alt="QR Code para pareamento do WhatsApp Web"
                  className="size-64 object-contain"
                />
              </div>
              {pairingCode && (
                <div className="rounded-md border border-border bg-muted/40 px-4 py-2 text-center">
                  <p className="text-xs text-muted-foreground">Código de pareamento</p>
                  <p className="font-mono text-lg font-semibold tracking-widest">
                    {pairingCode}
                  </p>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                Verificando conexão automaticamente a cada 5 segundos…
              </div>
            </CardContent>
          </Card>
        )}

        {/* Gateway Credentials Form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <QrCode className="size-4 text-primary" />
              Conexão via Gateway WhatsApp Web (QR Code)
            </CardTitle>
            <CardDescription>
              Conecte uma instância da Evolution API v2, WAHA ou ponte Baileys compatível com webhooks para parear por QR Code sem sair do CRM.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="qr-provider">Gateway / Protocolo</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => setProvider(v as QrProvider)}
                  disabled={!canEditSettings || saving || connecting}
                >
                  <SelectTrigger id="qr-provider" className="w-full">
                    <SelectValue>{QR_PROVIDER_LABELS[provider]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="evolution">
                      {QR_PROVIDER_LABELS.evolution}
                    </SelectItem>
                    <SelectItem value="waha">
                      {QR_PROVIDER_LABELS.waha}
                    </SelectItem>
                    <SelectItem value="custom_webhook">
                      {QR_PROVIDER_LABELS.custom_webhook}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="qr-instance">Nome da instância / sessão</Label>
                <Input
                  id="qr-instance"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                  placeholder="wacrm"
                  disabled={!canEditSettings || saving || connecting}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="qr-api-url">URL pública HTTPS do Gateway</Label>
              <Input
                id="qr-api-url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://evolution.seudominio.com.br"
                disabled={!canEditSettings || saving || connecting}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Informe o endereço HTTPS público onde sua Evolution API ou WAHA está hospedada (ex.: VPS, Railway, Easypanel ou Render).
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="qr-api-key">Chave de API do Gateway (API Key)</Label>
              <div className="relative">
                <Input
                  id="qr-api-key"
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setApiKeyEdited(true);
                  }}
                  onFocus={() => {
                    if (!apiKeyEdited && hasStoredApiKey) {
                      setApiKey('');
                      setApiKeyEdited(true);
                    }
                  }}
                  placeholder="Chave configurada no seu servidor Evolution / WAHA"
                  disabled={!canEditSettings || saving || connecting}
                  autoComplete="off"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? 'Ocultar chave' : 'Mostrar chave'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Armazenada criptografada (AES-256-GCM) no backend. Nunca exposta ao navegador após salva.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button
                type="button"
                onClick={handleGenerateQr}
                disabled={!canEditSettings || connecting || saving}
              >
                {connecting ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <QrCode className="mr-2 size-4" />
                )}
                Salvar e Gerar QR Code
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={handleSave}
                disabled={!canEditSettings || saving || connecting}
              >
                {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                Apenas salvar configuração
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Bidirectional Webhook Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Webhook className="size-4 text-primary" />
              Webhook de Entrada do CRM (Comunicação Bidirecional)
            </CardTitle>
            <CardDescription>
              Configure esta URL no seu gateway para que todas as mensagens recebidas no WhatsApp apareçam em tempo real na Caixa de Entrada e acionem seus Agentes de IA.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="qr-webhook-url">URL do Webhook (com autenticação)</Label>
              <div className="flex gap-2">
                <Input
                  id="qr-webhook-url"
                  value={webhookUrlWithToken}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copyValue(webhookUrlWithToken, 'URL do webhook')}
                  disabled={!webhookUrlWithToken}
                >
                  <Copy className="mr-1.5 size-3.5" />
                  Copiar
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Ao clicar em <strong>Salvar e Gerar QR Code</strong> com Evolution API ou WAHA, o CRM tenta configurar este webhook automaticamente na sua instância.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="qr-webhook-secret">Token de segurança (Header x-webhook-secret)</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="qr-webhook-secret"
                    type={showSecret ? 'text' : 'password'}
                    value={webhookSecret ?? 'Salve ou gere um token abaixo'}
                    readOnly
                    className="pr-10 font-mono text-xs"
                  />
                  {webhookSecret && (
                    <button
                      type="button"
                      onClick={() => setShowSecret((v) => !v)}
                      aria-label={showSecret ? 'Ocultar token' : 'Mostrar token'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  )}
                </div>
                {webhookSecret && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyValue(webhookSecret, 'Token de segurança')}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                )}
                {canEditSettings && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleRotateSecret}
                    disabled={rotatingSecret}
                  >
                    {rotatingSecret ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1.5 size-3.5" />
                    )}
                    {webhookSecret ? 'Regenerar' : 'Gerar token'}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Right sidebar: Complete Step-by-Step Guide */}
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" />
              Passo a passo: WhatsApp Web por QR Code
            </CardTitle>
            <CardDescription>
              Tudo o que você precisa para conectar seu WhatsApp via QR Code e conversar em tempo real no CRM.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <Accordion defaultValue={['qr-step-1']}>
              <AccordionItem value="qr-step-1">
                <AccordionTrigger className="text-left text-sm font-medium">
                  1. Suba um servidor Gateway (Evolution API ou WAHA)
                </AccordionTrigger>
                <AccordionContent className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    Como o WhatsApp Web exige uma sessão WebSocket contínua (e o CRM roda em arquitetura serverless), você precisa de uma ponte leve rodando em uma VPS, Easypanel, Railway, Render ou Docker:
                  </p>
                  <ul className="list-disc space-y-1 pl-4">
                    <li>
                      <strong className="text-foreground">Evolution API v2</strong> (open-source, recomendada para produção e múltiplos números).
                    </li>
                    <li>
                      <strong className="text-foreground">WAHA</strong> (imagem Docker única, rápida de subir).
                    </li>
                  </ul>
                  <p className="pt-1">
                    Garanta que o servidor esteja publicado com <strong className="text-foreground">HTTPS</strong> e anote a <strong className="text-foreground">API Key</strong> definida na variável de ambiente do servidor.
                  </p>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="qr-step-2">
                <AccordionTrigger className="text-left text-sm font-medium">
                  2. Conecte o Gateway ao CRM
                </AccordionTrigger>
                <AccordionContent className="space-y-1.5 text-xs text-muted-foreground">
                  <p>No formulário ao lado:</p>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li>Selecione <strong className="text-foreground">Evolution API v2</strong> ou <strong className="text-foreground">WAHA</strong>.</li>
                    <li>Escolha um nome de instância (ex.: <code className="text-foreground">wacrm</code>).</li>
                    <li>Cole a <strong className="text-foreground">URL HTTPS</strong> do seu gateway e a <strong className="text-foreground">Chave de API</strong>.</li>
                    <li>Clique em <strong className="text-foreground">Salvar e Gerar QR Code</strong>.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="qr-step-3">
                <AccordionTrigger className="text-left text-sm font-medium">
                  3. Escaneie o QR Code no celular
                </AccordionTrigger>
                <AccordionContent className="space-y-1.5 text-xs text-muted-foreground">
                  <ol className="list-decimal space-y-1 pl-4">
                    <li>Abra o <strong className="text-foreground">WhatsApp</strong> no seu aparelho.</li>
                    <li>Toque em <strong className="text-foreground">Configurações</strong> (ou menu ⋮) → <strong className="text-foreground">Aparelhos conectados</strong>.</li>
                    <li>Toque em <strong className="text-foreground">Conectar um aparelho</strong> e aponte a câmera para o QR Code exibido aqui.</li>
                    <li>Aguarde até 5 segundos: o status mudará automaticamente para <strong className="text-foreground">WhatsApp Web conectado</strong>.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="qr-step-4">
                <AccordionTrigger className="text-left text-sm font-medium">
                  4. Comunicação bidirecional e Agentes de IA
                </AccordionTrigger>
                <AccordionContent className="space-y-1.5 text-xs text-muted-foreground">
                  <p>
                    Quando um cliente enviar mensagem no WhatsApp, o gateway dispara o <strong className="text-foreground">Webhook de Entrada</strong> acima:
                  </p>
                  <ul className="list-disc space-y-1 pl-4">
                    <li>O contato e a conversa são criados automaticamente na <strong className="text-foreground">Caixa de Entrada</strong>.</li>
                    <li>Se o seu <strong className="text-foreground">Agente de IA (Google Gemini, OpenAI ou Claude)</strong> estiver ativo em <em>Agentes</em>, ele responde automaticamente pelo mesmo canal QR Code.</li>
                    <li>Todas as respostas digitadas por sua equipe na Caixa de Entrada são entregues diretamente no WhatsApp do cliente.</li>
                  </ul>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Dica: API Oficial vs QR Code</p>
              <p className="mt-1">
                Você pode alternar entre <strong>API Oficial (Meta)</strong> e <strong>WhatsApp Web (QR Code)</strong> a qualquer momento. Para alto volume de disparos em massa, prefira a API Oficial da Meta.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
