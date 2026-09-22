"""
Verificación posterior a Neon -> Supabase.

Variables:
  NEON_DATABASE_URL
  SUPABASE_DATABASE_URL

No modifica ninguna base.
"""
import os
import psycopg2
from psycopg2.extras import RealDictCursor

TABLES = [
    "clientes","proveedores","almacenes","categorias","productos","movimientos",
    "ventas","detalle_nota_entrega","notas_credito","detalle_nota_credito",
    "historico_precios_dia","historico_tasas","historico_coberturas",
    "configuracion","usuarios"
]

def count(conn, table):
    with conn.cursor() as cur:
        cur.execute(f'SELECT COUNT(*) FROM public."{table}"')
        return cur.fetchone()[0]

def max_id(conn, table):
    if table in {"historico_precios_dia","configuracion"}:
        return None
    with conn.cursor() as cur:
        cur.execute(f'SELECT MAX(id) FROM public."{table}"')
        return cur.fetchone()[0]

def invalid_rate_dates(conn):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT id, fecha
            FROM public.historico_tasas
            WHERE fecha IS NULL
               OR fecha !~ '^\\d{4}-\\d{2}-\\d{2}$'
               OR fecha::date::text <> fecha
            ORDER BY id
        """)
        return cur.fetchall()

def main():
    neon = os.getenv("NEON_DATABASE_URL")
    supabase = os.getenv("SUPABASE_DATABASE_URL")
    if not neon or not supabase:
        raise SystemExit("Faltan NEON_DATABASE_URL y/o SUPABASE_DATABASE_URL.")

    src = psycopg2.connect(neon)
    dst = psycopg2.connect(supabase)
    try:
        print("TABLA | NEON | SUPABASE | DIF")
        print("-"*55)
        failed = False
        for table in TABLES:
            a=count(src,table); b=count(dst,table); diff=b-a
            print(f"{table:28} | {a:8} | {b:9} | {diff:4}")
            if diff != 0: failed=True

        print("\nMAX ID")
        for table in TABLES:
            a=max_id(src,table); b=max_id(dst,table)
            if a != b:
                failed=True
                print(f"{table}: Neon={a} Supabase={b}")

        bad=invalid_rate_dates(dst)
        if bad:
            failed=True
            print("\nFECHAS DE TASAS INVALIDAS EN SUPABASE:")
            for row in bad:
                print(f"  id={row['id']} fecha={row['fecha']!r}")
        else:
            print("\nFechas de tasas: OK")

        if failed:
            raise SystemExit(2)
        print("\nVERIFICACION OK")
    finally:
        src.close()
        dst.close()

if __name__ == "__main__":
    main()
