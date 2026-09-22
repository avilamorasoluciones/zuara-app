import { withSupabase } from 'npm:@supabase/server@^1';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { scryptSync, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function syntheticEmail(usuario: string) {
  const bytes = new TextEncoder().encode(usuario);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${encoded}@auth.zuara.app`.toLowerCase();
}

function werkzeugScryptHash(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const derived = scryptSync(password, salt, 64, {
    N: 32768, r: 8, p: 1, maxmem: 132 * 32768 * 8
  });
  return `scrypt:32768:8:1$${salt}$${Buffer.from(derived).toString('hex')}`;
}

function nowCaracas() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Caracas',
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date()).replace(',', '');
}

const TABLES = new Set([
  'clientes','proveedores','almacenes','categorias','productos',
  'historico_tasas','historico_coberturas','notas_credito','ventas'
]);

const PERMISO_TABLA: Record<string,string> = {
  clientes:'clientes', proveedores:'proveedores', almacenes:'almacenes',
  categorias:'categorias', productos:'productos',
  historico_tasas:'parametros', historico_coberturas:'parametros',
  notas_credito:'historial_ventas', ventas:'ventas'
};

function tienePermiso(user: any, permiso: string) {
  if (user?.es_admin) return true;
  try {
    const p = typeof user.permisos === 'string' ? JSON.parse(user.permisos || '[]') : (user.permisos || []);
    return Array.isArray(p) && (p.includes(permiso) || (permiso === 'agregar_tasa' && p.includes('parametros')));
  } catch (_) { return false; }
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    try {
      const input = await req.json();
      const path = String(input?.path || '');
      const method = String(input?.method || 'GET').toUpperCase();
      const body = input?.body ?? {};
      const pathname = path.split('?')[0];

      const { data: appUser, error: userError } = await ctx.supabaseAdmin
        .from('usuarios')
        .select('id,nombre,usuario,activo,es_admin,permisos,protegido,auth_user_id')
        .eq('auth_user_id', ctx.userClaims?.id)
        .maybeSingle();

      if (userError) throw userError;
      if (!appUser || !appUser.activo) return json({ error: 'Sesión no válida.' }, 401);

      if (method === 'GET' && pathname === '/api/auth/sesion') {
        return json({
          autenticado:true,
          id:appUser.id,
          nombre:appUser.nombre,
          usuario:appUser.usuario,
          es_admin:Boolean(appUser.es_admin),
          permisos:appUser.permisos || '[]'
        });
      }

      if (method === 'GET' && pathname === '/api/resumen') {
        const tables=['clientes','proveedores','productos','ventas'];
        const counts:any = {};
        for (const table of tables) {
          const {count,error}=await ctx.supabaseAdmin.from(table).select('*',{count:'exact',head:true});
          if(error) throw error;
          counts[table]=count||0;
        }
        const {data:clientes}=await ctx.supabaseAdmin.from('clientes').select('id,documento');
        const {data:productos}=await ctx.supabaseAdmin.from('productos').select('id,stock_minimo');
        const {data:movs}=await ctx.supabaseAdmin.from('movimientos').select('producto_id,tipo,cantidad');
        const stock:any={};
        for(const m of (movs||[])){
          const k=String(m.producto_id);
          const delta=['Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada'].includes(m.tipo)
            ? Number(m.cantidad||0)
            : ['Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida'].includes(m.tipo)
              ? -Number(m.cantidad||0):0;
          stock[k]=(stock[k]||0)+delta;
        }
        const stock_bajo=(productos||[]).filter((p:any)=>(stock[String(p.id)]||0)<=Number(p.stock_minimo||0)).length;
        const clientes_pendientes=(clientes||[]).filter((c:any)=>!c.documento || c.documento==='PENDIENTE').length;
        return json({conteo:counts,notificaciones:{clientes_pendientes,stock_bajo}});
      }

      if (method === 'GET' && pathname === '/api/existencias') {
        if (!tienePermiso(appUser,'existencias') && !tienePermiso(appUser,'kardex') && !tienePermiso(appUser,'productos')) {
          return json({error:'No es posible realizar esta operación.'},403);
        }
        const { data, error } = await ctx.supabase.rpc('zuara_existencias');
        if (error) return json({error:error.message},400);
        return json(data || []);
      }

      if (method === 'GET' && pathname === '/api/lista_precios_data') {
        const url = new URL(req.url);
        const requestedDate = url.searchParams.get('fecha') || '';
        const hoy = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        const fecha = appUser.es_admin && requestedDate ? requestedDate : hoy;
        const {data:cob,error:ce} = await ctx.supabaseAdmin.from('historico_coberturas')
          .select('porcentaje_cobertura,factor_proteccion').eq('estado','ACTIVO').order('id',{ascending:false}).limit(1).maybeSingle();
        if (ce) throw ce;
        const {data:tasa,error:te} = await ctx.supabaseAdmin.from('historico_tasas')
          .select('fecha,hora,binance,euro_bcv').eq('fecha',fecha).order('hora',{ascending:false}).limit(1).maybeSingle();
        if (te) throw te;
        const {data:prods,error:pe} = await ctx.supabaseAdmin.from('productos')
          .select('id,codigo_barras,descripcion,unidad_medida,precio_usd,categoria_id,categorias(nombre)').eq('estado','ACTIVO');
        if (pe) throw pe;
        const factor=Number(cob?.factor_proteccion||1);
        const cobertura=Number(cob?.porcentaje_cobertura||0);
        const bin=Number(tasa?.binance||0), eur=Number(tasa?.euro_bcv||0);
        const brecha=eur>0?bin/eur-1:0;
        const estado=!tasa?'FALTAN_TASAS':brecha>cobertura?'MERCADO_VOLATIL':brecha>0?'PRECIO_SEGURO_PRECAUCION':'PRECIO_SEGURO_EXCELENTE';
        const etiqueta=!tasa?'REGISTRE TASA DEL DÍA':brecha>cobertura?'MERCADO VOLÁTIL / AJUSTAR PRECIO':'PRECIO SEGURO';
        const productos=(prods||[]).map((p:any)=>{
          const usd=Number(p.precio_usd||0);
          let eurCom=usd*factor;
          eurCom=Math.round((eurCom+Number.EPSILON)*100)/100;
          const entero=Math.round(eurCom);
          if (eurCom<entero && entero-eurCom<=0.01) eurCom=entero;
          return {id:p.id,codigo:p.codigo_barras,categoria:p.categorias?.nombre||'N/A',descripcion:p.descripcion,
            unidad_medida:p.unidad_medida,precio_usd:usd,precio_eur:eurCom,
            precio_bs:Math.round(eurCom*eur*100)/100,estado_semaforo:estado,etiqueta_semaforo:etiqueta};
        });
        return json({tasas:{fecha:tasa?.fecha||fecha,hora:tasa?.hora||'--:--',binance:bin,euro_bcv:eur,brecha,
          cobertura_activa:cobertura,registrada_hoy:Boolean(tasa),fecha_consultada:fecha,es_admin:Boolean(appUser.es_admin)},productos});
      }

      if (method === 'GET' && pathname === '/api/productos') {
        if (!tienePermiso(appUser,'productos')) return json({error:'No es posible realizar esta operación.'},403);
        const {data,error}=await ctx.supabaseAdmin.from('productos')
          .select('*,categorias(nombre),proveedores(nombre)').order('id',{ascending:false});
        if(error) throw error;
        return json((data||[]).map((p:any)=>({...p,categoria_nombre:p.categorias?.nombre||null,proveedor_nombre:p.proveedores?.nombre||null})));
      }

      if (method === 'GET' && (pathname === '/api/stock_almacenes' || pathname.startsWith('/api/stock_almacenes/'))) {
        if (!tienePermiso(appUser,'productos') && !tienePermiso(appUser,'existencias') && !tienePermiso(appUser,'kardex')) {
          return json({error:'No es posible realizar esta operación.'},403);
        }
        const id=Number(pathname.split('/').pop());
        const {data:movs,error:me}=await ctx.supabaseAdmin.from('movimientos').select('*').eq('producto_id',id);
        if(me) throw me;
        const {data:alm,error:ae}=await ctx.supabaseAdmin.from('almacenes').select('id,nombre');
        if(ae) throw ae;
        const result=(alm||[]).map((a:any)=>({
          ...a,
          stock:(movs||[]).reduce((s:any,m:any)=>s+
            (Number(m.almacen_destino_id)===Number(a.id)?Number(m.cantidad||0):
             Number(m.almacen_origen_id)===Number(a.id)?-Number(m.cantidad||0):0),0)
        }));
        return json(result);
      }

      // Operaciones críticas: una sola transacción PostgreSQL.
      const mutationMap: Record<string,string> = {
        'POST /api/movimientos':'registrar_movimiento',
        'POST /api/ventas':'registrar_venta',
        'POST /api/devoluciones':'registrar_devolucion',
        'POST /api/configuracion':'guardar_configuracion',
        'POST /api/tasas/upload':'upload_tasas'
      };

      let action = mutationMap[`${method} ${pathname}`];
      if (pathname.startsWith('/api/existencias/') && method === 'POST') action = 'corregir_existencia';

      if (action) {
        const { data, error } = await ctx.supabase.rpc('zuara_mutate', {
          p_action: action,
          p_payload: body
        });
        if (error) return json({ error: error.message }, 400);
        if (data?.status_code) return json({ error: data.error }, Number(data.status_code));
        if (data?.error) return json({ error: data.error }, Number(data.status_code || 400));
        return json(data || { status:'ok' });
      }

      // Borrado de ventas conserva la lógica de la versión Flask: elimina
      // movimientos y detalle asociados al consecutivo, dentro de la misma RPC.
      const ventaDelete = pathname.match(/^\/api\/ventas\/(\d+)$/);
      if (ventaDelete && method === 'DELETE') {
        const { data: venta, error: ve } = await ctx.supabaseAdmin
          .from('ventas').select('consecutivo').eq('id', Number(ventaDelete[1])).maybeSingle();
        if (ve) throw ve;
        if (!venta) return json({ error:'La venta indicada no existe.' },404);
        const { data, error } = await ctx.supabase.rpc('zuara_mutate', {
          p_action:'delete_venta', p_payload:{consecutivo:venta.consecutivo}
        });
        if (error) return json({error:error.message},400);
        if (data?.error) return json({error:data.error},Number(data.status_code||400));
        return json(data);
      }

      // Gestión de usuarios: Supabase Auth + tabla de negocio se actualizan juntas
      // desde este entorno confiable; la clave secreta nunca llega al navegador.
      if (pathname === '/api/usuarios' || pathname.startsWith('/api/usuarios/')) {
        if (!tienePermiso(appUser,'usuarios')) return json({error:'No es posible realizar esta operación.'},403);
        const idMatch = pathname.match(/^\/api\/usuarios\/(\d+)$/);
        const id = idMatch ? Number(idMatch[1]) : null;

        if (method === 'POST') {
          const password = String(body?.contrasena || '');
          const usuario = String(body?.usuario || '').trim();
          if (!usuario || !password) return json({error:'Usuario y contraseña son obligatorios.'},400);
          const email = syntheticEmail(usuario);
          const {data:created,error:ce} = await ctx.supabaseAdmin.auth.admin.createUser({
            email,password,email_confirm:true,user_metadata:{usuario,nombre:body?.nombre || ''}
          });
          if (ce) return json({error:ce.message},400);
          const {error:ue} = await ctx.supabaseAdmin.from('usuarios').insert({
            nombre:body?.nombre || '',usuario,contrasena:werkzeugScryptHash(password),
            activo:body?.activo !== false,es_admin:Boolean(body?.es_admin),
            permisos:JSON.stringify(body?.permisos || []),protegido:false,
            fecha_registro:nowCaracas(),auth_user_id:created.user.id
          });
          if (ue) {
            await ctx.supabaseAdmin.auth.admin.deleteUser(created.user.id);
            return json({error:ue.message},400);
          }
          return json({status:'ok'});
        }

        if (!id) return json({error:'Usuario no encontrado.'},404);
        const {data:target,error:te} = await ctx.supabaseAdmin.from('usuarios').select('*').eq('id',id).maybeSingle();
        if (te) throw te;
        if (!target) return json({error:'Usuario no encontrado.'},404);

        if (method === 'PUT') {
          const willAdmin = Boolean(body?.es_admin);
          const willActive = body?.activo !== false;
          if (target.es_admin && target.activo && (!willAdmin || !willActive)) {
            const {count} = await ctx.supabaseAdmin.from('usuarios').select('id',{count:'exact',head:true}).eq('es_admin',true).eq('activo',true);
            if ((count || 0) <= 1) return json({error:'Debe permanecer al menos un administrador activo en el sistema.'},400);
          }

          const nextUsuario = String(body?.usuario || target.usuario).trim();
          const updates:any = {
            nombre:body?.nombre ?? target.nombre, usuario:nextUsuario,
            activo:willActive, es_admin:willAdmin,
            permisos:JSON.stringify(body?.permisos || [])
          };

          const password = String(body?.contrasena || '');
          if (password) {
            updates.contrasena = werkzeugScryptHash(password);
          }

          if (target.auth_user_id) {
            const authUpdates:any = {
              email:syntheticEmail(nextUsuario),
              email_confirm:true,
              user_metadata:{usuario:nextUsuario,nombre:body?.nombre ?? target.nombre}
            };
            if (password) authUpdates.password = password;
            const {error:ae} = await ctx.supabaseAdmin.auth.admin.updateUserById(target.auth_user_id,authUpdates);
            if (ae) return json({error:ae.message},400);
          } else if (password) {
            const {data:created,error:ae} = await ctx.supabaseAdmin.auth.admin.createUser({
              email:syntheticEmail(nextUsuario),password,email_confirm:true,
              user_metadata:{usuario:nextUsuario,nombre:body?.nombre ?? target.nombre}
            });
            if (ae) return json({error:ae.message},400);
            updates.auth_user_id=created.user.id;
          }

          const {error:ue} = await ctx.supabaseAdmin.from('usuarios').update(updates).eq('id',id);
          if (ue) return json({error:ue.message},400);
          return json({status:'ok'});
        }

        if (method === 'DELETE') {
          if (target.protegido) return json({status:'ok'});
          if (target.es_admin && target.activo) {
            const {count} = await ctx.supabaseAdmin.from('usuarios').select('id',{count:'exact',head:true}).eq('es_admin',true).eq('activo',true);
            if ((count || 0) <= 1) return json({error:'No se puede eliminar el último administrador activo.'},400);
          }
          const {error:de} = await ctx.supabaseAdmin.from('usuarios').delete().eq('id',id);
          if (de) return json({error:de.message},400);
          if (target.auth_user_id) await ctx.supabaseAdmin.auth.admin.deleteUser(target.auth_user_id);
          return json({status:'ok'});
        }
      }

      // CRUD simple: clientes, proveedores, almacenes, categorías y productos.
      const m = pathname.match(/^\/api\/([a-z_]+)(?:\/(\d+))?$/);
      if (m) {
        const legacy = m[1];
        const id = m[2] ? Number(m[2]) : null;
        const tabla = legacy === 'tasas' ? 'historico_tasas' : legacy === 'coberturas' ? 'historico_coberturas' : legacy;
        if (!TABLES.has(tabla)) return json({error:'Tabla no permitida'},403);

        const permiso = PERMISO_TABLA[tabla];
        if (method !== 'GET' && permiso && !tienePermiso(appUser,permiso)) {
          return json({error:'No es posible realizar esta operación.'},403);
        }
        if (method === 'GET' && permiso && !tienePermiso(appUser,permiso)) {
          return json({error:'No es posible realizar esta operación.'},403);
        }

        if (method === 'GET') {
          let q:any = ctx.supabase.from(tabla).select('*').order('id',{ascending:false});
          if (tabla==='historico_tasas') q=q.order('fecha',{ascending:false}).order('hora',{ascending:false});
          if (id) q=q.eq('id',id);
          const {data,error}=await q;
          if(error) throw error;
          return json(id ? (data?.[0] || null) : (data || []));
        }

        if (method === 'POST') {
          const payload:any = {...body};
          delete payload.id;
          payload.fecha_registro = nowCaracas();
          payload.registrado_por = appUser.nombre || appUser.usuario;
          if (tabla==='historico_tasas') {
            payload.brecha = Number(payload.euro_bcv)>0 ? Number(payload.binance||0)/Number(payload.euro_bcv)-1 : 0;
          }
          const {error}=await ctx.supabase.from(tabla).insert(payload);
          if(error) throw error;
          return json({status:'ok'});
        }

        if (method === 'PUT' && id) {
          const payload:any = {...body}; delete payload.id;
          if (tabla==='historico_tasas') {
            payload.brecha = Number(payload.euro_bcv)>0 ? Number(payload.binance||0)/Number(payload.euro_bcv)-1 : 0;
          }
          const {error}=await ctx.supabase.from(tabla).update(payload).eq('id',id);
          if(error) throw error;
          return json({status:'ok'});
        }

        if (method === 'DELETE' && id) {
          const {error}=await ctx.supabase.from(tabla).delete().eq('id',id);
          if(error) throw error;
          return json({status:'ok'});
        }
      }

      return json({error:'Ruta no implementada en el adaptador Supabase.'},404);
    } catch (error) {
      console.error('ZUARA API error', error);
      return json({error:error instanceof Error ? error.message : 'Error interno.'},500);
    }
  })
};
