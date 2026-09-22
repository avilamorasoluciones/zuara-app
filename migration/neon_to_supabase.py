"""
Migración controlada Neon -> Supabase para ZUARA.

NO guarda credenciales en el repositorio.
Variables requeridas:
  NEON_DATABASE_URL
  SUPABASE_DATABASE_URL

Opcional:
  BATCH_SIZE=500

La migración no hace TRUNCATE. Inserta/actualiza por clave primaria y deja
intactas las columnas exclusivas de Supabase, como usuarios.auth_user_id.
Ejecutar primero 0001_zuara_schema.sql y 0002_business_functions.sql.
"""

import os
import psycopg
from psycopg.rows import dict_row

TABLE_ORDER = [
    "clientes",
    "proveedores",
    "almacenes",
    "categorias",
    "productos",
    "movimientos",
    "ventas",
    "detalle_nota_entrega",
    "notas_credito",
    "detalle_nota_credito",
    "historico_tasas",
    "historico_coberturas",
    "historico_precios_dia",
    "configuracion",
    "usuarios",
]

PRIMARY_KEYS = {
    "historico_precios_dia": ["fecha"],
    "configuracion": ["clave"],
}

BATCH_SIZE = int(os.getenv("BATCH_SIZE", "500"))


def get_columns(conn, table):
    with conn.cursor() as cur:
        cur.execute("""
            select column_name
            from information_schema.columns
            where table_schema='public' and table_name=%s
            order by ordinal_position
        """, (table,))
        return [r["column_name"] for r in cur.fetchall()]


def get_pk(conn, table):
    if table in PRIMARY_KEYS:
        return PRIMARY_KEYS[table]
    with conn.cursor() as cur:
        cur.execute("""
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
        """, (table,))
        return [r["column_name"] for r in cur.fetchall()]


def copy_table(src, dst, table):
    src_cols = set(get_columns(src, table))
    dst_cols = get_columns(dst, table)
    cols = [c for c in dst_cols if c in src_cols]

    if not cols:
        print(f"[SKIP] {table}: no hay columnas comunes")
        return 0

    pk = get_pk(dst, table)
    if not pk:
        raise RuntimeError(f"{table}: no se encontró clave primaria")

    # No sobrescribir el vínculo Supabase Auth si ya existe.
    if table == "usuarios" and "auth_user_id" in dst_cols:
        cols = [c for c in cols if c != "auth_user_id"]

    col_sql = ", ".join(f'"{c}"' for c in cols)
    placeholders = ", ".join(["%s"] * len(cols))
    updates = ", ".join(
        f'"{c}" = excluded."{c}"'
        for c in cols if c not in pk
    )

    if updates:
        conflict = f"do update set {updates}"
    else:
        conflict = "do nothing"

    statement = f'''
        insert into public."{table}" ({col_sql})
        values ({placeholders})
        on conflict ({", ".join(f'"{c}"' for c in pk)}) {conflict}
    '''

    copied = 0
    with src.cursor(row_factory=dict_row) as scur, dst.cursor() as dcur:
        scur.execute(f'select {col_sql} from public."{table}"')
        while True:
            rows = scur.fetchmany(BATCH_SIZE)
            if not rows:
                break
            values = [tuple(row[c] for c in cols) for row in rows]
            dcur.executemany(statement, values)
            copied += len(values)

    dst.commit()
    print(f"[OK] {table}: {copied}")
    return copied


def sync_sequences(dst):
    for table in TABLE_ORDER:
        if table in {"historico_precios_dia", "configuracion"}:
            continue
        with dst.cursor() as cur:
            cur.execute("""
                select pg_get_serial_sequence('public.%s', 'id')
            """ % table)
            row = cur.fetchone()
            seq = row[0] if row else None
            if not seq:
                continue
            cur.execute(
                f"select setval(%s, coalesce((select max(id) from public.%s),0)+1, false)"
                % ("%s", table),
                (seq,),
            )
    dst.commit()


def main():
    neon_url = os.getenv("NEON_DATABASE_URL")
    supabase_url = os.getenv("SUPABASE_DATABASE_URL")

    if not neon_url or not supabase_url:
        raise SystemExit(
            "Faltan NEON_DATABASE_URL y/o SUPABASE_DATABASE_URL. "
            "No se usan credenciales almacenadas en Git."
        )

    totals = {}
    with psycopg.connect(neon_url, row_factory=dict_row) as src,          psycopg.connect(supabase_url, row_factory=dict_row) as dst:
        for table in TABLE_ORDER:
            totals[table] = copy_table(src, dst, table)
        sync_sequences(dst)

    print("\nMigración terminada.")
    for table, count in totals.items():
        print(f"  {table}: {count}")


if __name__ == "__main__":
    main()
