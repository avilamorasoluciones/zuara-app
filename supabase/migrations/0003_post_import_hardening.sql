-- ZUARA APP — endurecimiento posterior a la importación Neon -> Supabase.
-- Se ejecuta DESPUÉS de importar los datos.
-- No elimina históricos: incluso si Neon contiene duplicados antiguos, se conservan.
-- Desde este punto se bloquean nuevos duplicados exactos de tasa.

create or replace function private.bloquear_tasa_duplicada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.historico_tasas h
    where h.fecha = new.fecha
      and h.binance = new.binance
      and h.euro_bcv = new.euro_bcv
      and h.id <> coalesce(new.id, -1)
  ) then
    raise exception 'Ya existe una tasa con la misma fecha, Binance P2P y Euro BCV. No se registró un duplicado.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bloquear_tasa_duplicada on public.historico_tasas;
create trigger trg_bloquear_tasa_duplicada
before insert or update on public.historico_tasas
for each row execute function private.bloquear_tasa_duplicada();

revoke all on function private.bloquear_tasa_duplicada() from public, anon, authenticated;
