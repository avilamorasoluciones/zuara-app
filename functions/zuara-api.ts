import { Pool } from "npm:pg";
import { createHmac, scryptSync, timingSafeEqual, pbkdf2Sync } from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const JWT_SECRET = process.env.ZUARA_JWT_SECRET || process.env.DATABASE_URL || "zuara-local-secret";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

function json(data:any, status=200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
function b64u(input:string|Uint8Array) {
  const b = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  return b.toString("base64url");
}
function signToken(payload:any) {
  const head = b64u(JSON.stringify({alg:"HS256",typ:"JWT"}));
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", JWT_SECRET).update(head+"."+body).digest("base64url");
  return head+"."+body+"."+sig;
}
function verifyToken(token:string) {
  try {
    const [h,p,s] = token.split(".");
    if (!h || !p || !s) return null;
    const expected = createHmac("sha256", JWT_SECRET).update(h+"."+p).digest("base64url");
    if (expected.length !== s.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(s))) return null;
    const payload = JSON.parse(Buffer.from(p,"base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}
function verifyWerkzeug(password:string, hash:string) {
  try {
    if (!hash) return false;
    if (hash.startsWith("scrypt:")) {
      const [method,salt,hex] = hash.split("$");
      const [,N,r,p] = method.split(":").map((x:any,i:number)=>i?Number(x):x);
      const derived = scryptSync(password, salt, 64, {N:Number(N),r:Number(r),p:Number(p),maxmem:132*Number(N)*Number(r)+1024});
      const stored = Buffer.from(hex,"hex");
      return stored.length === derived.length && timingSafeEqual(stored,derived);
    }
    if (hash.startsWith("pbkdf2:")) {
      const [method,salt,hex] = hash.split("$");
      const parts = method.split(":");
      const digest = parts[1] || "sha256";
      const iterations = Number(parts[2] || 600000);
      const derived = pbkdf2Sync(password,salt,iterations,32,digest);
      const stored = Buffer.from(hex,"hex");
      return stored.length === derived.length && timingSafeEqual(stored,derived);
    }
  } catch {}
  return false;
}
function permiso(user:any, name:string) {
  if (user.es_admin) return true;
  let p:any = user.permisos || [];
  try { if (typeof p === "string") p = JSON.parse(p); } catch { p=[]; }
  if (Array.isArray(p)) return p.includes(name) || (name==="agregar_tasa" && p.includes("parametros"));
  return Boolean(p?.[name] || (name==="agregar_tasa" && p?.parametros));
}
async function appUserFromRequest(req:Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const claims = verifyToken(token);
  if (!claims?.uid) return null;
  const r = await pool.query("SELECT id,nombre,usuario,activo,es_admin,permisos,protegido FROM usuarios WHERE id=$1 LIMIT 1",[claims.uid]);
  const u = r.rows[0];
  return u?.activo ? u : null;
}
function nowCaracas() {
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"America/Caracas",dateStyle:"short",timeStyle:"medium"}).format(new Date()).replace(",","");
}
const TABLES = new Set(["clientes","proveedores","almacenes","categorias","productos","historico_tasas","historico_coberturas","notas_credito","ventas","usuarios","configuracion"]);
const PERM = {clientes:"clientes",proveedores:"proveedores",almacenes:"almacenes",categorias:"categorias",productos:"productos",historico_tasas:"parametros",historico_coberturas:"parametros",notas_credito:"historial_ventas",ventas:"ventas",usuarios:"usuarios",configuracion:"configuracion"} as Record<string,string>;

async function rpc(action:string,payload:any) {
  const r = await pool.query("SELECT * FROM zuara_mutate($1,$2::jsonb)",[action,JSON.stringify(payload ?? {})]);
  return r.rows[0]?.zuara_mutate ?? r.rows[0] ?? {status:"ok"};
}

export default {
  async fetch(req:Request) {
    if (req.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/,"") || "/";
    try {
      if (req.method === "POST" && path === "/api/auth/login") {
        const body = await req.json().catch(()=>({}));
        const usuario = String(body.usuario||"").trim();
        const contrasena = String(body.contrasena||"");
        const r = await pool.query("SELECT id,nombre,usuario,contrasena,activo,es_admin,permisos,protegido FROM usuarios WHERE LOWER(usuario)=LOWER($1) LIMIT 1",[usuario]);
        const u = r.rows[0];
        if (!u || !u.activo || !verifyWerkzeug(contrasena,u.contrasena)) return json({error:"Usuario o contraseña inválidos."},401);
        const token = signToken({uid:u.id,exp:Math.floor(Date.now()/1000)+60*60*12});
        return json({autenticado:true,token,id:u.id,nombre:u.nombre,usuario:u.usuario,es_admin:Boolean(u.es_admin),permisos:u.permisos||"[]"});
      }

      if (path === "/api/auth/logout") return json({status:"ok"});

      const user = await appUserFromRequest(req);
      if (!user) return json({error:"Sesión no válida."},401);

      if (req.method === "GET" && path === "/api/auth/sesion")
        return json({autenticado:true,id:user.id,nombre:user.nombre,usuario:user.usuario,es_admin:Boolean(user.es_admin),permisos:user.permisos||"[]"});

      if (req.method === "GET" && path === "/api/resumen") {
        const tables=["clientes","proveedores","productos","ventas"];
        const conteo:any={};
        for (const t of tables) conteo[t]=Number((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
        const clientes=(await pool.query("SELECT id,documento FROM clientes")).rows;
        const productos=(await pool.query("SELECT id,stock_minimo FROM productos")).rows;
        const movs=(await pool.query("SELECT producto_id,tipo,cantidad FROM movimientos")).rows;
        const stock:any={};
        for(const m of movs){ const k=String(m.producto_id); const d=["Inventario Inicial","Compra","Devolución por venta","Ajuste administrativo - Entrada"].includes(m.tipo)?Number(m.cantidad||0):["Venta","Descarga por daño/motivo","Devolución por compra","Ajuste administrativo - Salida"].includes(m.tipo)?-Number(m.cantidad||0):0; stock[k]=(stock[k]||0)+d; }
        conteo.existencias=productos.length;
        const stock_bajo=productos.filter((p:any)=>(stock[String(p.id)]||0)<=Number(p.stock_minimo||0)).length;
        const clientes_pendientes=clientes.filter((c:any)=>!c.documento||c.documento==="PENDIENTE").length;
        return json({conteo,notificaciones:{clientes_pendientes,stock_bajo}});
      }

      if (req.method === "GET" && path === "/api/kardex") {
        if(!permiso(user,"kardex")) return json({error:"No es posible realizar esta operación."},403);
        const r=await pool.query(`SELECT m.*,p.descripcion AS producto_nombre,ao.nombre AS almacen_origen_nombre,ad.nombre AS almacen_destino_nombre
          FROM movimientos m LEFT JOIN productos p ON p.id=m.producto_id
          LEFT JOIN almacenes ao ON ao.id=m.almacen_origen_id LEFT JOIN almacenes ad ON ad.id=m.almacen_destino_id
          ORDER BY m.id DESC`);
        return json(r.rows);
      }

      if (req.method === "GET" && path === "/api/existencias") {
        if(!permiso(user,"existencias")&&!permiso(user,"kardex")&&!permiso(user,"productos")) return json({error:"No es posible realizar esta operación."},403);
        try { const r=await pool.query("SELECT * FROM zuara_existencias()"); return json(r.rows.map((x:any)=>x.zuara_existencias??x)); }
        catch { return json([]); }
      }

      if (req.method === "GET" && path === "/api/lista_precios_data") {
        const qdate=url.searchParams.get("fecha")||"";
        const hoy=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
        const fecha=user.es_admin&&qdate?qdate:hoy;
        const cob=(await pool.query("SELECT porcentaje_cobertura,factor_proteccion FROM historico_coberturas WHERE estado='ACTIVO' ORDER BY id DESC LIMIT 1")).rows[0];
        const tasa=(await pool.query("SELECT fecha,hora,binance,euro_bcv FROM historico_tasas WHERE fecha=$1 ORDER BY hora DESC LIMIT 1",[fecha])).rows[0];
        const prods=(await pool.query("SELECT p.*,c.nombre AS categoria_nombre FROM productos p LEFT JOIN categorias c ON c.id=p.categoria_id WHERE p.estado='ACTIVO' ORDER BY p.id DESC")).rows;
        const factor=Number(cob?.factor_proteccion||1), cobertura=Number(cob?.porcentaje_cobertura||0), bin=Number(tasa?.binance||0), eur=Number(tasa?.euro_bcv||0), brecha=eur>0?bin/eur-1:0;
        const estado=!tasa?"FALTAN_TASAS":brecha>cobertura?"MERCADO_VOLATIL":brecha>0?"PRECIO_SEGURO_PRECAUCION":"PRECIO_SEGURO_EXCELENTE";
        const etiqueta=!tasa?"REGISTRE TASA DEL DÍA":brecha>cobertura?"MERCADO VOLÁTIL / AJUSTAR PRECIO":"PRECIO SEGURO";
        const productos=prods.map((p:any)=>{let pe=Math.round(Number(p.precio_usd||0)*factor*100)/100;return {...p,codigo:p.codigo_barras,categoria:p.categoria_nombre||"N/A",precio_eur:pe,precio_bs:Math.round(pe*eur*100)/100,estado_semaforo:estado,etiqueta_semaforo:etiqueta};});
        return json({tasas:{fecha:tasa?.fecha||fecha,hora:tasa?.hora||"--:--",binance:bin,euro_bcv:eur,brecha,cobertura_activa:cobertura,registrada_hoy:Boolean(tasa),fecha_consultada:fecha,es_admin:Boolean(user.es_admin)},productos});
      }

      const stockMatch=path.match(/^\/api\/stock_almacenes\/(\d+)$/);
      if(req.method==="GET" && (path==="/api/stock_almacenes"||stockMatch)){
        if(!permiso(user,"productos")&&!permiso(user,"existencias")&&!permiso(user,"kardex")) return json({error:"No es posible realizar esta operación."},403);
        const pid=stockMatch?Number(stockMatch[1]):null;
        const mov=pid?(await pool.query("SELECT * FROM movimientos WHERE producto_id=$1",[pid])).rows:[];
        const alms=(await pool.query("SELECT id,nombre FROM almacenes")).rows;
        return json(alms.map((a:any)=>({...a,stock:mov.reduce((s:number,m:any)=>s+(Number(m.almacen_destino_id)===Number(a.id)?Number(m.cantidad||0):Number(m.almacen_origen_id)===Number(a.id)?-Number(m.cantidad||0):0),0)})));
      }

      const mutation:Record<string,string>={"POST /api/movimientos":"registrar_movimiento","POST /api/ventas":"registrar_venta","POST /api/devoluciones":"registrar_devolucion","POST /api/configuracion":"guardar_configuracion","POST /api/tasas":"registrar_tasa","POST /api/tasas/upload":"upload_tasas"};
      let body:any={};
      if(req.method!=="GET") body=await req.json().catch(()=>({}));
      let action=mutation[`${req.method} ${path}`];
      if(req.method==="POST"&&/^\/api\/existencias\/\d+$/.test(path)) action="corregir_existencia";
      if(action){ const out=await rpc(action,body); if(out?.error)return json({error:out.error},Number(out.status_code||400)); return json(out); }

      const ventaDet=path.match(/^\/api\/ventas\/detalles\/(.+)$/);
      if(req.method==="GET"&&ventaDet){
        const r=await pool.query("SELECT * FROM detalle_nota_entrega WHERE consecutivo=$1 ORDER BY id",[decodeURIComponent(ventaDet[1])]);
        return json(r.rows);
      }
      const ncDet=path.match(/^\/api\/notas_credito\/detalles\/(.+)$/);
      if(req.method==="GET"&&ncDet){
        const r=await pool.query("SELECT * FROM detalle_nota_credito WHERE consecutivo_nc=$1 ORDER BY id",[decodeURIComponent(ncDet[1])]);
        return json(r.rows);
      }
      const cliNc=path.match(/^\/api\/clientes\/notas_credito\/(.+)$/);
      if(req.method==="GET"&&cliNc){
        const r=await pool.query("SELECT * FROM notas_credito WHERE cliente_nombre=$1 ORDER BY id DESC",[decodeURIComponent(cliNc[1])]);
        return json(r.rows);
      }

      const delVenta=path.match(/^\/api\/ventas\/(\d+)$/);
      if(req.method==="DELETE"&&delVenta){
        const v=(await pool.query("SELECT consecutivo FROM ventas WHERE id=$1",[Number(delVenta[1])])).rows[0];
        if(!v)return json({error:"La venta indicada no existe."},404);
        const out=await rpc("delete_venta",{consecutivo:v.consecutivo}); if(out?.error)return json({error:out.error},400); return json(out);
      }

      const m=path.match(/^\/api\/([a-z_]+)(?:\/(\d+))?$/);
      if(m){
        const legacy=m[1], id=m[2]?Number(m[2]):null;
        const table=legacy==="tasas"?"historico_tasas":legacy==="coberturas"?"historico_coberturas":legacy;
        if(!TABLES.has(table)) return json({error:"Tabla no permitida"},403);
        if(PERM[table]&&!permiso(user,PERM[table])) return json({error:"No es posible realizar esta operación."},403);

        if(req.method==="GET"){
          let sql=`SELECT * FROM ${table}`;
          const args:any[]=[];
          if(id){sql+=" WHERE id=$1";args.push(id);}
          sql+=" ORDER BY id DESC";
          const rows=(await pool.query(sql,args)).rows;
          if(table==="productos"){
            const cats=(await pool.query("SELECT id,nombre FROM categorias")).rows.reduce((a:any,x:any)=>(a[x.id]=x.nombre,a),{});
            const prov=(await pool.query("SELECT id,nombre FROM proveedores")).rows.reduce((a:any,x:any)=>(a[x.id]=x.nombre,a),{});
            return json(rows.map((p:any)=>({...p,categoria_nombre:cats[p.categoria_id]||null,proveedor_nombre:prov[p.proveedor_id]||null})));
          }
          return json(id?(rows[0]||null):rows);
        }
        if(req.method==="POST"){
          if(table==="usuarios") return json({error:"Use the usuarios UI after the Neon auth migration."},400);
          const cols=Object.keys(body||{}).filter(k=>k!=="id"&&/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
          const vals=cols.map(k=>body[k]);
          if(!cols.length)return json({error:"Datos vacíos."},400);
          const placeholders=cols.map((_,i)=>"$"+(i+1)).join(",");
          await pool.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`,vals);
          return json({status:"ok"});
        }
        if(req.method==="PUT"&&id){
          const cols=Object.keys(body||{}).filter(k=>k!=="id"&&/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
          const vals=cols.map(k=>body[k]);
          if(!cols.length)return json({error:"Datos vacíos."},400);
          await pool.query(`UPDATE ${table} SET ${cols.map((c,i)=>`${c}=$${i+1}`).join(",")} WHERE id=$${cols.length+1}`,[...vals,id]);
          return json({status:"ok"});
        }
        if(req.method==="DELETE"&&id){ await pool.query(`DELETE FROM ${table} WHERE id=$1`,[id]); return json({status:"ok"}); }
      }
      return json({error:"Ruta no implementada."},404);
    } catch (e:any) {
      console.error("ZUARA Neon API",e);
      return json({error:e?.message||"Error interno."},500);
    }
  }
};
