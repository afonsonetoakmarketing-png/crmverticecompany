// ============================================================
// Server-side Supabase-compatible client for Local Hybrid Mode.
// Used by src/lib/supabase/server.ts and admin-client modules when
// Supabase env vars are not configured.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';

import { LOCAL_SESSION_COOKIE, LOCAL_SESSION_HEADER } from './mode';
import {
  executeLocalQuery,
  executeLocalRpc,
  type LocalQueryPayload,
  type LocalQueryResult,
} from './query-engine';
import { signLocalSession, verifyLocalSession } from './session';
import {
  authenticateLocalUser,
  findLocalUserById,
  getLocalFilePublicUrl,
  registerLocalUser,
  removeLocalFiles,
  storeLocalFile,
  toSupabaseUser,
  updateLocalUser,
  type Row,
} from './store';

class LocalQueryBuilder implements PromiseLike<LocalQueryResult> {
  private payload: LocalQueryPayload;
  private exec: (p: LocalQueryPayload) => Promise<LocalQueryResult>;

  constructor(
    table: string,
    exec: (p: LocalQueryPayload) => Promise<LocalQueryResult>
  ) {
    this.exec = exec;
    this.payload = {
      table,
      action: 'select',
      filters: [],
      orders: [],
    };
  }

  select(columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    this.payload.columns = columns;
    if (options) this.payload.selectOptions = options;
    if (this.payload.action !== 'select') {
      this.payload.returning = true;
    }
    return this;
  }

  insert(values: Row | Row[]) {
    this.payload.action = 'insert';
    this.payload.values = values;
    return this;
  }

  update(values: Row) {
    this.payload.action = 'update';
    this.payload.values = values;
    return this;
  }

  upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.payload.action = 'upsert';
    this.payload.values = values;
    this.payload.upsertOptions = options;
    return this;
  }

  delete() {
    this.payload.action = 'delete';
    return this;
  }

  eq(column: string, value: unknown) {
    this.payload.filters.push({ op: 'eq', column, value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.payload.filters.push({ op: 'neq', column, value });
    return this;
  }

  gt(column: string, value: unknown) {
    this.payload.filters.push({ op: 'gt', column, value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.payload.filters.push({ op: 'gte', column, value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.payload.filters.push({ op: 'lt', column, value });
    return this;
  }

  lte(column: string, value: unknown) {
    this.payload.filters.push({ op: 'lte', column, value });
    return this;
  }

  like(column: string, value: string) {
    this.payload.filters.push({ op: 'like', column, value });
    return this;
  }

  ilike(column: string, value: string) {
    this.payload.filters.push({ op: 'ilike', column, value });
    return this;
  }

  is(column: string, value: unknown) {
    this.payload.filters.push({ op: 'is', column, value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.payload.filters.push({ op: 'in', column, value });
    return this;
  }

  contains(column: string, value: unknown) {
    this.payload.filters.push({ op: 'contains', column, value });
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    this.payload.filters.push({ op: 'not', column, notOp: operator, value });
    return this;
  }

  or(filterStr: string) {
    this.payload.filters.push({ op: 'or', value: filterStr });
    return this;
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.payload.orders.push({
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst,
    });
    return this;
  }

  limit(count: number) {
    this.payload.limitCount = count;
    return this;
  }

  range(from: number, to: number) {
    this.payload.range = { from, to };
    return this;
  }

  single() {
    this.payload.single = true;
    return this;
  }

  maybeSingle() {
    this.payload.maybeSingle = true;
    return this;
  }

  then<TResult1 = LocalQueryResult, TResult2 = never>(
    onfulfilled?: ((value: LocalQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.exec(this.payload).then(onfulfilled, onrejected);
  }
}

export async function createLocalServerClient(options?: {
  isAdmin?: boolean;
}): Promise<SupabaseClient> {
  const isAdmin = options?.isAdmin ?? false;

  async function resolveCurrentUserId(): Promise<string | null> {
    if (isAdmin) return null;
    try {
      const cookieStore = await cookies();
      let raw = cookieStore.get(LOCAL_SESSION_COOKIE)?.value;
      if (!raw) {
        const headerStore = await headers();
        raw = headerStore.get(LOCAL_SESSION_HEADER) ?? undefined;
      }
      const session = await verifyLocalSession(raw);
      return session?.userId ?? null;
    } catch {
      return null;
    }
  }

  async function resolveCookieOptions(maxAge = 60 * 60 * 24 * 14) {
    let https = false;
    try {
      const headerStore = await headers();
      const proto = headerStore.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
      const host = (headerStore.get('x-forwarded-host') ?? headerStore.get('host') ?? '').toLowerCase();
      https = proto === 'https' || host.endsWith('.run.app') || host.endsWith('.vercel.app');
    } catch {
      https = false;
    }
    return https
      ? {
          httpOnly: true,
          sameSite: 'none' as const,
          secure: true,
          partitioned: true,
          path: '/',
          maxAge,
        }
      : {
          httpOnly: true,
          sameSite: 'lax' as const,
          secure: false,
          path: '/',
          maxAge,
        };
  }

  const client = {
    from(table: string) {
      return new LocalQueryBuilder(table, async (payload) => {
        const userId = await resolveCurrentUserId();
        return executeLocalQuery(payload, userId, isAdmin);
      });
    },

    async rpc(fn: string, args?: Record<string, unknown>) {
      const userId = await resolveCurrentUserId();
      return executeLocalRpc(fn, args ?? {}, userId);
    },

    auth: {
      async getUser() {
        const userId = await resolveCurrentUserId();
        if (!userId) return { data: { user: null }, error: null };
        const user = findLocalUserById(userId);
        if (!user) return { data: { user: null }, error: null };
        return { data: { user: toSupabaseUser(user) }, error: null };
      },

      async getSession() {
        const userId = await resolveCurrentUserId();
        if (!userId) return { data: { session: null }, error: null };
        const user = findLocalUserById(userId);
        if (!user) return { data: { session: null }, error: null };
        const sbUser = toSupabaseUser(user);
        return {
          data: {
            session: {
              access_token: 'local-hybrid-token',
              refresh_token: 'local-hybrid-refresh',
              token_type: 'bearer',
              expires_in: 3600,
              user: sbUser,
            },
          },
          error: null,
        };
      },

      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const res = authenticateLocalUser({ email, password });
        if (!res.user) {
          return { data: { user: null, session: null }, error: { message: res.error || 'Credenciais inválidas.' } };
        }
        const token = await signLocalSession({
          userId: res.user.id,
          email: res.user.email,
          fullName: res.user.full_name,
        });
        try {
          const cookieStore = await cookies();
          cookieStore.set(LOCAL_SESSION_COOKIE, token, await resolveCookieOptions());
        } catch {
          // Ignored in Server Component context
        }
        const sbUser = toSupabaseUser(res.user);
        return {
          data: { user: sbUser, session: { access_token: token, user: sbUser } },
          error: null,
        };
      },

      async signUp({
        email,
        password,
        options: signUpOptions,
      }: {
        email: string;
        password: string;
        options?: { data?: { full_name?: string } };
      }) {
        const res = registerLocalUser({
          email,
          password,
          fullName: signUpOptions?.data?.full_name,
        });
        if (!res.user) {
          return { data: { user: null, session: null }, error: { message: res.error || 'Erro ao cadastrar.' } };
        }
        const token = await signLocalSession({
          userId: res.user.id,
          email: res.user.email,
          fullName: res.user.full_name,
        });
        try {
          const cookieStore = await cookies();
          cookieStore.set(LOCAL_SESSION_COOKIE, token, await resolveCookieOptions());
        } catch {
          // Ignored in Server Component context
        }
        const sbUser = toSupabaseUser(res.user);
        return {
          data: { user: sbUser, session: { access_token: token, user: sbUser } },
          error: null,
        };
      },

      async updateUser(updates: { password?: string; email?: string; data?: Record<string, unknown> }) {
        const userId = await resolveCurrentUserId();
        if (!userId) return { data: { user: null }, error: { message: 'Não autenticado.' } };
        const res = updateLocalUser(userId, updates);
        if (!res.user) return { data: { user: null }, error: { message: res.error || 'Erro ao atualizar.' } };
        return { data: { user: toSupabaseUser(res.user) }, error: null };
      },

      async signOut() {
        try {
          const cookieStore = await cookies();
          cookieStore.delete(LOCAL_SESSION_COOKIE);
        } catch {
          // Ignored
        }
        return { error: null };
      },

      async exchangeCodeForSession() {
        return { data: { session: null, user: null }, error: null };
      },

      async verifyOtp() {
        return { data: { session: null, user: null }, error: null };
      },
    },

    storage: {
      from(bucket: string) {
        return {
          async upload(filePath: string, data: Buffer | Blob | string, opts?: { contentType?: string }) {
            let dataUrl = '';
            const contentType = opts?.contentType || 'application/octet-stream';
            if (typeof data === 'string') {
              dataUrl = data;
            } else if (Buffer.isBuffer(data)) {
              dataUrl = `data:${contentType};base64,${data.toString('base64')}`;
            } else {
              const arr = new Uint8Array(await data.arrayBuffer());
              dataUrl = `data:${contentType};base64,${Buffer.from(arr).toString('base64')}`;
            }
            storeLocalFile(bucket, filePath, dataUrl, contentType);
            return { data: { path: filePath }, error: null };
          },
          getPublicUrl(filePath: string) {
            return { data: { publicUrl: getLocalFilePublicUrl(bucket, filePath) } };
          },
          async remove(paths: string[]) {
            removeLocalFiles(bucket, paths);
            return { data: [], error: null };
          },
          async createSignedUrl(filePath: string) {
            return { data: { signedUrl: getLocalFilePublicUrl(bucket, filePath) }, error: null };
          },
        };
      },
    },
  };

  return client as unknown as SupabaseClient;
}

export function createLocalAdminClient(): SupabaseClient {
  const client = {
    from(table: string) {
      return new LocalQueryBuilder(table, async (payload) =>
        executeLocalQuery(payload, null, true)
      );
    },
    async rpc(fn: string, args?: Record<string, unknown>) {
      return executeLocalRpc(fn, args ?? {}, null);
    },
    auth: {
      async getUser() {
        return { data: { user: null }, error: null };
      },
      async getSession() {
        return { data: { session: null }, error: null };
      },
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(filePath: string, data: Buffer | Blob | string, opts?: { contentType?: string }) {
            const contentType = opts?.contentType || 'application/octet-stream';
            const dataUrl =
              typeof data === 'string'
                ? data
                : Buffer.isBuffer(data)
                  ? `data:${contentType};base64,${data.toString('base64')}`
                  : `data:${contentType};base64,${Buffer.from(new Uint8Array(await data.arrayBuffer())).toString('base64')}`;
            storeLocalFile(bucket, filePath, dataUrl, contentType);
            return { data: { path: filePath }, error: null };
          },
          getPublicUrl(filePath: string) {
            return { data: { publicUrl: getLocalFilePublicUrl(bucket, filePath) } };
          },
          async remove(paths: string[]) {
            removeLocalFiles(bucket, paths);
            return { data: [], error: null };
          },
        };
      },
    },
  };
  return client as unknown as SupabaseClient;
}
