-- ZUARA APP — endurecimiento posterior a la importación Neon -> Supabase.
-- Ejecutar DESPUÉS de importar los datos. Los duplicados exactos de tasas
-- (misma fecha + mismo Binance P2P + mismo Euro BCV) no deben existir.
create unique index if not exists uq_historico_tasas_fecha_binance_euro
on public.historico_tasas(fecha, binance, euro_bcv);
