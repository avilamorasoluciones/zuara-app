-- ZUARA APP — operaciones transaccionales para la migración web.
-- Todas las operaciones críticas se ejecutan en PostgreSQL para conservar
-- atomicidad y evitar inconsistencias de stock/facturación.

create or replace function public.zuara_existencias()
returns setof jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id,
    'codigo_barras', p.codigo_barras,
    'descripcion', p.descripcion,
    'stock_minimo', p.stock_minimo,
    'unidad_medida', p.unidad_medida,
    'estado', p.estado,
    'stock_fisico_total', coalesce((
      select sum(case
        when m.tipo in ('Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada') then m.cantidad
        when m.tipo in ('Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida') then -m.cantidad
        else 0 end)
      from movimientos m where m.producto_id=p.id
    ),0),
    'stock_devoluciones', coalesce((
      select sum(case
        when m.almacen_destino_id=9999 then m.cantidad
        when m.almacen_origen_id=9999 then -m.cantidad else 0 end)
      from movimientos m where m.producto_id=p.id
    ),0),
    'stock_merma', coalesce((
      select sum(case
        when m.almacen_destino_id=9998 then m.cantidad
        when m.almacen_origen_id=9998 then -m.cantidad else 0 end)
      from movimientos m where m.producto_id=p.id
    ),0),
    'costo_unit', coalesce((
      select m.costo_unitario from movimientos m
      where m.producto_id=p.id
        and m.tipo in ('Inventario Inicial','Compra','Ajuste administrativo - Entrada','Ajuste administrativo - Salida')
      order by m.id desc limit 1
    ),0),
    'precio_usd', coalesce(p.precio_usd,0),
    'ultima_carga_id', (
      select m.id from movimientos m where m.producto_id=p.id
        and m.tipo in ('Inventario Inicial','Compra') order by m.id desc limit 1
    ),
    'ultima_carga_cantidad', (
      select m.cantidad from movimientos m where m.producto_id=p.id
        and m.tipo in ('Inventario Inicial','Compra') order by m.id desc limit 1
    ),
    'ultima_carga_fecha', (
      select m.fecha_registro from movimientos m where m.producto_id=p.id
        and m.tipo in ('Inventario Inicial','Compra') order by m.id desc limit 1
    ),
    'ultima_carga_documento', (
      select m.documento from movimientos m where m.producto_id=p.id
        and m.tipo in ('Inventario Inicial','Compra') order by m.id desc limit 1
    )
  )
  from productos p
  where (select private.app_has_permission('existencias')
         or private.app_has_permission('kardex')
         or private.app_has_permission('productos'))
  order by p.descripcion asc;
$$;

grant execute on function public.zuara_existencias() to authenticated;

create or replace function public.zuara_mutate(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $
declare
  u record;
  v record;
  t record;
  item jsonb;
  v_producto_id bigint;
  cantidad numeric;
  total_eur numeric;
  total_bs numeric;
  tasa_eur numeric;
  tasa_bin numeric;
  brecha numeric;
  fecha_fact text;
  hoy text;
  ahora text;
  consec text;
  mov_num bigint;
  nc_id bigint;
  saldo_eur numeric;
  saldo_bs numeric;
  estado_nc text;
  movimiento_id bigint;
  carga record;
  nueva_cantidad numeric;
  nuevo_costo numeric;
  anterior_cantidad numeric;
  anterior_costo numeric;
  delta numeric;
  ajuste_consec text;
  precio_actual numeric;
  rows_inserted integer := 0;
  fecha_tasa text;
  bin numeric;
  eur numeric;
  payload_rows jsonb;
begin
  select id,nombre,usuario,activo,es_admin,permisos
    into u
  from public.usuarios
  where auth_user_id=auth.uid() and activo=true
  limit 1;

  if u.id is null then
    return jsonb_build_object('error','Sesión no válida.','status_code',401);
  end if;

  if p_action = 'registrar_movimiento' then
    if not private.app_has_permission('movimientos') then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;

    perform pg_advisory_xact_lock(zuara_lock_key());
    select coalesce(max(id),0)+1 into mov_num from movimientos;
    consec := 'MOV-' || lpad(mov_num::text,5,'0');

    insert into movimientos(
      consecutivo,fecha_registro,tipo,producto_id,cantidad,costo_unitario,
      almacen_origen_id,almacen_destino_id,motivo,documento,registrado_por
    ) values (
      consec,
      coalesce(nullif(p_payload->>'fecha_registro',''),
        to_char(now() at time zone 'America/Caracas','YYYY-MM-DD HH24:MI:SS')),
      p_payload->>'tipo',
      (p_payload->>'producto_id')::bigint,
      coalesce((p_payload->>'cantidad')::numeric,0),
      coalesce((p_payload->>'costo_unitario')::numeric,0),
      nullif(p_payload->>'almacen_origen_id','')::bigint,
      nullif(p_payload->>'almacen_destino_id','')::bigint,
      coalesce(p_payload->>'motivo',''),
      coalesce(p_payload->>'documento',''),
      u.nombre
    );

    if p_payload ? 'precio_usd' and nullif(p_payload->>'precio_usd','') is not null then
      if not u.es_admin then
        return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
      end if;
      update productos set precio_usd=(p_payload->>'precio_usd')::numeric
      where id=(p_payload->>'producto_id')::bigint;
    end if;

    return jsonb_build_object('status','ok');
  end if;

  if p_action = 'corregir_existencia' then
    if not private.app_is_admin() then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;

    v_producto_id := (p_payload->>'producto_id')::bigint;
    movimiento_id := nullif(p_payload->>'movimiento_id','')::bigint;
    precio_actual := case when nullif(p_payload->>'precio_usd','') is null then null else (p_payload->>'precio_usd')::numeric end;

    if precio_actual is not null and precio_actual < 0 then
      return jsonb_build_object('error','El precio objetivo no puede ser negativo.','status_code',400);
    end if;

    if movimiento_id is not null then
      select * into carga from movimientos
      where id=movimiento_id and movimientos.producto_id=v_producto_id
        and tipo in ('Inventario Inicial','Compra')
      for update;

      if not found then
        return jsonb_build_object('error','La carga indicada no existe o no es una carga corregible.','status_code',404);
      end if;

      nueva_cantidad := coalesce((p_payload->>'cantidad')::numeric,0);
      nuevo_costo := coalesce((p_payload->>'costo_unitario')::numeric,0);
      if nueva_cantidad < 0 or nuevo_costo < 0 then
        return jsonb_build_object('error','La cantidad y el costo no pueden ser negativos.','status_code',400);
      end if;
      if carga.almacen_destino_id is null then
        return jsonb_build_object('error','La carga no tiene un almacén destino válido.','status_code',400);
      end if;

      anterior_cantidad := coalesce(carga.cantidad,0);
      anterior_costo := coalesce(carga.costo_unitario,0);
      delta := round(nueva_cantidad-anterior_cantidad,10);

      if delta < 0 then
        select coalesce(sum(case
          when tipo in ('Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada') then cantidad
          when tipo in ('Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida') then -cantidad
          else 0 end),0)
        into total_eur from movimientos where movimientos.producto_id=v_producto_id;
        if abs(delta) > total_eur + 0.000000001 then
          return jsonb_build_object(
            'error','La corrección dejaría el stock físico en negativo.',
            'status_code',400
          );
        end if;
      end if;

      if abs(delta) > 0.0000000001 or abs(nuevo_costo-anterior_costo) > 0.0000001 then
        perform pg_advisory_xact_lock(zuara_lock_key());
        select coalesce(max(id),0)+1 into mov_num from movimientos;
        ajuste_consec := 'MOV-' || lpad(mov_num::text,5,'0');

        insert into movimientos(
          consecutivo,fecha_registro,tipo,producto_id,cantidad,costo_unitario,
          almacen_origen_id,almacen_destino_id,motivo,documento,registrado_por
        ) values (
          ajuste_consec,
          to_char(now() at time zone 'America/Caracas','YYYY-MM-DD HH24:MI:SS'),
          case when delta>=0 then 'Ajuste administrativo - Entrada' else 'Ajuste administrativo - Salida' end,
          v_producto_id,abs(delta),nuevo_costo,
          case when delta<0 then carga.almacen_destino_id else null end,
          case when delta>=0 then carga.almacen_destino_id else null end,
          'Corrección administrativa de carga '||carga.consecutivo||': cantidad '||
            anterior_cantidad::text||' -> '||nueva_cantidad::text||'; costo '||
            to_char(anterior_costo,'FM999999990.00')||' -> '||
            to_char(nuevo_costo,'FM999999990.00'),
          coalesce(carga.documento,carga.consecutivo),
          u.nombre
        );
      end if;
    elsif precio_actual is null then
      return jsonb_build_object('error','Este producto no tiene una carga registrada. Solo se puede editar el precio objetivo hasta registrar una carga.','status_code',400);
    end if;

    if precio_actual is not null then
      update productos set precio_usd=precio_actual where id=v_producto_id;
    end if;

    return jsonb_build_object('status','ok','ajuste',ajuste_consec,'delta_cantidad',coalesce(delta,0));
  end if;

  if p_action = 'registrar_tasa' then
    if not private.app_has_permission('agregar_tasa') then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;
    fecha_tasa := coalesce(p_payload->>'fecha','');
    if not private.validar_fecha_iso_real(fecha_tasa) then
      return jsonb_build_object('error','La fecha de la tasa no es válida.','status_code',400);
    end if;
    bin := coalesce((p_payload->>'binance')::numeric,0);
    eur := coalesce((p_payload->>'euro_bcv')::numeric,0);
    if exists(select 1 from historico_tasas where fecha=fecha_tasa and binance=bin and euro_bcv=eur) then
      return jsonb_build_object('error','Ya existe una tasa con la misma fecha, Binance P2P y Euro BCV. No se registró un duplicado.','status_code',409);
    end if;
    insert into historico_tasas(
      fecha,hora,dolar_bcv,binance,bybit,dolar_promedio,euro_bcv,zelle,paypal,brecha,registrado_por
    ) values (
      fecha_tasa,coalesce(p_payload->>'hora',''),
      coalesce((p_payload->>'dolar_bcv')::numeric,0),
      bin,coalesce((p_payload->>'bybit')::numeric,0),
      coalesce((p_payload->>'dolar_promedio')::numeric,0),
      eur,coalesce((p_payload->>'zelle')::numeric,0),
      coalesce((p_payload->>'paypal')::numeric,0),
      case when eur>0 then bin/eur-1 else 0 end,u.nombre
    );
    return jsonb_build_object('status','ok');
  end if;

  if p_action = 'upload_tasas' then
    if not private.app_has_permission('agregar_tasa') then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;
    payload_rows := coalesce(p_payload->'rows','[]'::jsonb);
    for item in select * from jsonb_array_elements(payload_rows) loop
      fecha_tasa := coalesce(item->>'fecha','');
      if not private.validar_fecha_iso_real(fecha_tasa) then
        continue;
      end if;
      bin := coalesce((item->>'binance')::numeric,0);
      eur := coalesce((item->>'euro_bcv')::numeric,0);
      if exists(select 1 from historico_tasas where fecha=fecha_tasa and binance=bin and euro_bcv=eur) then
        continue;
      end if;
      insert into historico_tasas(
        fecha,hora,dolar_bcv,binance,bybit,dolar_promedio,euro_bcv,zelle,paypal,brecha,registrado_por
      ) values (
        fecha_tasa,coalesce(item->>'hora',''),
        coalesce((item->>'dolar_bcv')::numeric,0),bin,
        coalesce((item->>'bybit')::numeric,0),
        coalesce((item->>'dolar_promedio')::numeric,0),eur,
        coalesce((item->>'zelle')::numeric,0),
        coalesce((item->>'paypal')::numeric,0),
        case when eur>0 then bin/eur-1 else 0 end,u.nombre
      );
      rows_inserted := rows_inserted+1;
    end loop;
    return jsonb_build_object('status','ok','inserted',rows_inserted);
  end if;

  if p_action = 'guardar_configuracion' then
    if not private.app_has_permission('configuracion') then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;
    if exists(select 1 from jsonb_object_keys(p_payload) k where k <> 'permitir_descuentos') then
      return jsonb_build_object('error','La identidad y apariencia de ZUARA APP son fijas y no son editables.','status_code',400);
    end if;
    insert into configuracion(clave,valor)
    values ('permitir_descuentos',
      case when lower(coalesce(p_payload->>'permitir_descuentos','true'))='true' then 'true' else 'false' end)
    on conflict (clave) do update set valor=excluded.valor;
    return jsonb_build_object('status','ok');
  end if;

  if p_action = 'registrar_venta' then
    if not private.app_has_permission('ventas') then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;

    hoy := to_char(now() at time zone 'America/Caracas','YYYY-MM-DD');
    fecha_fact := case when u.es_admin then coalesce(nullif(p_payload->>'fecha_facturacion',''),hoy) else hoy end;
    if not private.validar_fecha_iso_real(fecha_fact) then
      return jsonb_build_object('error','La fecha de facturación no es válida.','status_code',400);
    end if;

    select fecha,hora,binance,euro_bcv into t
    from historico_tasas where fecha=fecha_fact
    order by hora desc,id desc limit 1;
    if t.id is null then
      if u.es_admin and fecha_fact<>hoy then
        return jsonb_build_object('error','No existe una tasa oficial registrada para la fecha seleccionada ('||fecha_fact||').','status_code',400);
      end if;
      return jsonb_build_object('error','No existe una tasa oficial registrada para el día del sistema.','status_code',400);
    end if;

    tasa_eur := coalesce(t.euro_bcv,0);
    tasa_bin := coalesce(t.binance,0);
    if tasa_eur <= 0 then
      return jsonb_build_object('error','La tasa Euro BCV de la fecha de facturación no es válida.','status_code',400);
    end if;
    brecha := tasa_bin/tasa_eur-1;

    if coalesce(p_payload->>'cliente_nombre','')='' then
      return jsonb_build_object('error','El nombre del cliente es obligatorio.','status_code',400);
    end if;
    if jsonb_typeof(p_payload->'detalles') <> 'array' or jsonb_array_length(p_payload->'detalles')=0 then
      return jsonb_build_object('error','El carrito está vacío.','status_code',400);
    end if;

    consec := trim(coalesce(p_payload->>'consecutivo',''));
    if consec='' then
      return jsonb_build_object('error','No se pudo generar el consecutivo de la nota de entrega.','status_code',400);
    end if;
    if exists(select 1 from ventas where consecutivo=consec) then
      return jsonb_build_object('error','Ya existe una nota de entrega con ese consecutivo.','status_code',409);
    end if;

    perform pg_advisory_xact_lock(zuara_lock_key());

    -- Validar stock acumulando las cantidades del carrito por producto.
    for v_producto_id, cantidad in
      select (x->>'producto_id')::bigint, sum(coalesce((x->>'cantidad')::numeric,0))
      from jsonb_array_elements(p_payload->'detalles') x
      group by (x->>'producto_id')
    loop
      if v_producto_id is null or cantidad<=0 then
        return jsonb_build_object('error','Cada detalle de venta debe tener un producto y una cantidad mayor a cero.','status_code',400);
      end if;

      select coalesce(sum(case
        when tipo in ('Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada') then cantidad
        when tipo in ('Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida') then -cantidad
        else 0 end),0)
        - (
          coalesce(sum(case when almacen_destino_id in (9998,9999) then cantidad else 0 end),0)
          - coalesce(sum(case when almacen_origen_id in (9998,9999) then cantidad else 0 end),0)
        )
      into saldo_eur
      from movimientos
      where movimientos.producto_id=v_producto_id;

      if cantidad > coalesce(saldo_eur,0) then
        return jsonb_build_object('error','No hay existencias suficientes para completar la venta.','status_code',400);
      end if;
    end loop;

    -- Cliente: conservar el comportamiento de la aplicación actual.
    select id into v from clientes where nombre=trim(p_payload->>'cliente_nombre') limit 1;
    ahora := to_char(now() at time zone 'America/Caracas','YYYY-MM-DD HH24:MI:SS');

    if v.id is not null then
      update clientes set
        documento=coalesce(p_payload->>'cliente_doc','PENDIENTE'),
        telefono=coalesce(p_payload->>'cliente_telefono',''),
        correo=coalesce(p_payload->>'cliente_correo',''),
        pais=coalesce(p_payload->>'env_pais','Venezuela'),
        estado=coalesce(p_payload->>'env_estado',''),
        municipio=coalesce(p_payload->>'env_ciudad',''),
        direccion_entrega=coalesce(p_payload->>'env_direccion',''),
        punto_referencia=coalesce(p_payload->>'env_referencia',''),
        coordenadas=coalesce(p_payload->>'env_coordenadas',''),
        tipo_envio=coalesce(p_payload->>'env_tipo','')
      where id=v.id;
    else
      insert into clientes(documento,nombre,telefono,correo,pais,estado,municipio,direccion_entrega,punto_referencia,coordenadas,tipo_envio,fecha_registro,registrado_por)
      values (
        coalesce(p_payload->>'cliente_doc','PENDIENTE'),
        trim(p_payload->>'cliente_nombre'),
        coalesce(p_payload->>'cliente_telefono',''),
        coalesce(p_payload->>'cliente_correo',''),
        coalesce(p_payload->>'env_pais','Venezuela'),
        coalesce(p_payload->>'env_estado',''),
        coalesce(p_payload->>'env_ciudad',''),
        coalesce(p_payload->>'env_direccion',''),
        coalesce(p_payload->>'env_referencia',''),
        coalesce(p_payload->>'env_coordenadas',''),
        coalesce(p_payload->>'env_tipo',''),
        ahora,u.nombre
      );
    end if;

    total_eur := coalesce((p_payload->>'total_eur')::numeric,0);
    total_bs := coalesce((p_payload->>'total_bs')::numeric,0);

    nc_id := nullif(p_payload->>'nc_id','')::bigint;
    if nc_id is not null then
      select id,total_eur,total_bs,saldo_usado_eur,saldo_usado_bs,estado into v
      from notas_credito where id=nc_id for update;
      if v.id is null or v.estado <> 'DISPONIBLE' then
        return jsonb_build_object('error','La nota de crédito seleccionada ya no está disponible.','status_code',400);
      end if;
      saldo_eur := coalesce(v.total_eur,0)-coalesce(v.saldo_usado_eur,0);
      if total_eur > saldo_eur+0.0001 then
        return jsonb_build_object('error','El total de la venta supera el saldo disponible de la nota de crédito.','status_code',400);
      end if;
      saldo_eur := coalesce(v.saldo_usado_eur,0)+total_eur;
      saldo_bs := coalesce(v.saldo_usado_bs,0)+total_bs;
      estado_nc := case when saldo_eur >= coalesce(v.total_eur,0)-0.0001 then 'APLICADA' else 'DISPONIBLE' end;
      update notas_credito set saldo_usado_eur=saldo_eur,saldo_usado_bs=saldo_bs,estado=estado_nc where id=nc_id;
    end if;

    insert into ventas(
      consecutivo,fecha_registro,fecha_facturacion,cliente_nombre,cliente_telefono,direccion_entrega,
      cliente_documento,cliente_correo,pais,estado_cliente,punto_referencia,coordenadas,tipo_envio,
      total_eur,total_bs,tasa_bcv_euro_aplicada,tasa_binance_aplicada,porcentaje_brecha_aplicado,
      estado,registrado_por,metodo_pago
    ) values (
      consec,ahora,fecha_fact,trim(p_payload->>'cliente_nombre'),
      coalesce(p_payload->>'cliente_telefono',''),
      coalesce(p_payload->>'env_direccion',''),
      coalesce(p_payload->>'cliente_doc',''),
      coalesce(p_payload->>'cliente_correo',''),
      coalesce(p_payload->>'env_pais','Venezuela'),
      coalesce(p_payload->>'env_estado',''),
      coalesce(p_payload->>'env_referencia',''),
      coalesce(p_payload->>'env_coordenadas',''),
      coalesce(p_payload->>'env_tipo',''),
      total_eur,total_bs,tasa_eur,tasa_bin,brecha,
      coalesce(p_payload->>'estado_semaforo','EMITIDA'),u.nombre,
      coalesce(p_payload->>'metodo_pago','')
    );

    select coalesce(max(id),0)+1 into mov_num from movimientos;
    for item in select * from jsonb_array_elements(p_payload->'detalles') loop
      v_producto_id := (item->>'producto_id')::bigint;
      insert into movimientos(
        consecutivo,fecha_registro,tipo,producto_id,cantidad,costo_unitario,documento,registrado_por
      ) values (
        'MOV-'||lpad(mov_num::text,5,'0'),
        fecha_fact||' '||split_part(ahora,' ',2),
        'Venta',v_producto_id,
        (item->>'cantidad')::numeric,
        coalesce((item->>'precio_eur')::numeric,0),
        consec,u.nombre
      );

      insert into detalle_nota_entrega(
        consecutivo,producto_id,cantidad,descuento,precio_unitario_euro_snapshot,
        subtotal_euro_snapshot,total_euro_snapshot,precio_unitario_bs_snapshot,
        subtotal_bs_snapshot,total_bs_snapshot
      ) values (
        consec,v_producto_id,(item->>'cantidad')::numeric,
        coalesce((item->>'descuento')::numeric,0),
        coalesce((item->>'precio_eur')::numeric,0),
        coalesce((item->>'sub_eur')::numeric,0),
        coalesce((item->>'total_eur')::numeric,0),
        coalesce((item->>'pre_bs')::numeric,0),
        coalesce((item->>'sub_bs')::numeric,0),
        coalesce((item->>'tot_bs')::numeric,0)
      );
      mov_num := mov_num+1;
    end loop;

    return jsonb_build_object('status','ok','consecutivo',consec);
  end if;

  if p_action = 'registrar_devolucion' then
    if not private.app_has_permission('ventas') and not private.app_has_permission('historial_ventas') then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;

    consec := coalesce(p_payload->>'consecutivo_origen','');
    if consec='' then
      return jsonb_build_object('error','La factura de origen es obligatoria.','status_code',400);
    end if;
    if jsonb_typeof(p_payload->'detalles') <> 'array' then
      return jsonb_build_object('error','Debe seleccionar al menos un producto con cantidad válida para devolver.','status_code',400);
    end if;

    perform pg_advisory_xact_lock(zuara_lock_key());
    ahora := to_char(now() at time zone 'America/Caracas','YYYY-MM-DD HH24:MI:SS');

    -- Primero acumulamos por producto para impedir devolver más de lo vendido.
    for item in select * from jsonb_array_elements(p_payload->'detalles') loop
      v_producto_id := (item->>'producto_id')::bigint;
      cantidad := coalesce((item->>'cantidad_devolver')::numeric,0);
      if v_producto_id is null or cantidad<=0 then continue; end if;

      select coalesce(sum(cantidad),0),coalesce(max(precio_unitario_euro_snapshot),0),coalesce(max(precio_unitario_bs_snapshot),0)
        into saldo_eur,tasa_eur,tasa_bin
      from detalle_nota_entrega
      where consecutivo=consec and detalle_nota_entrega.producto_id=v_producto_id;

      select coalesce(sum(d.cantidad),0) into total_bs
      from detalle_nota_credito d
      join notas_credito n on n.consecutivo=d.consecutivo_nc
      where n.consecutivo_origen=consec and d.producto_id=v_producto_id;

      if cantidad > coalesce(saldo_eur,0)-coalesce(total_bs,0)+0.0001 then
        return jsonb_build_object('error','La cantidad solicitada supera la cantidad disponible para devolución.','status_code',400);
      end if;
    end loop;

    consec := replace(consec,'NE','NC',1);
    if exists(select 1 from notas_credito where consecutivo=consec) then
      consec := consec||'-'||extract(epoch from clock_timestamp())::bigint::text;
    end if;

    total_eur := 0;
    total_bs := 0;
    for item in select * from jsonb_array_elements(p_payload->'detalles') loop
      v_producto_id := (item->>'producto_id')::bigint;
      cantidad := coalesce((item->>'cantidad_devolver')::numeric,0);
      if v_producto_id is null or cantidad<=0 then continue; end if;
      select coalesce(max(precio_unitario_euro_snapshot),0),coalesce(max(precio_unitario_bs_snapshot),0)
        into tasa_eur,tasa_bin
      from detalle_nota_entrega where consecutivo=coalesce(p_payload->>'consecutivo_origen','') and detalle_nota_entrega.producto_id=v_producto_id;
      total_eur := total_eur + cantidad*tasa_eur;
      total_bs := total_bs + cantidad*tasa_bin;
    end loop;

    insert into notas_credito(consecutivo,fecha_registro,consecutivo_origen,cliente_nombre,total_eur,total_bs,motivo,registrado_por,estado)
    values(consec,ahora,p_payload->>'cliente_nombre',coalesce(p_payload->>'cliente_nombre',''),total_eur,total_bs,p_payload->>'motivo',u.nombre,'DISPONIBLE');

    select coalesce(max(id),0)+1 into mov_num from movimientos;
    for item in select * from jsonb_array_elements(p_payload->'detalles') loop
      v_producto_id := (item->>'producto_id')::bigint;
      cantidad := coalesce((item->>'cantidad_devolver')::numeric,0);
      if v_producto_id is null or cantidad<=0 then continue; end if;
      select coalesce(max(precio_unitario_euro_snapshot),0),coalesce(max(precio_unitario_bs_snapshot),0)
        into tasa_eur,tasa_bin
      from detalle_nota_entrega where consecutivo=coalesce(p_payload->>'consecutivo_origen','') and detalle_nota_entrega.producto_id=v_producto_id;

      insert into movimientos(consecutivo,fecha_registro,tipo,producto_id,cantidad,costo_unitario,almacen_destino_id,documento,registrado_por,motivo)
      values(
        'MOV-'||lpad(mov_num::text,5,'0'),ahora,'Devolución por venta',v_producto_id,cantidad,tasa_eur,
        9999,consec,u.nombre,
        'Afecta a Nota: '||coalesce(p_payload->>'consecutivo_origen','')||' | Motivo: '||coalesce(p_payload->>'motivo','')
      );
      mov_num := mov_num+1;

      insert into detalle_nota_credito(consecutivo_nc,producto_id,cantidad,precio_eur,precio_bs,subtotal_eur,subtotal_bs)
      values(consec,v_producto_id,cantidad,tasa_eur,tasa_bin,cantidad*tasa_eur,cantidad*tasa_bin);
    end loop;

    update ventas set estado='DEVUELTO PARCIAL/TOTAL'
    where consecutivo=coalesce(p_payload->>'consecutivo_origen','');

    return jsonb_build_object('status','ok','consecutivo',consec);
  end if;

  if p_action = 'delete_venta' then
    if not private.app_is_admin() then
      return jsonb_build_object('error','No es posible realizar esta operación.','status_code',403);
    end if;
    consec := coalesce(p_payload->>'consecutivo','');
    if consec='' then return jsonb_build_object('error','La venta indicada no existe.','status_code',404); end if;
    delete from movimientos where documento=consec;
    delete from detalle_nota_entrega where consecutivo=consec;
    delete from ventas where consecutivo=consec;
    return jsonb_build_object('status','ok');
  end if;

  return jsonb_build_object('error','Acción no implementada: '||p_action,'status_code',404);
exception
  when unique_violation then
    return jsonb_build_object('error','Ya existe un registro con esos datos.','status_code',409);
  when others then
    return jsonb_build_object('error',sqlerrm,'status_code',500);
end;
$$;

create or replace function public.zuara_lock_key()
returns bigint
language sql
immutable
as $$ select 837421::bigint $$;

grant execute on function public.zuara_mutate(text,jsonb) to authenticated;
revoke execute on function public.zuara_lock_key() from public, anon, authenticated;


revoke execute on function public.zuara_mutate(text,jsonb) from public, anon;
grant execute on function public.zuara_mutate(text,jsonb) to authenticated;
