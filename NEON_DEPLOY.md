# ZUARA + Neon

## 1. GitHub secrets
In **Settings → Secrets and variables → Actions**, add:
- `NEON_API_KEY`: a Neon API key. Do not commit it and do not place it in the frontend.
- `NEON_PROJECT_ID`: the ZUARA Neon project ID.

## 2. Neon database
The workflow applies `migration/0004_neon_zuara_mutations.sql` to the `main` branch before deploying the Function.

## 3. GitHub Pages
In **Settings → Pages**, use **GitHub Actions** as the publishing source.

The existing workflow publishes only:
- `index.html`
- `static/`

The backend files and SQL migrations are not copied into the Pages artifact.

## 4. Neon Function URL
After the first successful Neon deployment, copy the public URL of the Function named **ZUARA API** and put it in:
`static/neon-config.js`

Replace:
`REEMPLAZAR_CON_URL_DE_NEON_FUNCTION`

with that HTTPS URL.

## 5. Comprobación técnica rápida
After deployment, open the Neon Function URL with `/api/health`. It should return JSON with `status: "ok"`, confirming that the Function can reach the Neon database before testing the full application.

The Neon deployment workflow is intentionally manual until the two GitHub Actions secrets are configured. After that, it can be changed back to automatic deployment on pushes.

## 6. Test order
Keep Render active while testing. Verify:
1. Login
2. Panel and counters
3. Clientes / proveedores / almacenes / categorías
4. Productos and stock
5. Tasas and lista de precios
6. Nota de entrega
7. Devolución / nota de crédito
8. Usuarios and permissions
9. Reports / historical data

Only after the complete test passes should Render be removed.

The frontend keeps the same `/api/...` contract used by the Flask version, so future fixes can normally be made in one backend file (`functions/zuara-api.ts`) and, when needed, one SQL mutation file (`migration/0004_neon_zuara_mutations.sql`).
