// ============================================================
// /api/local-backend — Internal bridge for Local Hybrid Mode.
//
// Strictly gated behind `isLocalHybridMode()`: when real Supabase
// environment variables are configured (production / Vercel / Docker),
// every request immediately returns 404 so this route has zero surface
// area in production deployments.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server';

import {
  isLocalHybridMode,
  LOCAL_SESSION_COOKIE,
  LOCAL_SESSION_HEADER,
} from '@/lib/local-backend/mode';
import {
  executeLocalQuery,
  executeLocalRpc,
  type LocalQueryPayload,
} from '@/lib/local-backend/query-engine';
import { signLocalSession, verifyLocalSession } from '@/lib/local-backend/session';
import {
  authenticateLocalUser,
  findLocalUserByEmail,
  findLocalUserById,
  getLocalDb,
  registerLocalUser,
  removeLocalFiles,
  storeLocalFile,
  toSupabaseUser,
  updateLocalUser,
} from '@/lib/local-backend/store';

function isHttpsRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto === 'https') return true;
  if (request.nextUrl.protocol === 'https:') return true;
  const origin = request.headers.get('origin') ?? '';
  if (origin.startsWith('https://')) return true;
  const referer = request.headers.get('referer') ?? '';
  if (referer.startsWith('https://')) return true;
  const host = (
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    ''
  ).toLowerCase();
  if (host.endsWith('.run.app') || host.endsWith('.vercel.app')) return true;
  return false;
}

function cookieOptions(request: NextRequest, maxAge = 60 * 60 * 24 * 14) {
  const https = isHttpsRequest(request);
  if (https) {
    return {
      httpOnly: true,
      sameSite: 'none' as const,
      secure: true,
      partitioned: true,
      path: '/',
      maxAge,
    };
  }
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: false,
    path: '/',
    maxAge,
  };
}

export async function GET(request: NextRequest) {
  if (!isLocalHybridMode()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const bucket = request.nextUrl.searchParams.get('bucket');
  const filePath = request.nextUrl.searchParams.get('path');
  if (!bucket || !filePath) {
    return NextResponse.json({ mode: 'local_hybrid', ok: true });
  }

  const db = getLocalDb();
  const entry = db.storage[bucket]?.[filePath];
  if (!entry?.dataUrl) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const comma = entry.dataUrl.indexOf(',');
  if (comma === -1) {
    return NextResponse.json({ error: 'Corrupted asset' }, { status: 500 });
  }
  const base64 = entry.dataUrl.slice(comma + 1);
  const buf = Buffer.from(base64, 'base64');
  return new NextResponse(buf, {
    headers: {
      'Content-Type': entry.contentType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

export async function POST(request: NextRequest) {
  if (!isLocalHybridMode()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.op !== 'string') {
    return NextResponse.json(
      { data: null, error: { message: 'Requisição inválida.' } },
      { status: 400 }
    );
  }

  const cookieToken = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  const headerToken = request.headers.get(LOCAL_SESSION_HEADER) ?? undefined;
  const rawToken = cookieToken || headerToken;
  const session = await verifyLocalSession(rawToken);
  const userId = session?.userId ?? null;

  switch (body.op) {
    case 'auth.checkCookie': {
      const cookieSession = await verifyLocalSession(cookieToken);
      return NextResponse.json({
        hasCookie: Boolean(cookieSession?.userId),
      });
    }

    case 'auth.getUser': {
      if (!userId) return NextResponse.json({ data: { user: null }, error: null });
      const user = findLocalUserById(userId);
      return NextResponse.json({
        data: { user: user ? toSupabaseUser(user) : null },
        error: null,
      });
    }

    case 'auth.getSession': {
      if (!userId) return NextResponse.json({ data: { session: null }, error: null });
      const user = findLocalUserById(userId);
      if (!user) return NextResponse.json({ data: { session: null }, error: null });
      const sbUser = toSupabaseUser(user);
      return NextResponse.json({
        data: {
          session: {
            access_token: rawToken ?? 'local-hybrid-token',
            refresh_token: 'local-hybrid-refresh',
            token_type: 'bearer',
            expires_in: 3600,
            user: sbUser,
          },
        },
        error: null,
      });
    }

    case 'auth.signInWithPassword': {
      const email = String(body.email ?? '');
      const password = String(body.password ?? '');
      const res = authenticateLocalUser({ email, password });
      if (!res.user) {
        return NextResponse.json({
          data: { user: null, session: null },
          error: { message: res.error || 'E-mail ou senha inválidos.' },
        });
      }
      const token = await signLocalSession({
        userId: res.user.id,
        email: res.user.email,
        fullName: res.user.full_name,
      });
      const sbUser = toSupabaseUser(res.user);
      const response = NextResponse.json({
        data: {
          user: sbUser,
          session: {
            access_token: token,
            refresh_token: 'local-hybrid-refresh',
            token_type: 'bearer',
            expires_in: 3600,
            user: sbUser,
          },
        },
        error: null,
      });
      response.cookies.set(LOCAL_SESSION_COOKIE, token, cookieOptions(request));
      return response;
    }

    case 'auth.signUp': {
      const email = String(body.email ?? '');
      const password = String(body.password ?? '');
      const fullName = typeof body.fullName === 'string' ? body.fullName : undefined;
      const res = registerLocalUser({ email, password, fullName });
      if (!res.user) {
        return NextResponse.json({
          data: { user: null, session: null },
          error: { message: res.error || 'Não foi possível criar a conta.' },
        });
      }
      const token = await signLocalSession({
        userId: res.user.id,
        email: res.user.email,
        fullName: res.user.full_name,
      });
      const sbUser = toSupabaseUser(res.user);
      const response = NextResponse.json({
        data: {
          user: sbUser,
          session: {
            access_token: token,
            refresh_token: 'local-hybrid-refresh',
            token_type: 'bearer',
            expires_in: 3600,
            user: sbUser,
          },
        },
        error: null,
      });
      response.cookies.set(LOCAL_SESSION_COOKIE, token, cookieOptions(request));
      return response;
    }

    case 'auth.signOut': {
      const response = NextResponse.json({ error: null });
      response.cookies.set(LOCAL_SESSION_COOKIE, '', cookieOptions(request, 0));
      return response;
    }

    case 'auth.updateUser': {
      if (!userId) {
        return NextResponse.json({
          data: { user: null },
          error: { message: 'Você precisa estar conectado para atualizar o perfil.' },
        });
      }
      const res = updateLocalUser(userId, {
        password: typeof body.password === 'string' ? body.password : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        data:
          body.data && typeof body.data === 'object'
            ? (body.data as Record<string, unknown>)
            : undefined,
      });
      if (!res.user) {
        return NextResponse.json({
          data: { user: null },
          error: { message: res.error || 'Falha ao atualizar usuário.' },
        });
      }
      const token = await signLocalSession({
        userId: res.user.id,
        email: res.user.email,
        fullName: res.user.full_name,
      });
      const response = NextResponse.json({
        data: { user: toSupabaseUser(res.user), sessionToken: token },
        error: null,
      });
      response.cookies.set(LOCAL_SESSION_COOKIE, token, cookieOptions(request));
      return response;
    }

    case 'auth.resetPasswordForEmail': {
      const email = String(body.email ?? '');
      const found = findLocalUserByEmail(email);
      if (!found) {
        // Keep standard non-enumerating success response
        return NextResponse.json({ data: {}, error: null });
      }
      const token = await signLocalSession({
        userId: found.id,
        email: found.email,
        fullName: found.full_name,
      });
      const response = NextResponse.json({
        data: { localRecoveryReady: true, sessionToken: token },
        error: null,
      });
      response.cookies.set(LOCAL_SESSION_COOKIE, token, cookieOptions(request));
      return response;
    }

    case 'query': {
      const payload = body.payload as LocalQueryPayload | undefined;
      if (!payload || typeof payload.table !== 'string') {
        return NextResponse.json(
          { data: null, error: { message: 'Consulta inválida.' } },
          { status: 400 }
        );
      }
      const result = executeLocalQuery(payload, userId, false);
      return NextResponse.json(result);
    }

    case 'rpc': {
      const fn = String(body.fn ?? '');
      const args =
        body.args && typeof body.args === 'object'
          ? (body.args as Record<string, unknown>)
          : {};
      const result = executeLocalRpc(fn, args, userId);
      return NextResponse.json(result);
    }

    case 'storage.upload': {
      const bucket = String(body.bucket ?? 'uploads');
      const filePath = String(body.path ?? '');
      const dataUrl = String(body.dataUrl ?? '');
      const contentType = String(body.contentType ?? 'application/octet-stream');
      if (!filePath || !dataUrl) {
        return NextResponse.json({
          data: null,
          error: { message: 'Arquivo inválido para upload.' },
        });
      }
      const publicUrl = storeLocalFile(bucket, filePath, dataUrl, contentType);
      return NextResponse.json({
        data: { path: filePath, publicUrl },
        error: null,
      });
    }

    case 'storage.remove': {
      const bucket = String(body.bucket ?? 'uploads');
      const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
      removeLocalFiles(bucket, paths);
      return NextResponse.json({ data: [], error: null });
    }

    default:
      return NextResponse.json(
        { data: null, error: { message: `Operação desconhecida: ${body.op}` } },
        { status: 400 }
      );
  }
}
