# ZUARA APP — migración web estática + Supabase

Esta rama (`supabase-web-migration`) es el laboratorio de migración. La rama `main` de `zuara-app` no se reemplaza todavía.

## Arquitectura objetivo

~~~text
GitHub Pages
  └── index.html
      ├── static/style.css
      ├── static/main.js          ← UI y lógica de presentación existente
      ├── static/supabase-api.js  ← puente /api/... → Supabase
      └── static/supabase-config.js
                 │
                 ▼
          Supabase Auth
                 │
                 ▼
       PostgreSQL + RLS + RPC
                 │
                 └── Edge Functions
                     ├── zuara-login
                     └── zuara-api
~~~

GitHub Pages solo sirve archivos estáticos. La base de datos, autenticación y operaciones transaccionales viven en Supabase.

## Qué ya está preparado

- `index.html` en la raíz, listo para GitHub Pages.
- `supabase-config.js` con placeholders; no contiene credenciales reales.
- `supabase-api.js` conserva las llamadas `/api/...` del frontend para no rehacer la interfaz innecesariamente.
- Esquema PostgreSQL inicial en `supabase/migrations/0001_zuara_schema.sql`.
- Seguridad RLS y permisos ligados a Supabase Auth.
- Validación de fechas de tasas a nivel de PostgreSQL.
- `supabase/migrations/0002_business_functions.sql` contiene operaciones críticas transaccionales: movimientos, correcciones administrativas, facturación, notas de crédito/devoluciones, carga de tasas, configuración y eliminación controlada de ventas.
- La facturación conserva la regla: administrador → puede seleccionar fecha y se usa la tasa de esa fecha; usuario normal → queda forzado a la fecha operativa de Venezuela.
- `zuara-login` permite migrar progresivamente las cuentas existentes conservando la contraseña actual: la primera autenticación valida el hash de Werkzeug y vincula la cuenta con Supabase Auth.
- `zuara-api` centraliza operaciones que necesitan un entorno confiable.
- GitHub Actions preparado para publicar el sitio en GitHub Pages.

## Lo que NO debe hacerse todavía

No ejecutar un cambio de producción ni borrar `app.py`, `templates/` o los endpoints Flask de `main` hasta terminar las pruebas.

Tampoco debe ponerse una `sb_secret_...` o `service_role` en `static/supabase-config.js`.

## Falta para el corte definitivo

1. Crear/confirmar el proyecto Supabase exclusivo de ZUARA.
2. Colocar su URL y Publishable key en `static/supabase-config.js`.
3. Ejecutar las migraciones SQL.
4. Migrar los datos históricos desde Neon, sin perder IDs ni relaciones.
5. Verificar cuentas existentes y primer login.
6. Desplegar las dos Edge Functions.
7. Probar todos los módulos contra una copia de los datos.
8. Comparar resultados con la versión Flask, especialmente existencias, Kardex, tasas, lista de precios, facturación, notas de crédito, permisos, reportes y exportaciones PDF/Excel.
9. Activar GitHub Pages.
10. Solo después del visto bueno, decidir si se retira Render de la operación de ZUARA.

## Migración de datos

La migración debe hacerse desde la base Neon real a PostgreSQL de Supabase. No se deben inventar datos ni copiar el proyecto de Control de Producción.

La migración debe conservar, como mínimo: IDs, clientes, proveedores, almacenes, categorías, productos, movimientos/Kardex, ventas, detalle de notas de entrega, notas de crédito y sus detalles, tasas, coberturas, configuración, usuarios y sus permisos.

Las secuencias/identity de PostgreSQL deben sincronizarse después de importar los IDs históricos.

## Pruebas obligatorias antes de cortar

### Seguridad
- Usuario normal no puede actuar como administrador.
- Cambiar precio objetivo requiere administrador.
- Corrección de carga requiere administrador.
- Kardex y movimientos respetan permisos.
- Usuarios protegidos no se pueden eliminar.
- Nunca queda una operación sensible protegida únicamente por JavaScript.

### Tasas
- Fecha inválida rechazada por UI y DB.
- `2026-09-22` válida.
- Fechas imposibles rechazadas.
- La hora más reciente de la fecha seleccionada es la usada.
- Administrador puede preparar una factura con una fecha histórica que tenga tasa.
- Administrador recibe bloqueo si la fecha seleccionada no tiene tasa.
- Usuario normal usa siempre la fecha operativa de Venezuela.

### Inventario
- Venta reduce stock.
- Devolución por venta aumenta stock bloqueado en 9999.
- Merma afecta 9998.
- Corrección administrativa genera movimiento compensatorio.
- Una venta concurrente no puede producir stock negativo por carrera de operaciones.

### GitHub Pages
- Recarga directa de `index.html`.
- Recursos CSS/JS con rutas relativas.
- Sesión persistente y renovación de token.
- Sin dependencias de Flask/Render para llamadas de negocio.

## Regla de oro

La migración debe reproducir la lógica existente, no simplemente hacer que la pantalla parezca funcionar. Cada operación crítica debe conservar sus validaciones y, cuando afecte varias tablas, ejecutarse de forma atómica en PostgreSQL.