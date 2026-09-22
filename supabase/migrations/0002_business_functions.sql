-- ZUARA APP — operaciones transaccionales críticas.
-- Se ejecutan dentro de PostgreSQL para conservar atomicidad.
-- Todas las funciones están cerradas a anon/public y exigen autenticación
-- + permiso de negocio explícito.

create or replace function public.zuara_mutate(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id bigint;
  v_usuario text;
  v_admin boolean;
  v_perm boolean;
  v_now text := to_char(timezone('America/Caracas', now()), 'YYYY-MM-DD HH24:MI:SS');
  v_hoy text := to_char(timezone('America/Caracas', now()), 'YYYY-MM-DD');
  v_id bigint;
  v_consecutivo text;
  v_producto bigint;
  v_cantidad double precision;
  v_stock double precision;
  v_delta double precision;
  v_nueva_cantidad double precision;
  v_nuevo_costo double precision;
  v_carga record;
  v_tasa record;
  v_venta record;
  v_nc record;
  v_item jsonb;
  v_total_eur double precision;
  v_total_bs double precision;
  v_fecha_facturacion text;
  v_tasa_eur double precision;
  v_tasa_binance double precision;
  v_brecha double precision;
  v_cliente_id bigint;
  v_nc_id bigint;
  v_saldo_eur double precision;
  v_saldo_bs double precision;
  v_estado_nc text;
  v_precio_usd double precision;
  v_rows jsonb;
  v_fecha text;
  v_hora text;
  v_bcv double precision;
  v_binance double precision;
  v_bybit double precision;
  v_promedio double precision;
  v_euro double precision;
  v_zelle double precision;
  v_paypal double precision;
begin
  select u.id, u.usuario, u.es_admin
    into v_user_id, v_usuario, v_admin
  from public.usuarios u
  where u.auth_user_id = (select auth.uid())
    and u.activo = true
  limit 1;

  if v_user_id is null then
    raise exception using message = 'Sesión no válida.';
  end if;

  if p_action = 'registrar_movimiento' then
    select private.app_has_permission('movimientos') into v_perm;
    if not v_perm then raise exception using message = 'No es posible realizar esta operación.'; end if;

    insert into public.movimientos(
      fecha_registro,tipo,producto_id,cantidad,costo_unitario,
      almacen_origen_id,almacen_destino_id,motivo,documento,registrado_por
    )
    values (
      coalesce(nullif(p_payload->>'fecha_registro',''), v_now),
      p_payload->>'tipo',
      (p_payload->>'producto_id')::bigint,
      coalesce((p_payload->>'cantidad')::double precision,0),
      coalesce((p_payload->>'costo_unitario')::double precision,0),
      nullif(p_payload->>'almacen_origen_id','')::bigint,
      nullif(p_payload->>'almacen_destino_id','')::bigint,
      coalesce(p_payload->>'motivo',''),
      coalesce(p_payload->>'documento',''),
      v_usuario
    )
    returning id into v_id;

    update public.movimientos
       set consecutivo = 'MOV-' || lpad(v_id::text,5,'0')
     where id = v_id;

    if p_payload ? 'precio_usd' and nullif(p_payload->>'precio_usd','') is not null then
      if not v_admin then raise exception using message = 'No es posible realizar esta operación.'; end if;
      update public.productos
         set precio_usd = (p_payload->>'precio_usd')::double precision
       where id = (p_payload->>'producto_id')::bigint;
    end if;

    return jsonb_build_object('status','ok');

  elsif p_action = 'corregir_existencia' then
    if not v_admin then raise exception using message = 'No es posible realizar esta operación.'; end if;

    v_producto := (p_payload->>'producto_id')::bigint;
    v_precio_usd := case when nullif(p_payload->>'precio_usd','') is null then null else (p_payload->>'precio_usd')::double precision end;
    if v_precio_usd is not null and v_precio_usd < 0 then
      raise exception using message = 'El precio objetivo no puede ser negativo.';
    end if;

    if nullif(p_payload->>'movimiento_id','') is not null then
      select id,consecutivo,fecha_registro,tipo,producto_id,cantidad,costo_unitario,
             almacen_destino_id,motivo,documento
        into v_carga
      from public.movimientos
      where id=(p_payload->>'movimiento_id')::bigint
        and producto_id=v_producto
        and tipo in ('Inventario Inicial','Compra')
      for update;

      if not found then
        return jsonb_build_object('error','La carga indicada no existe o no es una carga corregible.','status_code',404);
      end if;

      v_nueva_cantidad := coalesce((p_payload->>'cantidad')::double precision,0);
      v_nuevo_costo := coalesce((p_payload->>'costo_unitario')::double precision,0);
      if v_nueva_cantidad < 0 or v_nuevo_costo < 0 then
        return jsonb_build_object('error','La cantidad y el costo no pueden ser negativos.','status_code',400);
      end if;
      if v_carga.almacen_destino_id is null then
        return jsonb_build_object('error','La carga no tiene un almacén destino válido.','status_code',400);
      end if;

      v_delta := round(v_nueva_cantidad - coalesce(v_carga.cantidad,0),10);

      if v_delta < 0 then
        select coalesce(sum(
          case
            when tipo in ('Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada') then cantidad
            when tipo in ('Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida') then -cantidad
            else 0
          end),0)
        into v_stock
        from public.movimientos where producto_id=v_producto;

        if abs(v_delta) > v_stock + 1e-9 then
          return jsonb_build_object(
            'error',format('La corrección dejaría el stock físico en negativo. Stock actual: %s; reducción solicitada: %s.',v_stock,abs(v_delta)),
            'status_code',400
          );
        end if;
      end if;

      if abs(v_delta) > 0.0000000001 or abs(v_nuevo_costo-coalesce(v_carga.costo_unitario,0)) > 0.0000001 then
        insert into public.movimientos(
          fecha_registro,tipo,producto_id,cantidad,costo_unitario,
          almacen_origen_id,almacen_destino_id,motivo,documento,registrado_por
        )
        values (
          v_now,
          case when v_delta >= 0 then 'Ajuste administrativo - Entrada' else 'Ajuste administrativo - Salida' end,
          v_producto,abs(v_delta),v_nuevo_costo,
          case when v_delta < 0 then v_carga.almacen_destino_id else null end,
          case when v_delta >= 0 then v_carga.almacen_destino_id else null end,
          format('Corrección administrativa de carga %s: cantidad %s -> %s; costo %.2f -> %.2f',
                 v_carga.consecutivo,coalesce(v_carga.cantidad,0),v_nueva_cantidad,
                 coalesce(v_carga.costo_unitario,0),v_nuevo_costo),
          coalesce(v_carga.documento,v_carga.consecutivo),
          v_usuario
        )
        returning id into v_id;
        update public.movimientos set consecutivo='MOV-'||lpad(v_id::text,5,'0') where id=v_id;
        v_consecutivo := 'MOV-'||lpad(v_id::text,5,'0');
      end if;
    elsif v_precio_usd is null then
      return jsonb_build_object('error','Este producto no tiene una carga registrada. Solo se puede editar el precio objetivo hasta registrar una carga.','status_code',400);
    end if;

    if v_precio_usd is not null then
      update public.productos set precio_usd=v_precio_usd where id=v_producto;
    end if;

    return jsonb_build_object('status','ok','ajuste',v_consecutivo,'delta_cantidad',coalesce(v_delta,0));

  elsif p_action = 'registrar_venta' then
    if not (select private.app_has_permission('ventas')) then
      raise exception using message = 'No es posible realizar esta operación.';
    end if;

    v_fecha_facturacion := case when v_admin then coalesce(nullif(p_payload->>'fecha_facturacion',''),v_hoy) else v_hoy end;
    if not private.validar_fecha_iso_real(v_fecha_facturacion) then
      return jsonb_build_object('error','La fecha de facturación no es válida. Selecciona una fecha real.','status_code',400);
    end if;

    select fecha,hora,binance,euro_bcv into v_tasa
    from public.historico_tasas
    where fecha=v_fecha_facturacion
    order by hora desc nulls last,id desc
    limit 1;

    if not found then
      if v_admin and v_fecha_facturacion <> v_hoy then
        return jsonb_build_object('error',format('No existe una tasa oficial registrada para la fecha seleccionada (%s).',v_fecha_facturacion),'status_code',400);
      end if;
      return jsonb_build_object('error','No existe una tasa oficial registrada para el día del sistema.','status_code',400);
    end if;

    v_tasa_eur := coalesce(v_tasa.euro_bcv,0);
    v_tasa_binance := coalesce(v_tasa.binance,0);
    if v_tasa_eur <= 0 then
      return jsonb_build_object('error','La tasa Euro BCV de la fecha de facturación no es válida.','status_code',400);
    end if;
    v_brecha := v_tasa_binance/v_tasa_eur-1;

    if nullif(trim(p_payload->>'cliente_nombre'),'') is null then
      return jsonb_build_object('error','El nombre del cliente es obligatorio','status_code',400);
    end if;
    if jsonb_typeof(p_payload->'detalles') <> 'array' or jsonb_array_length(p_payload->'detalles')=0 then
      return jsonb_build_object('error','El carrito está vacío','status_code',400);
    end if;

    v_consecutivo := trim(coalesce(p_payload->>'consecutivo',''));
    if v_consecutivo='' then
      return jsonb_build_object('error','No se pudo generar el consecutivo de la nota de entrega.','status_code',400);
    end if;
    if exists(select 1 from public.ventas where consecutivo=v_consecutivo) then
      return jsonb_build_object('error','Ya existe una nota de entrega con ese consecutivo.','status_code',409);
    end if;

    -- Validar stock agregado por producto, igual que la versión Flask.
    for v_producto, v_cantidad in
      select
        (value->>'producto_id')::bigint,
        sum((value->>'cantidad')::double precision)
      from jsonb_array_elements(p_payload->'detalles')
      group by (value->>'producto_id')::bigint
    loop
      if v_producto <= 0 or v_cantidad <= 0 then
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
      into v_stock
      from public.movimientos
      where producto_id=v_producto;

      if v_cantidad > v_stock then
        return jsonb_build_object('error','No hay existencias suficientes para completar la venta.','status_code',400);
      end if;
    end loop;

    select id into v_cliente_id from public.clientes where nombre=trim(p_payload->>'cliente_nombre') limit 1;
    if v_cliente_id is not null then
      update public.clientes set
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
      where id=v_cliente_id;
    else
      insert into public.clientes(documento,nombre,telefono,correo,pais,estado,municipio,direccion_entrega,punto_referencia,coordenadas,tipo_envio,fecha_registro,registrado_por)
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
        v_now,v_usuario
      ) returning id into v_cliente_id;
    end if;

    v_total_eur := coalesce((p_payload->>'total_eur')::double precision,0);
    v_total_bs := coalesce((p_payload->>'total_bs')::double precision,0);
    v_nc_id := nullif(p_payload->>'nc_id','')::bigint;

    if v_nc_id is not null then
      select * into v_nc from public.notas_credito where id=v_nc_id for update;
      if not found or v_nc.estado <> 'DISPONIBLE' then
        return jsonb_build_object('error','La nota de crédito seleccionada ya no está disponible.','status_code',400);
      end if;
      v_saldo_eur := coalesce(v_nc.total_eur,0)-coalesce(v_nc.saldo_usado_eur,0);
      if v_total_eur > v_saldo_eur + 0.0001 then
        return jsonb_build_object('error','El total de la venta supera el saldo disponible de la nota de crédito.','status_code',400);
      end if;
      v_saldo_eur := coalesce(v_nc.saldo_usado_eur,0)+v_total_eur;
      v_saldo_bs := coalesce(v_nc.saldo_usado_bs,0)+v_total_bs;
      v_estado_nc := case when v_saldo_eur >= coalesce(v_nc.total_eur,0)-0.0001 then 'APLICADA' else 'DISPONIBLE' end;
      update public.notas_credito set saldo_usado_eur=v_saldo_eur,saldo_usado_bs=v_saldo_bs,estado=v_estado_nc where id=v_nc_id;
    end if;

    insert into public.ventas(
      consecutivo,fecha_registro,fecha_facturacion,cliente_nombre,cliente_telefono,direccion_entrega,
      total_eur,total_bs,tasa_bcv_euro_aplicada,tasa_binance_aplicada,porcentaje_brecha_aplicado,
      estado,registrado_por,metodo_pago
    )
    values (
      v_consecutivo,v_now,v_fecha_facturacion,trim(p_payload->>'cliente_nombre'),
      coalesce(p_payload->>'cliente_telefono',''),coalesce(p_payload->>'env_direccion',''),
      v_total_eur,v_total_bs,v_tasa_eur,v_tasa_binance,v_brecha,
      coalesce(p_payload->>'estado_semaforo','EMITIDA'),v_usuario,coalesce(p_payload->>'metodo_pago','')
    ) returning id into v_id;

    for v_item in select value from jsonb_array_elements(p_payload->'detalles') loop
      insert into public.movimientos(
        fecha_registro,tipo,producto_id,cantidad,costo_unitario,documento,registrado_por
      ) values (
        v_fecha_facturacion || ' ' || to_char(timezone('America/Caracas',now()),'HH24:MI:SS'),
        'Venta',(v_item->>'producto_id')::bigint,
        (v_item->>'cantidad')::double precision,
        coalesce((v_item->>'precio_eur')::double precision,0),
        v_consecutivo,v_usuario
      ) returning id into v_id;
      update public.movimientos set consecutivo='MOV-'||lpad(v_id::text,5,'0') where id=v_id;

      insert into public.detalle_nota_entrega(
        consecutivo,producto_id,cantidad,descuento,precio_unitario_euro_snapshot,
        subtotal_euro_snapshot,total_euro_snapshot,precio_unitario_bs_snapshot,
        subtotal_bs_snapshot,total_bs_snapshot
      ) values (
        v_consecutivo,(v_item->>'producto_id')::bigint,
        coalesce((v_item->>'cantidad')::double precision,0),
        coalesce((v_item->>'descuento')::double precision,0),
        coalesce((v_item->>'precio_eur')::double precision,0),
        coalesce((v_item->>'sub_eur')::double precision,0),
        coalesce((v_item->>'total_eur')::double precision,0),
        coalesce((v_item->>'pre_bs')::double precision,0),
        coalesce((v_item->>'sub_bs')::double precision,0),
        coalesce((v_item->>'tot_bs')::double precision,0)
      );
    end loop;

    return jsonb_build_object('status','ok','consecutivo',v_consecutivo);

  elsif p_action = 'registrar_devolucion' then
    if not (select private.app_has_permission('historial_ventas') or private.app_has_permission('ventas')) then
      raise exception using message = 'No es posible realizar esta operación.';
    end if;

    v_consecutivo := trim(p_payload->>'consecutivo_origen');
    if v_consecutivo='' then
      return jsonb_build_object('error','La nota de entrega de origen es obligatoria.','status_code',400);
    end if;

    v_total_eur:=0; v_total_bs:=0;

    -- La validación se hace en una sola transacción y contra el detalle de venta
    -- más las devoluciones ya registradas.
    for v_item in select value from jsonb_array_elements(coalesce(p_payload->'detalles','[]'::jsonb)) loop
      v_producto := coalesce(nullif(v_item->>'producto_id','')::bigint,0);
      v_cantidad := coalesce(nullif(v_item->>'cantidad_devolver','')::double precision,0);
      if v_producto<=0 or v_cantidad<=0 then continue; end if;

      select coalesce(sum(cantidad),0),coalesce(max(precio_unitario_euro_snapshot),0),coalesce(max(precio_unitario_bs_snapshot),0)
        into v_stock,v_tasa_eur,v_tasa_binance
      from public.detalle_nota_entrega
      where consecutivo=v_consecutivo and producto_id=v_producto;

      select coalesce(sum(d.cantidad),0) into v_delta
      from public.detalle_nota_credito d
      join public.notas_credito n on n.consecutivo=d.consecutivo_nc
      where n.consecutivo_origen=v_consecutivo and d.producto_id=v_producto;

      if v_cantidad > (v_stock-v_delta)+0.0001 then
        return jsonb_build_object('error','La cantidad solicitada supera la cantidad disponible para devolución.','status_code',400);
      end if;

      v_total_eur := v_total_eur + v_cantidad*v_tasa_eur;
      v_total_bs := v_total_bs + v_cantidad*v_tasa_binance;
    end loop;

    if v_total_eur=0 and v_total_bs=0 then
      return jsonb_build_object('error','Debe seleccionar al menos un producto con cantidad válida para devolver.','status_code',400);
    end if;

    v_consecutivo := regexp_replace(v_consecutivo,'^NE','NC');
    if exists(select 1 from public.notas_credito where consecutivo=v_consecutivo) then
      v_consecutivo := v_consecutivo || '-' || extract(epoch from timezone('America/Caracas',now()))::bigint::text;
    end if;

    insert into public.notas_credito(
      consecutivo,fecha_registro,consecutivo_origen,cliente_nombre,total_eur,total_bs,motivo,registrado_por,estado
    ) values (
      v_consecutivo,v_now,p_payload->>'consecutivo_origen',p_payload->>'cliente_nombre',
      v_total_eur,v_total_bs,coalesce(p_payload->>'motivo',''),v_usuario,'DISPONIBLE'
    ) returning id into v_nc_id;

    for v_item in select value from jsonb_array_elements(coalesce(p_payload->'detalles','[]'::jsonb)) loop
      v_producto := coalesce(nullif(v_item->>'producto_id','')::bigint,0);
      v_cantidad := coalesce(nullif(v_item->>'cantidad_devolver','')::double precision,0);
      if v_producto<=0 or v_cantidad<=0 then continue; end if;

      select coalesce(max(precio_unitario_euro_snapshot),0),coalesce(max(precio_unitario_bs_snapshot),0)
        into v_tasa_eur,v_tasa_binance
      from public.detalle_nota_entrega
      where consecutivo=p_payload->>'consecutivo_origen' and producto_id=v_producto;

      insert into public.movimientos(
        fecha_registro,tipo,producto_id,cantidad,costo_unitario,almacen_destino_id,documento,registrado_por,motivo
      ) values (
        v_now,'Devolución por venta',v_producto,v_cantidad,v_tasa_eur,9999,v_consecutivo,v_usuario,
        format('Afecta a Nota: %s | Motivo: %s',p_payload->>'consecutivo_origen',coalesce(p_payload->>'motivo',''))
      ) returning id into v_id;
      update public.movimientos set consecutivo='MOV-'||lpad(v_id::text,5,'0') where id=v_id;

      insert into public.detalle_nota_credito(consecutivo_nc,producto_id,cantidad,precio_eur,precio_bs,subtotal_eur,subtotal_bs)
      values(v_consecutivo,v_producto,v_cantidad,v_tasa_eur,v_tasa_binance,v_cantidad*v_tasa_eur,v_cantidad*v_tasa_binance);
    end loop;

    update public.ventas set estado='DEVUELTO PARCIAL/TOTAL'
    where consecutivo=p_payload->>'consecutivo_origen';

    return jsonb_build_object('status','ok','consecutivo',v_consecutivo);

  elsif p_action = 'guardar_configuracion' then
    if not (select private.app_has_permission('configuracion')) then
      raise exception using message = 'No es posible realizar esta operación.';
    end if;
    for v_item in select key,value from jsonb_each_text(coalesce(p_payload,'{}'::jsonb)) loop
      insert into public.configuracion(clave,valor) values(v_item.key,v_item.value)
      on conflict(clave) do update set valor=excluded.valor;
    end loop;
    return jsonb_build_object('status','ok');

  elsif p_action = 'upload_tasas' then
    if not (select private.app_has_permission('agregar_tasa')) then
      raise exception using message = 'No es posible realizar esta operación.';
    end if;
    v_rows := coalesce(p_payload->'rows','[]'::jsonb);
    for v_item in select value from jsonb_array_elements(v_rows) loop
      v_fecha := trim(v_item->>'fecha');
      v_hora := trim(v_item->>'hora');
      if not private.validar_fecha_iso_real(v_fecha) then
        raise exception using message = 'La fecha de una tasa no es válida.';
      end if;
      v_bcv:=coalesce((v_item->>'dolar_bcv')::double precision,0);
      v_binance:=coalesce((v_item->>'binance')::double precision,0);
      v_bybit:=coalesce((v_item->>'bybit')::double precision,0);
      v_promedio:=coalesce((v_item->>'dolar_promedio')::double precision,0);
      v_euro:=coalesce((v_item->>'euro_bcv')::double precision,0);
      v_zelle:=coalesce((v_item->>'zelle')::double precision,0);
      v_paypal:=coalesce((v_item->>'paypal')::double precision,0);
      insert into public.historico_tasas(fecha,hora,dolar_bcv,binance,bybit,dolar_promedio,euro_bcv,zelle,paypal,brecha,registrado_por)
      values(v_fecha,v_hora,v_bcv,v_binance,v_bybit,v_promedio,v_euro,v_zelle,v_paypal,
             case when v_euro>0 then v_binance/v_euro-1 else 0 end,v_usuario);
    end loop;
    return jsonb_build_object('status','ok','inserted',jsonb_array_length(v_rows));

  elsif p_action = 'delete_venta' then
    if not v_admin then raise exception using message = 'No es posible realizar esta operación.'; end if;
    v_consecutivo := p_payload->>'consecutivo';
    delete from public.detalle_nota_entrega where consecutivo=v_consecutivo;
    delete from public.movimientos where documento=v_consecutivo;
    delete from public.ventas where consecutivo=v_consecutivo;
    return jsonb_build_object('status','ok','consecutivo',v_consecutivo);

  else
    raise exception using message = 'Operación no soportada.';
  end if;
end;
$$;

revoke all on function public.zuara_mutate(text,jsonb) from public, anon;
grant execute on function public.zuara_mutate(text,jsonb) to authenticated;

-- RPC de lectura para existencias: evita descargar todo el Kardex al navegador.
create or replace function public.zuara_existencias()
returns table(
  id bigint,codigo_barras text,descripcion text,stock_minimo integer,unidad_medida text,estado text,
  stock_fisico_total double precision,stock_devoluciones double precision,stock_merma double precision,
  costo_unit double precision,precio_usd double precision,ultima_carga_id bigint,
  ultima_carga_cantidad double precision,ultima_carga_fecha text,ultima_carga_documento text,
  stock_bloqueado double precision,stock_disponible_venta double precision,total_costo double precision
)
language sql
security invoker
set search_path = ''
as $$
  select
    p.id,p.codigo_barras,p.descripcion,p.stock_minimo,p.unidad_medida,p.estado,
    coalesce(sum(case
      when m.tipo in ('Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada') then m.cantidad
      when m.tipo in ('Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida') then -m.cantidad
      else 0 end),0) as stock_fisico_total,
    coalesce(sum(case when m.almacen_destino_id=9999 then m.cantidad when m.almacen_origen_id=9999 then -m.cantidad else 0 end),0) as stock_devoluciones,
    coalesce(sum(case when m.almacen_destino_id=9998 then m.cantidad when m.almacen_origen_id=9998 then -m.cantidad else 0 end),0) as stock_merma,
    coalesce((
      select mm.costo_unitario from public.movimientos mm
      where mm.producto_id=p.id
        and mm.tipo in ('Inventario Inicial','Compra','Ajuste administrativo - Entrada','Ajuste administrativo - Salida')
      order by mm.id desc limit 1
    ),0) as costo_unit,
    p.precio_usd,
    (select mm.id from public.movimientos mm where mm.producto_id=p.id and mm.tipo in ('Inventario Inicial','Compra') order by mm.id desc limit 1),
    (select mm.cantidad from public.movimientos mm where mm.producto_id=p.id and mm.tipo in ('Inventario Inicial','Compra') order by mm.id desc limit 1),
    (select mm.fecha_registro from public.movimientos mm where mm.producto_id=p.id and mm.tipo in ('Inventario Inicial','Compra') order by mm.id desc limit 1),
    (select mm.documento from public.movimientos mm where mm.producto_id=p.id and mm.tipo in ('Inventario Inicial','Compra') order by mm.id desc limit 1),
    coalesce(sum(case when m.almacen_destino_id in (9998,9999) then m.cantidad when m.almacen_origen_id in (9998,9999) then -m.cantidad else 0 end),0),
    coalesce(sum(case
      when m.tipo in ('Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada') then m.cantidad
      when m.tipo in ('Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida') then -m.cantidad
      else 0 end),0)
    - coalesce(sum(case when m.almacen_destino_id in (9998,9999) then m.cantidad when m.almacen_origen_id in (9998,9999) then -m.cantidad else 0 end),0),
    coalesce(sum(case
      when m.tipo in ('Inventario Inicial','Compra','Devolución por venta','Ajuste administrativo - Entrada') then m.cantidad
      when m.tipo in ('Venta','Descarga por daño/motivo','Devolución por compra','Ajuste administrativo - Salida') then -m.cantidad
      else 0 end),0)
      * coalesce((select mm.costo_unitario from public.movimientos mm where mm.producto_id=p.id and mm.tipo in ('Inventario Inicial','Compra','Ajuste administrativo - Entrada','Ajuste administrativo - Salida') order by mm.id desc limit 1),0)
  from public.productos p
  left join public.movimientos m on m.producto_id=p.id
  where (select private.app_has_permission('existencias'))
     or (select private.app_has_permission('kardex'))
     or (select private.app_has_permission('productos'))
  group by p.id
  order by p.descripcion asc
$$;

revoke all on function public.zuara_existencias() from public, anon;
grant execute on function public.zuara_existencias() to authenticated;
