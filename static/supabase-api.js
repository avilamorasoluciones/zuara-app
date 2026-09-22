// ZUARA APP — puente de compatibilidad para convertir la UI Flask en una SPA estática.
// Mantiene las llamadas /api/... que ya usa main.js, pero las dirige a Supabase.
// La UI no necesita saber si el origen es Flask o Supabase.

(function () {
  'use strict';

  if (!window.supabase) {
    console.error('Supabase JS no fue cargado.');
    return;
  }

  const nativeFetch = window.fetch.bind(window);
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  window.supabaseClient = supabaseClient;
  window.zuaraSupabase = supabaseClient;

  const COMPLEX_ENDPOINTS = new Set([
    'POST /api/movimientos',
    'POST /api/existencias/',
    'POST /api/ventas',
    'POST /api/devoluciones',
    'POST /api/tasas/upload',
    'POST /api/usuarios',
    'PUT /api/usuarios/',
    'DELETE /api/usuarios/',
    'POST /api/clientes',
    'POST /api/proveedores',
    'POST /api/almacenes',
    'POST /api/categorias',
    'POST /api/productos',
    'PUT /api/clientes/',
    'PUT /api/proveedores/',
    'PUT /api/almacenes/',
    'PUT /api/categorias/',
    'PUT /api/productos/',
    'DELETE /api/clientes/',
    'DELETE /api/proveedores/',
    'DELETE /api/almacenes/',
    'DELETE /api/categorias/',
    'DELETE /api/productos/',
    'POST /api/configuracion',
    'PUT /api/tasas/',
    'DELETE /api/tasas/',
    'POST /api/tasas',
    'POST /api/coberturas',
    'PUT /api/coberturas/',
    'DELETE /api/coberturas/'
  ]);

  function responseJSON(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function normalizarError(error) {
    if (!error) return 'No se pudo completar la operación.';
    return error.message || error.error_description || String(error);
  }

  async function invokeApi(path, method, body, query) {
    const { data, error } = await supabaseClient.functions.invoke('zuara-api', {
      body: { path, method, body: body ?? null, query: query ?? {} }
    });
    if (error) {
      let detail = null;
      try { detail = error.context ? await error.context.json() : null; } catch (_) {}
      return responseJSON(detail || { error: normalizarError(error) }, error.status || 500);
    }
    return responseJSON(data ?? {});
  }

  async function fetchAllRows(tabla, select='*', orderColumn='id', ascending=false) {
    const all = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      let q = supabaseClient.from(tabla).select(select).order(orderColumn, { ascending }).range(from, from + pageSize - 1);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
    }
    return all;
  }
  window.fetchAllRows = fetchAllRows;

  function fechaHoyVenezuela() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Caracas',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function precioEurComercial(precioUsd, factor) {
    let valor = Number(precioUsd || 0) * Number(factor || 1);
    valor = Math.round((valor + Number.EPSILON) * 100) / 100;
    const entero = Math.round(valor);
    if (valor < entero && entero - valor <= 0.01) valor = entero;
    return valor;
  }

  async function apiGET(path, url) {
    const u = url || new URL(path, window.location.origin);
    const pathname = u.pathname;

    if (pathname === '/api/auth/sesion') {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return responseJSON({ autenticado: false }, 401);
      const { data, error } = await supabaseClient
        .from('usuarios')
        .select('id,nombre,usuario,activo,es_admin,permisos,protegido,fecha_registro,auth_user_id')
        .eq('auth_user_id', user.id)
        .maybeSingle();
      if (error || !data || !data.activo) {
        await supabaseClient.auth.signOut();
        return responseJSON({ autenticado: false }, 401);
      }
      return responseJSON({
        id: data.id, nombre: data.nombre, usuario: data.usuario,
        es_admin: data.es_admin, permisos: data.permisos
      });
    }

    if (pathname === '/api/auth/logout') {
      await supabaseClient.auth.signOut();
      return responseJSON({ status: 'ok' });
    }

    if (pathname === '/api/resumen') {
      const tablas = ['clientes','proveedores','productos','ventas'];
      const counts = await Promise.all(tablas.map(async t => {
        const { count, error } = await supabaseClient.from(t).select('*', { count: 'exact', head: true });
        return [t, error ? 0 : (count || 0)];
      }));
      const { data: clientesPend } = await supabaseClient.from('clientes').select('id').or('documento.eq.PENDIENTE,documento.eq.');
      const [productos, movimientos] = await Promise.all([
        fetchAllRows('productos','id,stock_minimo'),
        fetchAllRows('movimientos','producto_id,tipo,cantidad')
      ]);
      const suma = {};
      for (const m of movimientos) {
        const k = String(m.producto_id);
        suma[k] = (suma[k] || 0) + (
          ['Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada'].includes(m.tipo)
            ? Number(m.cantidad || 0)
            : ['Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida'].includes(m.tipo)
              ? -Number(m.cantidad || 0) : 0
        );
      }
      const stockBajo = productos.filter(p => (suma[String(p.id)] || 0) <= Number(p.stock_minimo || 0)).length;
      const conteo = Object.fromEntries(counts);
      return responseJSON({ conteo, notificaciones: { clientes_pendientes: clientesPend?.length || 0, stock_bajo: stockBajo } });
    }

    if (pathname === '/api/configuracion') {
      const { data, error } = await supabaseClient.from('configuracion').select('clave,valor');
      if (error) return responseJSON({ error: normalizarError(error) }, 500);
      return responseJSON(Object.fromEntries((data || []).map(x => [x.clave, x.valor])));
    }

    if (pathname === '/api/existencias' || pathname === '/api/lista_precios_data') {
      return invokeApi(pathname, 'GET', null, Object.fromEntries(u.searchParams.entries()));
    }

    if (pathname === '/api/existencias') {
      const [productos, movimientos] = await Promise.all([
        fetchAllRows('productos','*'),
        fetchAllRows('movimientos','*')
      ]);
      const movPorProducto = new Map();
      for (const m of movimientos) {
        const arr = movPorProducto.get(m.producto_id) || [];
        arr.push(m); movPorProducto.set(m.producto_id, arr);
      }
      const entradas = new Set(['Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada']);
      const salidas = new Set(['Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida']);
      const resultados = productos.map(p => {
        const ms = movPorProducto.get(p.id) || [];
        const stockFisico = ms.reduce((a,m) => a + (entradas.has(m.tipo) ? Number(m.cantidad||0) : salidas.has(m.tipo) ? -Number(m.cantidad||0) : 0), 0);
        const devol = ms.reduce((a,m) => a + (Number(m.almacen_destino_id) === 9999 ? Number(m.cantidad||0) : Number(m.almacen_origen_id) === 9999 ? -Number(m.cantidad||0) : 0), 0);
        const merma = ms.reduce((a,m) => a + (Number(m.almacen_destino_id) === 9998 ? Number(m.cantidad||0) : Number(m.almacen_origen_id) === 9998 ? -Number(m.cantidad||0) : 0), 0);
        const cargas = ms.filter(m => ['Inventario Inicial','Compra'].includes(m.tipo)).sort((a,b) => Number(b.id)-Number(a.id));
        const costos = ms.filter(m => ['Inventario Inicial','Compra','Ajuste administrativo - Entrada','Ajuste administrativo - Salida'].includes(m.tipo)).sort((a,b)=>Number(b.id)-Number(a.id));
        const ultima = cargas[0] || {};
        const costo = Number(costos[0]?.costo_unitario || 0);
        return {
          id:p.id, codigo_barras:p.codigo_barras, descripcion:p.descripcion, stock_minimo:p.stock_minimo,
          unidad_medida:p.unidad_medida, estado:p.estado, stock_fisico_total:stockFisico,
          stock_devoluciones:devol, stock_merma:merma, stock_bloqueado:devol+merma,
          stock_disponible_venta:stockFisico-devol-merma, costo_unit:costo, precio_usd:Number(p.precio_usd||0),
          ultima_carga_id:ultima.id || null, ultima_carga_cantidad:ultima.cantidad || null,
          ultima_carga_fecha:ultima.fecha_registro || null, ultima_carga_documento:ultima.documento || null,
          total_costo:stockFisico*costo
        };
      }).sort((a,b)=>String(a.descripcion||'').localeCompare(String(b.descripcion||''),'es'));
      return responseJSON(resultados);
    }

    if (pathname === '/api/kardex') {
      const [movs, productos, almacenes] = await Promise.all([
        fetchAllRows('movimientos','*'),
        fetchAllRows('productos','id,descripcion'),
        fetchAllRows('almacenes','id,nombre')
      ]);
      const pm = new Map(productos.map(p=>[Number(p.id),p.descripcion]));
      const am = new Map(almacenes.map(a=>[Number(a.id),a.nombre]));
      return responseJSON(movs.map(m=>({
        ...m,
        producto_nombre: pm.get(Number(m.producto_id)) || 'Producto Eliminado',
        almacen_origen_nombre: am.get(Number(m.almacen_origen_id)) || null,
        almacen_destino_nombre: am.get(Number(m.almacen_destino_id)) || null
      })).sort((a,b)=>Number(b.id)-Number(a.id)));
    }

    if (pathname === '/api/lista_precios_data') {
      const params = u.searchParams;
      const { data: sesion } = await supabaseClient.auth.getUser();
      let esAdmin = false;
      if (sesion?.user) {
        const { data: usr } = await supabaseClient.from('usuarios').select('es_admin').eq('auth_user_id', sesion.user.id).maybeSingle();
        esAdmin = Boolean(usr?.es_admin);
      }
      const fecha = esAdmin && params.get('fecha') ? params.get('fecha') : fechaHoyVenezuela();
      const [{ data: cob }, { data: tasa }, { data: prods }] = await Promise.all([
        supabaseClient.from('historico_coberturas').select('porcentaje_cobertura,factor_proteccion').eq('estado','ACTIVO').order('id',{ascending:false}).limit(1).maybeSingle(),
        supabaseClient.from('historico_tasas').select('fecha,hora,binance,euro_bcv').eq('fecha',fecha).order('hora',{ascending:false}).limit(1).maybeSingle(),
        supabaseClient.from('productos').select('id,codigo_barras,descripcion,unidad_medida,precio_usd,categoria_id,categorias(nombre)').eq('estado','ACTIVO')
      ]);
      const factor = Number(cob?.factor_proteccion || 1);
      const cobertura = Number(cob?.porcentaje_cobertura || 0);
      const bin = Number(tasa?.binance || 0), eur = Number(tasa?.euro_bcv || 0);
      const brecha = eur > 0 ? bin / eur - 1 : 0;
      const estado = !tasa ? 'FALTAN_TASAS' : brecha > cobertura ? 'MERCADO_VOLATIL' : brecha > 0 ? 'PRECIO_SEGURO_PRECAUCION' : 'PRECIO_SEGURO_EXCELENTE';
      const etiqueta = !tasa ? 'REGISTRE TASA DEL DÍA' : brecha > cobertura ? 'MERCADO VOLÁTIL / AJUSTAR PRECIO' : 'PRECIO SEGURO';
      const productos = (prods || []).map(p => {
        const precioUsd=Number(p.precio_usd||0), precioEur=precioEurComercial(precioUsd,factor);
        return {id:p.id,codigo:p.codigo_barras,categoria:p.categorias?.nombre || 'N/A',descripcion:p.descripcion,unidad_medida:p.unidad_medida,precio_usd:precioUsd,precio_eur:precioEur,precio_bs:Math.round(precioEur*eur*100)/100,estado_semaforo:estado,etiqueta_semaforo:etiqueta};
      });
      return responseJSON({tasas:{fecha:tasa?.fecha || fecha,hora:tasa?.hora || '--:--',binance:bin,euro_bcv:eur,brecha,cobertura_activa:cobertura,registrada_hoy:Boolean(tasa),fecha_consultada:fecha,es_admin:esAdmin},productos});
    }

    if (pathname === '/api/stock_almacenes/' || pathname.startsWith('/api/stock_almacenes/')) {
      const id = Number(pathname.split('/').pop());
      const [movs, almacenes] = await Promise.all([
        fetchAllRows('movimientos','*'),
        fetchAllRows('almacenes','id,nombre')
      ]);
      const resultado = (almacenes || []).map(a => {
        const stock = movs.filter(m=>Number(m.producto_id)===id && (Number(m.almacen_destino_id)===Number(a.id) || Number(m.almacen_origen_id)===Number(a.id)))
          .reduce((s,m)=>s + (Number(m.almacen_destino_id)===Number(a.id) ? Number(m.cantidad||0) : -Number(m.cantidad||0)),0);
        return {...a,stock};
      });
      return responseJSON(resultado);
    }

    if (pathname.startsWith('/api/ventas/detalles/')) {
      const consecutivo = decodeURIComponent(pathname.split('/').pop());
      const { data, error } = await supabaseClient.from('detalle_nota_entrega').select('*,productos(descripcion,codigo_barras)').eq('consecutivo',consecutivo);
      if (error) return responseJSON({error:normalizarError(error)},500);
      return responseJSON((data||[]).map(d=>({...d,producto_nombre:d.productos?.descripcion || 'Producto Eliminado',codigo:d.productos?.codigo_barras || null})));
    }

    if (pathname.startsWith('/api/clientes/notas_credito/')) {
      const cli = decodeURIComponent(pathname.split('/').pop());
      const { data, error } = await supabaseClient.from('notas_credito').select('*').eq('cliente_nombre',cli).eq('estado','DISPONIBLE').order('id',{ascending:false});
      if (error) return responseJSON({error:normalizarError(error)},500);
      return responseJSON(data || []);
    }

    if (pathname.startsWith('/api/notas_credito/detalles/')) {
      const nc = decodeURIComponent(pathname.split('/').pop());
      const { data, error } = await supabaseClient.from('detalle_nota_credito').select('*,productos(descripcion,codigo_barras)').eq('consecutivo_nc',nc);
      if (error) return responseJSON({error:normalizarError(error)},500);
      return responseJSON((data||[]).map(d=>({...d,producto_nombre:d.productos?.descripcion || 'Producto Eliminado',codigo:d.productos?.codigo_barras || null})));
    }

    if (pathname.startsWith('/api/historico_precios/')) {
      const fecha = decodeURIComponent(pathname.split('/').pop());
      const { data, error } = await supabaseClient.from('historico_precios_dia').select('json_data').eq('fecha',fecha).maybeSingle();
      if (error) return responseJSON({error:normalizarError(error)},500);
      if (!data) return responseJSON({error:'No hay registros de precios para esta fecha.'},404);
      try { return responseJSON(JSON.parse(data.json_data)); } catch (_) { return responseJSON({error:'El histórico de precios no tiene un formato válido.'},500); }
    }

    if (pathname === '/api/tasas/brecha-maxima') {
      const ini = u.searchParams.get('fecha_inicio'), fin = u.searchParams.get('fecha_fin');
      let q = supabaseClient.from('historico_tasas').select('id,fecha,hora,binance,euro_bcv,registrado_por').order('fecha',{ascending:false}).order('hora',{ascending:false});
      if (ini) q=q.gte('fecha',ini);
      if (fin) q=q.lte('fecha',fin);
      const {data,error}=await q;
      if(error) return responseJSON({error:normalizarError(error)},500);
      const rows=(data||[]).map(x=>({...x,brecha:Number(x.euro_bcv)>0?Number(x.binance)/Number(x.euro_bcv)-1:0}));
      rows.sort((a,b)=>b.brecha-a.brecha);
      return responseJSON(rows[0] || {});
    }

    // CRUD GET simple.
    const m = pathname.match(/^\/api\/([a-z_]+)$/);
    if (m) {
      const tabla = m[1] === 'tasas' ? 'historico_tasas' : m[1] === 'coberturas' ? 'historico_coberturas' : m[1];
      const allowed = ['clientes','proveedores','almacenes','categorias','productos','historico_tasas','historico_coberturas','notas_credito','usuarios','ventas'];
      if (!allowed.includes(tabla)) return responseJSON({error:'Tabla no permitida'},403);
      let select='*';
      if(tabla==='productos') select='*,categorias(nombre),proveedores(nombre)';
      if(tabla==='usuarios') select='id,nombre,usuario,activo,es_admin,permisos,protegido,fecha_registro,auth_user_id';
      let data=await fetchAllRows(tabla,select);
      if(tabla==='productos') data=data.map(p=>({...p,categoria_nombre:p.categorias?.nombre || null,proveedor_nombre:p.proveedores?.nombre || null}));
      return responseJSON(data);
    }

    return responseJSON({error:'Ruta no implementada en el adaptador Supabase.'},404);
  }

  async function handleLogin(body) {
    const { data, error } = await supabaseClient.functions.invoke('zuara-login', { body });
    if (error) {
      let detail=null; try{detail=error.context?await error.context.json():null;}catch(_){}
      return responseJSON(detail || {error:normalizarError(error)}, error.status || 500);
    }
    return responseJSON(data || {});
  }

  window.fetch = async function(input, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input?.url || '';
    let u;
    try { u = new URL(url, window.location.origin); } catch (_) { return nativeFetch(input, init); }

    if (!u.pathname.startsWith('/api/')) return nativeFetch(input, init);

    // Auth endpoints.
    if (u.pathname === '/api/auth/login' && method === 'POST') {
      let body = init.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) {} }
      return handleLogin(body || {});
    }
    if (u.pathname === '/api/auth/logout') {
      await supabaseClient.auth.signOut();
      return responseJSON({status:'ok'});
    }
    if (method === 'GET') return apiGET(u.pathname, u);

    let body = init.body;
    if (body instanceof FormData) {
      const file = body.get('file');
      if (file && window.XLSX) {
        const ab = await file.arrayBuffer();
        const wb = XLSX.read(ab,{type:'array',cellDates:true});
        const ws=wb.Sheets[wb.SheetNames[0]];
        const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:null});
        const normalized = [];
        const toDate = (v) => {
          if (v instanceof Date) return v;
          if (typeof v === 'number' && XLSX.SSF?.parse_date_code) {
            const d = XLSX.SSF.parse_date_code(v);
            if (d) return new Date(Date.UTC(d.y,d.m-1,d.d,d.H||0,d.M||0,d.S||0));
          }
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? null : d;
        };
        for (const row of rows.slice(7)) {
          if (row[1] == null || row[1] === '') continue;
          const fechaObj = toDate(row[1]);
          if (!fechaObj) continue;
          const fecha = fechaObj.toISOString().slice(0,10);
          const horaObj = toDate(row[9]);
          const hora = horaObj ? horaObj.toISOString().slice(11,19) : String(row[9] || '').slice(0,8);
          normalized.push({
            fecha, hora,
            dolar_bcv:Number(row[2] || 0), binance:Number(row[3] || 0),
            bybit:Number(row[4] || 0), dolar_promedio:Number(row[5] || 0),
            euro_bcv:Number(row[6] || 0), zelle:Number(row[7] || 0),
            paypal:Number(row[8] || 0)
          });
        }
        body = { rows: normalized };
      } else body = {};
    } else if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }
    return invokeApi(u.pathname, method, body, Object.fromEntries(u.searchParams.entries()));
  };
})();
