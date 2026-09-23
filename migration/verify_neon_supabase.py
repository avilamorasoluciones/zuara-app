"""
Verificación fuerte posterior a Neon -> Supabase.

Variables:
  NEON_DATABASE_URL
  SUPABASE_DATABASE_URL

No modifica ninguna base. Comprueba conteos, máximos de ID y contenido
fila-a-fila mediante un hash SHA-256 estable sobre las columnas comunes.
"""

import hashlib
import json
import os

import psycopg2
from psycopg2.extras import RealDictCursor

TABLES = [
    "clientes", "proveedores", "almacenes", "categorias", "productos",
    "movimientos", "ventas", "detalle_nota_entrega", "notas_credito",
    "detalle_nota_credito", "historico_precios_dia", "historico_tasas",
    "historico_coberturas", "configuracion", "usuarios",
]


def columns(conn, table):
    with conn.cursor() as cur:
        cur.execute(
            """
            select column_name
            from information_schema.columns
            where table_schema='public' and table_name=%s
            order by ordinal_position
            """,
            (table,),
        )
        return [r[0] for r in cur.fetchall()]


def primary_key(conn, table):
    with conn.cursor() as cur:
        cur.execute(
            """
            select kcu.column_name
            from information_schema.table_constraints tc
            join information_schema.key_column_usage kcu
              on tc.constraint_name=kcu.constraint_name
             and tc.table_schema=kcu.table_schema
             and tc.table_name=kcu.table_name
            where tc.table_schema='public'
              and tc.table_name=%s
              and tc.constraint_type='PRIMARY KEY'
            order by kcu.ordinal_position
            """,
            (table,),
        )
        return [r[0] for r in cur.fetchall()]


def count(conn, table):
    with conn.cursor() as cur:
        cur.execute(f'SELECT COUNT(*) FROM public."{table}"')
        return cur.fetchone()[0]


def max_id(conn, table):
    if "id" not in columns(conn, table):
        return None
    with conn.cursor() as cur:
        cur.execute(f'SELECT MAX(id) FROM public."{table}"')
        return cur.fetchone()[0]


def stable_hash(conn, table, cols, pk):
    if not cols:
        return ""
    order_cols = pk or cols
    select_sql = ", ".join(f'"{c}"' for c in cols)
    order_sql = ", ".join(f'"{c}"' for c in order_cols)
    digest = hashlib.sha256()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            f'SELECT {select_sql} FROM public."{table}" ORDER BY {order_sql}'
        )
        while True:
            rows = cur.fetchmany(500)
            if not rows:
                break
            for row in rows:
                payload = json.dumps(
                    dict(row),
                    ensure_ascii=False,
                    sort_keys=True,
                    default=str,
                    separators=(",", ":"),
                ).encode("utf-8")
                digest.update(payload)
                digest.update(b"\n")
    return digest.hexdigest()


def invalid_rate_dates(conn):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, fecha
            FROM public.historico_tasas
            WHERE fecha IS NULL
               OR fecha !~ '^\\d{4}-\\d{2}-\\d{2}$'
               OR fecha::date::text <> fecha
            ORDER BY id
            """
        )
        return cur.fetchall()


def main():
    neon = os.getenv("NEON_DATABASE_URL")
    supabase = os.getenv("SUPABASE_DATABASE_URL")
    if not neon or not supabase:
        raise SystemExit("Faltan NEON_DATABASE_URL y/o SUPABASE_DATABASE_URL.")

    src = psycopg2.connect(neon)
    dst = psycopg2.connect(supabase)
    try:
        failed = False
        print("TABLA | NEON | SUPABASE | DIF | HASH")
        print("-" * 90)

        for table in TABLES:
            src_cols = set(columns(src, table))
            dst_cols = set(columns(dst, table))
            common = sorted((src_cols & dst_cols) - {"auth_user_id"})
            if not common:
                failed = True
                print(f"{table:28} | sin columnas comunes")
                continue

            src_count = count(src, table)
            dst_count = count(dst, table)
            diff = dst_count - src_count
            src_max = max_id(src, table)
            dst_max = max_id(dst, table)

            src_hash = stable_hash(src, table, common, primary_key(src, table))
            dst_hash = stable_hash(dst, table, common, primary_key(dst, table))

            ok = diff == 0 and src_max == dst_max and src_hash == dst_hash
            if not ok:
                failed = True

            print(
                f"{table:28} | {src_count:8} | {dst_count:9} | "
                f"{diff:3} | {'OK' if ok else 'FALLO'}"
            )
            if not ok:
                print(f"  max_id: Neon={src_max} Supabase={dst_max}")
                print(f"  hash:   Neon={src_hash}")
                print(f"          Supabase={dst_hash}")

        bad = invalid_rate_dates(dst)
        if bad:
            failed = True
            print("\nFECHAS DE TASAS INVALIDAS EN SUPABASE:")
            for row in bad:
                print(f"  id={row['id']} fecha={row['fecha']!r}")
        else:
            print("\nFechas de tasas: OK")

        if failed:
            raise SystemExit(2)

        print("\nVERIFICACION OK: conteos, IDs y contenido coinciden.")
    finally:
        src.close()
        dst.close()


if __name__ == "__main__":
    main()
