import { withSupabase } from 'npm:@supabase/server@^1';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { scryptSync, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function syntheticEmail(usuario: string) {
  const encoded = btoa(unescape(encodeURIComponent(usuario)))
    .replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${encoded}@auth.zuara.app`.toLowerCase();
}

function hexEqual(aHex: string, b: Uint8Array) {
  if (!/^[0-9a-f]+$/i.test(aHex) || aHex.length !== b.length * 2) return false;
  const a = new Uint8Array(aHex.length / 2);
  for (let i=0;i<a.length;i++) a[i] = parseInt(aHex.slice(i*2,i*2+2),16);
  return timingSafeEqual(a,b);
}

function verifyWerkzeug(hash: string, password: string) {
  if (!hash || !password) return false;
  const parts = hash.split('$');
  if (parts.length !== 3) return false;
  const [method, salt, expected] = parts;

  try {
    if (method.startsWith('scrypt:')) {
      const [, nS, rS, pS] = method.split(':');
      const n=Number(nS), r=Number(rS), p=Number(pS);
      if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
      const derived = scryptSync(password, salt, 64, { N:n, r, p, maxmem: Math.max(128*n*r + 1024, 132*n*r*p) });
      return hexEqual(expected, derived);
    }
    if (method.startsWith('pbkdf2:')) {
      const [, algo, iterationsS] = method.split(':');
      const iterations=Number(iterationsS);
      if (!algo || !Number.isInteger(iterations) || iterations < 1) return false;
      const derived = pbkdf2Sync(password, salt, iterations, 32, algo);
      return hexEqual(expected, derived);
    }
  } catch (_) {}
  return false;
}

export default {
  fetch: withSupabase({ auth: 'publishable' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      const body = await req.json();
      const usuario = String(body?.usuario || '').trim();
      const password = String(body?.contrasena || '');
      if (!usuario || !password) return json({ error: 'Completa usuario y contraseña.' }, 400);

      const { data: row, error: rowError } = await ctx.supabaseAdmin
        .from('usuarios')
        .select('id,nombre,usuario,contrasena,activo,es_admin,permisos,protegido,fecha_registro,auth_user_id')
        .eq('usuario', usuario)
        .maybeSingle();

      if (rowError) throw rowError;
      if (!row) return json({ error: 'Usuario o contraseña incorrectos.' }, 401);
      if (!row.activo) return json({ error: 'El usuario se encuentra inactivo.' }, 401);

      const email = syntheticEmail(usuario);
      const client = createClient(
        Deno.env.get('SUPABASE_URL')!,
        JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default ||
          Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!
      );

      let authUserId = row.auth_user_id as string | null;

      if (!authUserId) {
        if (!verifyWerkzeug(String(row.contrasena || ''), password)) {
          return json({ error: 'Usuario o contraseña incorrectos.' }, 401);
        }
        const { data: created, error: createError } = await ctx.supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { usuario, nombre: row.nombre }
        });
        if (createError) throw createError;
        authUserId = created.user.id;
        const { error: linkError } = await ctx.supabaseAdmin
          .from('usuarios').update({ auth_user_id: authUserId }).eq('id', row.id);
        if (linkError) throw linkError;
      }

      let { data: signed, error: signError } = await client.auth.signInWithPassword({
        email, password
      });

      // Si una cuenta migrada ya tiene Auth pero la contraseña fue cambiada en
      // el legado, se valida el hash anterior y se sincroniza una sola vez.
      if (signError) {
        if (!verifyWerkzeug(String(row.contrasena || ''), password)) {
          return json({ error: 'Usuario o contraseña incorrectos.' }, 401);
        }
        const { error: updateAuthError } = await ctx.supabaseAdmin.auth.admin.updateUserById(
          authUserId!,
          { password, email, email_confirm: true, user_metadata: { usuario, nombre: row.nombre } }
        );
        if (updateAuthError) throw updateAuthError;
        const retry = await client.auth.signInWithPassword({ email, password });
        signed = retry.data;
        signError = retry.error;
      }

      if (signError || !signed?.session || !signed.user) {
        return json({ error: signError?.message || 'No se pudo iniciar la sesión.' }, 401);
      }

      let permisos: any = [];
      try { permisos = typeof row.permisos === 'string' ? JSON.parse(row.permisos || '[]') : (row.permisos || []); } catch (_) {}
      return json({
        id: row.id,
        nombre: row.nombre,
        usuario: row.usuario,
        es_admin: Boolean(row.es_admin),
        permisos,
        autenticado: true,
        session: signed.session
      });
    } catch (error) {
      console.error('ZUARA login error', error);
      return json({ error: error instanceof Error ? error.message : 'Error de inicio de sesión.' }, 500);
    }
  })
};
