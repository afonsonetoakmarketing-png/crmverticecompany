'use client';

// ============================================================
// Browser-side Supabase-compatible client for Local Hybrid Mode.
//
// Translates fluent `.from().select/insert/update/upsert/delete()`,
// `.rpc()`, `.auth.*`, `.storage.from()`, and `.channel()` calls to
// `/api/local-backend` so every existing React page & hook works
// seamlessly without changing application code.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LOCAL_SESSION_HEADER,
  LOCAL_SESSION_STORAGE_KEY,
} from './mode';

interface QueryFilter {
  op: string;
  column?: string;
  value?: unknown;
  notOp?: string;
}

interface QueryOrder {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string; details?: string; hint?: string } | null;
  count?: number | null;
}

let inMemoryLocalToken: string | null = null;
let fetchInterceptorInstalled = false;

export function readStoredLocalToken(): string | null {
  if (inMemoryLocalToken) return inMemoryLocalToken;
  if (typeof window === 'undefined') return null;
  try {
    const ls = window.localStorage.getItem(LOCAL_SESSION_STORAGE_KEY);
    if (ls) {
      inMemoryLocalToken = ls;
      return ls;
    }
  } catch {
    // Storage may be restricted in sandboxed iframes
  }
  try {
    const ss = window.sessionStorage.getItem(LOCAL_SESSION_STORAGE_KEY);
    if (ss) {
      inMemoryLocalToken = ss;
      return ss;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

export function writeStoredLocalToken(token: string | null): void {
  inMemoryLocalToken = token;
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(LOCAL_SESSION_STORAGE_KEY, token);
    else window.localStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  try {
    if (token) window.sessionStorage.setItem(LOCAL_SESSION_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

function isSameOriginUrl(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false;
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!raw) return false;
  if (raw.startsWith('/') && !raw.startsWith('//')) return true;
  try {
    return new URL(raw, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function installLocalFetchInterceptor(): void {
  if (typeof window === 'undefined' || fetchInterceptorInstalled) return;
  fetchInterceptorInstalled = true;
  try {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch: typeof window.fetch = (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      if (!isSameOriginUrl(input)) {
        return originalFetch(input, init);
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      if (headers.get('x-skip-local-session') === '1') {
        headers.delete('x-skip-local-session');
        if (input instanceof Request) {
          return originalFetch(new Request(input, { ...init, headers }));
        }
        return originalFetch(input, { ...init, headers });
      }
      const token = readStoredLocalToken();
      if (token && !headers.has(LOCAL_SESSION_HEADER)) {
        headers.set(LOCAL_SESSION_HEADER, token);
        if (input instanceof Request) {
          return originalFetch(new Request(input, { ...init, headers }));
        }
        return originalFetch(input, { ...init, headers });
      }
      return originalFetch(input, init);
    };

    const desc = Object.getOwnPropertyDescriptor(window, 'fetch');
    if (desc?.writable) {
      window.fetch = wrappedFetch;
    } else if (!desc || desc.configurable) {
      Object.defineProperty(window, 'fetch', {
        value: wrappedFetch,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    // Some embedded runtimes expose Window.fetch as a read-only getter.
    // Partitioned SameSite=None cookies + explicit headers in postLocalBackend
    // still handle authentication without overriding window.fetch.
  }
}

export async function probeLocalCookieAccepted(): Promise<boolean> {
  try {
    const res = await fetch('/api/local-backend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-skip-local-session': '1',
      },
      credentials: 'include',
      cache: 'no-store',
      body: JSON.stringify({ op: 'auth.checkCookie' }),
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as { hasCookie?: boolean } | null;
    return Boolean(json?.hasCookie);
  } catch {
    return false;
  }
}

export async function navigateAfterLocalAuth(
  router: { replace: (href: string) => void; refresh?: () => void },
  destination: string
): Promise<void> {
  installLocalFetchInterceptor();
  const cookieWorked = await probeLocalCookieAccepted();
  if (cookieWorked) {
    window.location.href = destination;
    return;
  }
  // Third-party iframe cookies were blocked by the browser: perform a
  // client-side navigation so Next.js fetches carry `x-local-session`.
  router.replace(destination);
  router.refresh?.();
}

async function postLocalBackend<T = Record<string, unknown>>(
  body: Record<string, unknown>
): Promise<T> {
  installLocalFetchInterceptor();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = readStoredLocalToken();
  if (token) {
    headers[LOCAL_SESSION_HEADER] = token;
  }
  const res = await fetch('/api/local-backend', {
    method: 'POST',
    headers,
    credentials: 'include',
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({
    error: { message: `Local backend HTTP ${res.status}` },
  }));
  return json as T;
}

class BrowserLocalQueryBuilder implements PromiseLike<QueryResult> {
  private payload: {
    table: string;
    action: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
    columns?: string;
    selectOptions?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean };
    values?: unknown;
    upsertOptions?: { onConflict?: string; ignoreDuplicates?: boolean };
    filters: QueryFilter[];
    orders: QueryOrder[];
    limitCount?: number;
    range?: { from: number; to: number };
    single?: boolean;
    maybeSingle?: boolean;
    returning?: boolean;
  };

  constructor(table: string) {
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

  insert(values: unknown) {
    this.payload.action = 'insert';
    this.payload.values = values;
    return this;
  }

  update(values: unknown) {
    this.payload.action = 'update';
    this.payload.values = values;
    return this;
  }

  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
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

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return postLocalBackend<QueryResult>({
      op: 'query',
      payload: this.payload,
    }).then(onfulfilled, onrejected);
  }
}

type AuthListener = (event: string, session: unknown) => void;

async function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function createLocalBrowserClient(): SupabaseClient {
  installLocalFetchInterceptor();
  const listeners = new Set<AuthListener>();

  const emitAuth = (event: string, session: unknown) => {
    for (const cb of listeners) {
      try {
        cb(event, session);
      } catch {
        // Ignore listener errors
      }
    }
  };

  const client = {
    from(table: string) {
      return new BrowserLocalQueryBuilder(table);
    },

    async rpc(fn: string, args?: Record<string, unknown>) {
      return postLocalBackend<QueryResult>({
        op: 'rpc',
        fn,
        args: args ?? {},
      });
    },

    channel() {
      const ch = {
        on() {
          return ch;
        },
        subscribe(cb?: (status: string) => void) {
          if (cb) {
            setTimeout(() => cb('SUBSCRIBED'), 0);
          }
          return ch;
        },
        unsubscribe() {
          return Promise.resolve('ok');
        },
      };
      return ch;
    },

    removeChannel() {
      return Promise.resolve('ok');
    },

    auth: {
      async getSession() {
        return postLocalBackend({ op: 'auth.getSession' });
      },

      async getUser() {
        return postLocalBackend({ op: 'auth.getUser' });
      },

      async signInWithPassword(creds: { email: string; password: string }) {
        const res = await postLocalBackend<{
          data?: { session?: { access_token?: string }; user?: unknown };
          error?: { message: string } | null;
        }>({
          op: 'auth.signInWithPassword',
          ...creds,
        });
        if (!res.error && res.data?.session) {
          if (typeof res.data.session.access_token === 'string') {
            writeStoredLocalToken(res.data.session.access_token);
          }
          emitAuth('SIGNED_IN', res.data.session);
        }
        return res;
      },

      async signUp(input: {
        email: string;
        password: string;
        options?: { data?: { full_name?: string }; emailRedirectTo?: string };
      }) {
        const res = await postLocalBackend<{
          data?: { session?: { access_token?: string }; user?: unknown };
          error?: { message: string } | null;
        }>({
          op: 'auth.signUp',
          email: input.email,
          password: input.password,
          fullName: input.options?.data?.full_name,
        });
        if (!res.error && res.data?.session) {
          if (typeof res.data.session.access_token === 'string') {
            writeStoredLocalToken(res.data.session.access_token);
          }
          emitAuth('SIGNED_IN', res.data.session);
        }
        return res;
      },

      async signOut() {
        const res = await postLocalBackend<{ error: null }>({
          op: 'auth.signOut',
        });
        writeStoredLocalToken(null);
        emitAuth('SIGNED_OUT', null);
        return res;
      },

      async updateUser(updates: {
        password?: string;
        email?: string;
        data?: Record<string, unknown>;
      }) {
        const res = await postLocalBackend<{
          data?: { user?: unknown; sessionToken?: string };
          error?: { message: string } | null;
        }>({
          op: 'auth.updateUser',
          ...updates,
        });
        if (!res.error && typeof res.data?.sessionToken === 'string') {
          writeStoredLocalToken(res.data.sessionToken);
        }
        return res;
      },

      async resetPasswordForEmail(email: string) {
        const res = await postLocalBackend<{
          data?: { localRecoveryReady?: boolean; sessionToken?: string };
          error?: { message: string } | null;
        }>({
          op: 'auth.resetPasswordForEmail',
          email,
        });
        if (!res.error && typeof res.data?.sessionToken === 'string') {
          writeStoredLocalToken(res.data.sessionToken);
        }
        return res;
      },

      onAuthStateChange(callback: AuthListener) {
        listeners.add(callback);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                listeners.delete(callback);
              },
            },
          },
        };
      },
    },

    storage: {
      from(bucket: string) {
        const urlCache = new Map<string, string>();
        return {
          async upload(filePath: string, file: Blob | File, opts?: { contentType?: string }) {
            const dataUrl = await fileToDataUrl(file);
            urlCache.set(filePath, dataUrl);
            const res = await postLocalBackend<{
              data?: { path: string; publicUrl?: string };
              error?: { message: string } | null;
            }>({
              op: 'storage.upload',
              bucket,
              path: filePath,
              dataUrl,
              contentType: opts?.contentType || (file as File).type || 'application/octet-stream',
            });
            return res;
          },
          getPublicUrl(filePath: string) {
            return {
              data: {
                publicUrl:
                  urlCache.get(filePath) ??
                  `/api/local-backend?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(filePath)}`,
              },
            };
          },
          async remove(paths: string[]) {
            for (const p of paths) urlCache.delete(p);
            return postLocalBackend({
              op: 'storage.remove',
              bucket,
              paths,
            });
          },
          async createSignedUrl(filePath: string) {
            return {
              data: {
                signedUrl:
                  urlCache.get(filePath) ??
                  `/api/local-backend?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(filePath)}`,
              },
              error: null,
            };
          },
        };
      },
    },
  };

  return client as unknown as SupabaseClient;
}
