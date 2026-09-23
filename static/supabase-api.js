(function () {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const API = String(window.ZUARA_API_URL || '').replace(/\/$/, '');
  const TOKEN_KEY = 'zuara_neon_token';

  function responseJSON(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function authHeaders(headers = {}) {
    const out = new Headers(headers);
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) out.set('Authorization', 'Bearer ' + token);
    return out;
  }

  async function readBody(init) {
    let body = init?.body;
    if (body instanceof FormData) {
      const file = body.get('file');
      if (file && window.XLSX) {
        const ab = await file.arrayBuffer();
        const wb = XLSX.read(ab, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        const normalized = [];
        const toDate = (v) => {
          if (v instanceof Date) return v;
          if (typeof v === 'number' && XLSX.SSF?.parse_date_code) {
            const d = XLSX.SSF.parse_date_code(v);
            if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0));
          }
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? null : d;
        };
        for (const row of rows.slice(7)) {
          if (row[1] == null || row[1] === '') continue;
          const fechaObj = toDate(row[1]);
          if (!fechaObj) continue;
          const horaObj = toDate(row[9]);
          normalized.push({
            fecha: fechaObj.toISOString().slice(0, 10),
            hora: horaObj ? horaObj.toISOString().slice(11, 19) : String(row[9] || '').slice(0, 8),
            dolar_bcv: Number(row[2] || 0), binance: Number(row[3] || 0),
            bybit: Number(row[4] || 0), dolar_promedio: Number(row[5] || 0),
            euro_bcv: Number(row[6] || 0), zelle: Number(row[7] || 0),
            paypal: Number(row[8] || 0)
          });
        }
        return { rows: normalized };
      }
      return {};
    }
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch (_) { return {}; }
    }
    return body ?? {};
  }

  window.fetch = async function(input, init = {}) {
    const raw = typeof input === 'string' ? input : input?.url || '';
    let u;
    try { u = new URL(raw, window.location.origin); } catch (_) { return nativeFetch(input, init); }
    if (!u.pathname.startsWith('/api/')) return nativeFetch(input, init);

    if (!API || API.includes('REEMPLAZAR_CON_URL')) {
      return responseJSON({ error: 'ZUARA todavía no tiene configurada la URL de su Neon Function.' }, 503);
    }

    const method = String(init.method || 'GET').toUpperCase();
    const target = API + u.pathname + u.search;
    const headers = authHeaders(init.headers || {});
    if (method !== 'GET' && method !== 'HEAD' && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    if (u.pathname === '/api/auth/logout') {
      localStorage.removeItem(TOKEN_KEY);
      return responseJSON({ status: 'ok' });
    }

    if (u.pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(init);
      const r = await nativeFetch(target, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.clone().json().catch(() => ({}));
      if (r.ok && data?.token) localStorage.setItem(TOKEN_KEY, data.token);
      return r;
    }

    const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(await readBody(init));
    return nativeFetch(target, { ...init, method, headers, body });
  };

  window.fetchAllRows = async function(tabla) {
    const r = await window.fetch('/api/' + tabla);
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || 'No se pudo cargar ' + tabla);
    return r.json();
  };
})();
