'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, Database, Server, Loader2 } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { SettingsChip } from './settings-chip';

interface EnvCheck {
  key: string;
  configured: boolean;
  category: 'supabase' | 'security' | 'whatsapp' | 'app';
  requiredForProduction: boolean;
}

interface SystemStatusPayload {
  mode: 'local_hybrid' | 'supabase';
  locale: string;
  envChecks: EnvCheck[];
}

export function BackendStatusCard() {
  const [status, setStatus] = useState<SystemStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system/status', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.mode) setStatus(data as SystemStatusPayload);
      })
      .catch(() => {
        // Non-fatal diagnostic card
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Card className="mt-4">
        <CardContent className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Carregando diagnóstico do backend...
        </CardContent>
      </Card>
    );
  }

  if (!status) return null;

  const isLocal = status.mode === 'local_hybrid';

  return (
    <Card className="mt-4">
      <CardContent className="py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
              {isLocal ? <Server className="size-4" /> : <Database className="size-4" />}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Status do Backend e Ambiente
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isLocal
                  ? 'Executando em Modo Híbrido Local: todas as edições e cadastros são salvos localmente. Ao configurar as variáveis do Supabase no deploy, o sistema alterna automaticamente para o banco oficial.'
                  : 'Conectado ao Supabase em modo nativo de produção.'}
              </p>
            </div>
          </div>

          <SettingsChip variant={isLocal ? 'warn' : 'ok'}>
            {isLocal ? 'Modo Híbrido Local' : 'Supabase Conectado'}
          </SettingsChip>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {status.envChecks.map((item) => (
            <div
              key={item.key}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card-2 px-3 py-2 text-xs"
            >
              <span className="truncate font-mono text-[11px] text-foreground">
                {item.key}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[11px]">
                {item.configured ? (
                  <>
                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                    <span className="text-emerald-500">Configurada</span>
                  </>
                ) : (
                  <>
                    <CircleDashed className="size-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {item.requiredForProduction ? 'Pendente p/ produção' : 'Opcional'}
                    </span>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
