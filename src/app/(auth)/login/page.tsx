"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";
import { VerticeBrandLockup } from "@/components/brand/vertice-logo";
import { DEFAULT_LOCAL_ADMIN, isLocalHybridMode } from "@/lib/local-backend/mode";
import { navigateAfterLocalAuth } from "@/lib/local-backend/browser-client";

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");
  // Set by /auth/callback when an emailed link (confirmation, password
  // reset) could not be turned into a session — see src/lib/auth/callback.ts.
  const linkError = searchParams.get("error");
  const linkErrorMessage =
    linkError === "link_expired"
      ? t("linkExpired")
      : linkError === "link_invalid"
        ? t("linkInvalid")
        : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();
  const localHybrid = isLocalHybridMode();

  const submitCredentials = async (loginEmail: string, loginPassword: string) => {
    setError(null);
    setLoading(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });

      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }

      const destination = inviteToken
        ? `/join/${encodeURIComponent(inviteToken)}`
        : "/dashboard";

      if (localHybrid) {
        await navigateAfterLocalAuth(router, destination);
        return;
      }

      // Full-page navigation (not router.push) so the browser issues a
      // fresh top-level request that carries the just-written Supabase
      // auth cookies to the middleware gating /dashboard.
      window.location.href = destination;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Não foi possível conectar ao servidor."
      );
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitCredentials(email, password);
  };

  const handleInstantAdminLogin = async () => {
    setEmail(DEFAULT_LOCAL_ADMIN.email);
    setPassword(DEFAULT_LOCAL_ADMIN.password);
    await submitCredentials(DEFAULT_LOCAL_ADMIN.email, DEFAULT_LOCAL_ADMIN.password);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <VerticeBrandLockup />
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t('titleAccept') : t('titleWelcome')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t('descAccept')
              : t('descWelcome')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {linkErrorMessage && !error && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
                {linkErrorMessage}
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t('passwordLabel')}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
              {/* Below the input so Tab goes email -> password -> link. */}
              <Link
                href="/forgot-password"
                className="self-end text-sm text-primary hover:text-primary/80"
              >
                {t('forgotPassword')}
              </Link>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t('signingIn') : t('signIn')}
            </Button>
          </form>

          {localHybrid && (
            <div className="mt-5 rounded-lg border border-primary/25 bg-primary/5 p-3.5 text-xs">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
                <span>Modo Híbrido Local — Acesso Administrador Inicial</span>
              </div>
              <p className="mt-1.5 text-muted-foreground">
                Entre com o administrador inicial ou crie seu próprio login em{" "}
                <span className="font-medium text-foreground">Criar conta</span>.
              </p>
              <div className="mt-2.5 flex flex-col gap-1 rounded-md border border-border bg-background/60 px-2.5 py-2 font-mono text-[11px] text-foreground">
                <div>E-mail: {DEFAULT_LOCAL_ADMIN.email}</div>
                <div>Senha: {DEFAULT_LOCAL_ADMIN.password}</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={handleInstantAdminLogin}
                className="mt-2.5 w-full border-primary/30 text-xs text-primary hover:bg-primary/10"
              >
                {loading ? "Conectando..." : "Entrar agora como Administrador"}
              </Button>
            </div>
          )}

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t('noAccount')}{" "}
            <Link
              href={
                inviteToken
                  ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                  : "/signup"
              }
              className="text-primary hover:text-primary/80"
            >
              {t('createAccount')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
