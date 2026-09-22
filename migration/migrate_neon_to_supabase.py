"""
Migración controlada Neon -> Supabase para ZUARA APP.

No usa service_role en el navegador: este script es SOLO para ejecutar la
migración una vez desde un entorno seguro.

Variables:
  NEON_DATABASE_URL
  SUPABASE_DATABASE_URL

El script:
- conserva IDs y columnas existentes;
- conserva históricos y tasas válidas;
- no crea usuarios de Supabase Auth: usuarios se vinculan de forma perezosa
  al primer login mediante la Edge Function;
- no corrige ni descarta fechas de tasas malformadas silenciosamente: aborta
  y muestra cuáles deben corregirse antes de importar;
- conserva duplicados históricos que ya existieran en Neon;
- deja el endurecimiento de nuevos duplicados exactos para 0003_post_import_hardening.sql.
"""

import os
from datetime import date
import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_values, RealDictCursor

TABLES = [
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
    "historico_precios_dia",
    "historico_tasas",
    "historico_coberturas",
    "configuracion",
    "usuarios",
]

# auth_user_id no se copia: las cuentas de Supabase Auth se crean/vinculan
# de forma segura al primer inicio de sesión con la contraseña heredada.
EXCLUDED_COLUMNS = {"auth_user_id"}


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


def validate_rate_dates(conn):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            select id, fecha
            from public.historico_tasas
            order by id
            """
        )
        bad = []
        for row in cur.fetchall():
            value = row["fecha"]
            try:
                if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
                    raise ValueError
            except ValueError:
                bad.append((row["id"], value))
        return bad


def fetch_rows(conn, table, cols):
    with conn.cursor() as cur:
        cur.execute(
            sql.SQL("select {} from public.{}").format(
                sql.SQL(",").join(sql.Identifier(c) for c in cols),
                sql.Identifier(table),
            )
        )
        return cur.fetchall()


def upsert_rows(conn, table, cols, rows):
    if not rows:
        return 0

    conflict = "fecha" if table == "historico_precios_dia" else "clave" if table == "configuracion" else "id"
    if conflict not in cols:
        raise RuntimeError(f"La tabla {table} no tiene columna de conflicto esperada: {conflict}")

    update_cols = [c for c in cols if c != conflict]
    if update_cols:
        update_sql = sql.SQL(" DO UPDATE SET {}").format(
            sql.SQL(", ").join(
                sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c))
                for c in update_cols
            )
        )
    else:
        update_sql = sql.SQL(" DO NOTHING")

    statement = sql.SQL("INSERT INTO public.{} ({}) VALUES %s ON CONFLICT ({})").format(
        sql.Identifier(table),
        sql.SQL(",").join(sql.Identifier(c) for c in cols),
        sql.Identifier(conflict),
    ) + update_sql

    with conn.cursor() as cur:
        execute_values(cur, statement.as_string(conn), rows, page_size=500)
    return len(rows)


def reset_sequences(conn):
    for table in TABLES:
        if table in {"historico_precios_dia", "configuracion"}:
            continue
        with conn.cursor() as cur:
            cur.execute(
                """
                select pg_get_serial_sequence(%s, 'id')
                """,
                (f'public."{table}"',),
            )
            seq = cur.fetchone()[0]
            if not seq:
                continue
            cur.execute(
                sql.SQL(
                    "select setval(%s, coalesce((select max(id) from public.{table}), 1), true)"
                ).format(table=sql.Identifier(table)),
                (seq,),
            )


def main():
    neon_url = os.getenv("NEON_DATABASE_URL")
    supabase_url = os.getenv("SUPABASE_DATABASE_URL")
    if not neon_url or not supabase_url:
        raise SystemExit("Faltan NEON_DATABASE_URL y/o SUPABASE_DATABASE_URL.")

    src = psycopg2.connect(neon_url)
    dst = psycopg2.connect(supabase_url)
    try:
        bad = validate_rate_dates(src)
        if bad:
            print("SE DETIENE LA MIGRACIÓN: hay fechas de tasas inválidas en Neon.")
            for row_id, value in bad:
                print(f"  id={row_id} fecha={value!r}")
            raise SystemExit(2)

        print("Iniciando Neon -> Supabase...")
        for table in TABLES:
            src_cols = [c for c in columns(src, table) if c not in EXCLUDED_COLUMNS]
            dst_cols = [c for c in columns(dst, table) if c not in EXCLUDED_COLUMNS]
            common = [c for c in src_cols if c in dst_cols]
            if not common:
                print(f"{table}: sin columnas comunes, se omite.")
                continue

            rows = fetch_rows(src, table, common)
            count = upsert_rows(dst, table, common, rows)
            dst.commit()
            print(f"{table:28} {count:8} filas")

        reset_sequences(dst)
        dst.commit()
        print("\nMigración completada.")
        print("IMPORTANTE: después de verificar los datos, ejecutar:")
        print("  supabase/migrations/0003_post_import_hardening.sql")
    except Exception:
        dst.rollback()
        raise
    finally:
        src.close()
        dst.close()


if __name__ == "__main__":
    main()
