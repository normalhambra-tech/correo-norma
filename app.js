/* Correo Norma — web de gestión de correo sobre Gmail.
   Todo ocurre en el navegador: la web habla directamente con la API de Gmail
   usando el acceso que Norma concede al entrar con Google. */
(() => {
  "use strict";

  const CFG = window.CORREO_CONFIG;
  const API = "https://gmail.googleapis.com/gmail/v1/users/me";
  const L = CFG.etiquetas;

  const state = {
    token: null,
    tokenExp: 0,
    tokenClient: null,
    me: null,
    labels: {},        // nombre -> id
    labelsById: {},    // id -> nombre
    drafts: {},        // threadId -> { id, messageId }
    sendAs: [],
    queue: [],
    pos: 0,
    view: "bandeja",
    filtro: "",
    cache: {}          // threadId -> hilo completo
  };

  // ---------- utilidades ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function b64urlDecode(data) {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }
  function b64urlDecodeBytes(data) {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64); // cadena binaria
  }
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const toB64url = (b64) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const wrap76 = (b64) => b64.replace(/.{76}/g, "$&\r\n");
  const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8ToB64(s)}?=`);

  function header(msg, name) {
    const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : "";
  }
  function nombreDe(from) {
    const m = from.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/);
    return m ? m[1].trim() : from.replace(/[<>]/g, "");
  }
  function emailDe(from) {
    const m = from.match(/<([^>]+)>/);
    return (m ? m[1] : from).trim().toLowerCase();
  }
  function fecha(ms) {
    const d = new Date(Number(ms));
    const hoy = new Date();
    const mismoDia = d.toDateString() === hoy.toDateString();
    return mismoDia
      ? d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  }
  const isoDia = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function toast(msg, undoFn) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>` + (undoFn ? `<button type="button">Deshacer</button>` : "");
    t.hidden = false;
    if (undoFn) t.querySelector("button").onclick = async () => { t.hidden = true; await undoFn(); };
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 6000);
  }

  // ---------- acceso con Google ----------
  function initAuth() {
    const btn = $("#btn-entrar");
    const msg = $("#login-msg");
    if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 200); return; }
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.clientId,
      scope: CFG.scopes,
      callback: () => {}
    });
    try {
      const saved = JSON.parse(sessionStorage.getItem("cn_token") || "null");
      if (saved && saved.exp > Date.now() + 60000) {
        state.token = saved.token; state.tokenExp = saved.exp;
        arrancar();
        return;
      }
    } catch (_) {}
    btn.disabled = false;
    msg.textContent = "";
    btn.onclick = () => pedirToken("consent").then(arrancar).catch((e) => (msg.textContent = "No se pudo entrar: " + e.message));
  }

  function pedirToken(prompt = "") {
    return new Promise((resolve, reject) => {
      state.tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...CFG.scopes.split(" "))) {
          return reject(new Error("Faltan permisos. Marca todas las casillas al entrar."));
        }
        state.token = resp.access_token;
        state.tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        try { sessionStorage.setItem("cn_token", JSON.stringify({ token: state.token, exp: state.tokenExp })); } catch (_) {}
        resolve();
      };
      state.tokenClient.error_callback = (err) => reject(new Error(err?.message || "acceso cancelado"));
      state.tokenClient.requestAccessToken({ prompt });
    });
  }

  async function api(path, opts = {}, retry = true) {
    if (!state.token || Date.now() > state.tokenExp - 60000) await pedirToken("");
    const url = path.startsWith("http") ? path : API + path;
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: "Bearer " + state.token, "Content-Type": "application/json", ...(opts.headers || {}) }
    });
    if (res.status === 401 && retry) { state.token = null; return api(path, opts, false); }
    if (res.status === 429 && retry) { await sleep(1500); return api(path, opts, false); }
    if (!res.ok) {
      let detalle = "";
      try { detalle = (await res.json()).error?.message || ""; } catch (_) {}
      throw new Error(`Gmail ${res.status}${detalle ? ": " + detalle : ""}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async function enParalelo(items, fn, n = 6) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  // ---------- datos de Gmail ----------
  async function cargarEtiquetas() {
    const r = await api("/labels");
    state.labels = {}; state.labelsById = {};
    for (const l of r.labels || []) { state.labels[l.name] = l.id; state.labelsById[l.id] = l.name; }
    for (const nombre of [L.pedirBorrador, L.corregido, L.delegado, L.pospuesto]) {
      if (!state.labels[nombre]) {
        const nueva = await api("/labels", { method: "POST", body: JSON.stringify({ name: nombre, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
        state.labels[nombre] = nueva.id; state.labelsById[nueva.id] = nombre;
      }
    }
  }
  const lid = (nombre) => state.labels[nombre];

  async function cargarBorradores() {
    state.drafts = {};
    let pageToken = "";
    do {
      const r = await api(`/drafts?maxResults=200${pageToken ? "&pageToken=" + pageToken : ""}`);
      for (const d of r.drafts || []) state.drafts[d.message.threadId] = { id: d.id, messageId: d.message.id };
      pageToken = r.nextPageToken || "";
    } while (pageToken);
  }

  async function cargarSendAs() {
    try { state.sendAs = (await api("/settings/sendAs")).sendAs || []; } catch (_) { state.sendAs = []; }
  }

  async function listarHilos(labelIds, q = "", max = 50) {
    const params = new URLSearchParams({ maxResults: String(max) });
    for (const id of labelIds) if (id) params.append("labelIds", id);
    if (q) params.set("q", q);
    const r = await api("/threads?" + params.toString());
    return r.threads || [];
  }

  async function hiloMeta(id) {
    const hs = ["From", "To", "Cc", "Subject", "Date", "Delivered-To"].map((h) => "metadataHeaders=" + h).join("&");
    return api(`/threads/${id}?format=metadata&${hs}`);
  }

  async function hiloCompleto(id) {
    if (state.cache[id]) return state.cache[id];
    const t = await api(`/threads/${id}?format=full`);
    state.cache[id] = t;
    return t;
  }

  // Pospuestos: etiqueta "Pospuesto/AAAA-MM-DD". Si la fecha llegó, vuelve a la bandeja.
  async function restaurarPospuestos() {
    const hoy = isoDia(new Date());
    const vencidas = Object.entries(state.labels).filter(([n]) => n.startsWith(L.pospuesto + "/") && n.slice(L.pospuesto.length + 1) <= hoy);
    for (const [nombre, id] of vencidas) {
      const hilos = await listarHilos([id], "", 100);
      for (const h of hilos) {
        await api(`/threads/${h.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: ["INBOX"], removeLabelIds: [id] }) });
      }
      try { await api(`/labels/${id}`, { method: "DELETE" }); delete state.labels[nombre]; } catch (_) {}
    }
  }

  // ---------- clasificación para la bandeja ----------
  function organizacion(meta) {
    const texto = (meta.from + " " + meta.to + " " + meta.cc + " " + meta.deliveredTo + " " + meta.subject).toLowerCase();
    if (meta.labelIds.includes(lid(L.ayto)) || CFG.aytoPistas.some((p) => texto.includes(p))) return "Ayto";
    if (CFG.pmsgoPistas.some((p) => texto.includes(p))) return "PMS GO";
    if (texto.includes("22q13.org.es")) return "ASPM";
    return "Otros";
  }
  const ORDEN_ORG = { ASPM: 0, "PMS GO": 1, Ayto: 2, Otros: 3 };

  const BLOQUES = [
    { key: "urgente", titulo: "Urgente", color: "var(--c-urgente)", etiquetas: () => [L.urgente] },
    { key: "personal", titulo: "Personal", color: "var(--c-personal)", etiquetas: () => [L.personal, L.sensible] },
    { key: "ayto", titulo: "Trabajo Ayto", color: "var(--c-ayto)", etiquetas: () => [L.ayto] },
    { key: "responder", titulo: "Responder", color: "var(--c-responder)", etiquetas: () => [L.responder], porOrg: true },
    { key: "clave", titulo: "Personas clave", color: "var(--c-clave)", etiquetas: () => [L.clave] },
    { key: "firmar", titulo: "Firmar", color: "var(--c-firmar)", etiquetas: () => [L.firmar], porOrg: true },
    { key: "delegar", titulo: "Delegar", color: "var(--c-delegar)", etiquetas: () => [L.delegar] }
  ];

  function resumenMeta(t) {
    const msgs = t.messages || [];
    const ultimo = msgs[msgs.length - 1] || {};
    const primero = msgs[0] || {};
    const recibidos = msgs.filter((m) => !(m.labelIds || []).includes("SENT"));
    const ref = recibidos[recibidos.length - 1] || ultimo;
    const labelIds = [...new Set(msgs.flatMap((m) => m.labelIds || []))];
    return {
      id: t.id,
      from: header(ref, "From"),
      to: header(ref, "To"),
      cc: header(ref, "Cc"),
      deliveredTo: header(ref, "Delivered-To"),
      subject: header(primero, "Subject") || "(sin asunto)",
      snippet: ultimo.snippet || "",
      date: ultimo.internalDate,
      count: msgs.length,
      labelIds,
      ultimoMio: (ultimo.labelIds || []).includes("SENT")
    };
  }

  async function construirCola() {
    const vistos = new Set();
    const cola = [];
    for (const b of BLOQUES) {
      const ids = b.etiquetas().map(lid).filter(Boolean);
      const encontrados = [];
      for (const id of ids) {
        const hilos = await listarHilos([id, "INBOX"], "", 50);
        for (const h of hilos) if (!vistos.has(h.id)) { vistos.add(h.id); encontrados.push(h.id); }
      }
      const metas = await enParalelo(encontrados, async (id) => resumenMeta(await hiloMeta(id)));
      for (const m of metas) { m.bloque = b; m.org = organizacion(m); }
      metas.sort((a, b2) => (b.porOrg ? ORDEN_ORG[a.org] - ORDEN_ORG[b2.org] : 0) || Number(b2.date) - Number(a.date));
      cola.push(...metas);
    }
    return cola;
  }

  // ---------- cuerpo de los mensajes ----------
  function partes(payload, acc = { text: "", html: "", adjuntos: [] }) {
    if (!payload) return acc;
    const mime = payload.mimeType || "";
    if (payload.filename && payload.body?.attachmentId) {
      acc.adjuntos.push({ filename: payload.filename, mimeType: mime, attachmentId: payload.body.attachmentId, size: payload.body.size });
    } else if (mime === "text/plain" && payload.body?.data && !acc.text) {
      acc.text = b64urlDecode(payload.body.data);
    } else if (mime === "text/html" && payload.body?.data && !acc.html) {
      acc.html = b64urlDecode(payload.body.data);
    }
    for (const p of payload.parts || []) partes(p, acc);
    return acc;
  }

  function limpiarHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, iframe, object, embed, form").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((n) => {
      for (const a of [...n.attributes]) {
        if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
      }
    });
    return doc.body.innerHTML;
  }

  function htmlOriginal(hilo) {
    const bloques = (hilo.messages || []).map((m) => {
      const p = partes(m.payload);
      const cuerpo = p.html ? limpiarHtml(p.html) : `<pre style="white-space:pre-wrap;font:inherit">${esc(p.text || m.snippet)}</pre>`;
      const adj = p.adjuntos.length ? `<p style="color:#666">📎 ${p.adjuntos.map((a) => esc(a.filename)).join(", ")}</p>` : "";
      return `<div style="border-bottom:1px solid #ddd;padding:12px 0">
        <div style="color:#555;font-size:13px"><b>${esc(header(m, "From"))}</b> · ${esc(new Date(Number(m.internalDate)).toLocaleString("es-ES"))}</div>
        <div style="color:#555;font-size:13px">Para: ${esc(header(m, "To"))}</div>
        ${adj}<div>${cuerpo}</div></div>`;
    }).reverse().join("");
    return `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:15px/1.5 system-ui,sans-serif;margin:12px;color:#222}img{max-width:100%;height:auto}</style>${bloques}`;
  }

  // ---------- MIME ----------
  function construirMime({ from, to, cc, subject, inReplyTo, references, html, text, adjuntos = [] }) {
    const alt = "alt_" + Math.random().toString(36).slice(2);
    const lineas = [];
    if (from) lineas.push("From: " + from);
    lineas.push("To: " + to);
    if (cc) lineas.push("Cc: " + cc);
    lineas.push("Subject: " + encHeader(subject));
    if (inReplyTo) lineas.push("In-Reply-To: " + inReplyTo);
    if (references) lineas.push("References: " + references);
    lineas.push("MIME-Version: 1.0");

    const cuerpoAlt = [
      `Content-Type: multipart/alternative; boundary="${alt}"`, "",
      `--${alt}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(utf8ToB64(text || "")),
      `--${alt}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(utf8ToB64(html || esc(text || "").replace(/\n/g, "<br>"))),
      `--${alt}--`
    ].join("\r\n");

    if (!adjuntos.length) return lineas.join("\r\n") + "\r\n" + cuerpoAlt;

    const mix = "mix_" + Math.random().toString(36).slice(2);
    const partesAdj = adjuntos.map((a) => [
      `--${mix}`,
      `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${encHeader(a.filename)}"`,
      `Content-Disposition: attachment; filename="${encHeader(a.filename)}"`,
      "Content-Transfer-Encoding: base64", "", wrap76(a.b64)
    ].join("\r\n"));
    return lineas.join("\r\n") + "\r\n" +
      `Content-Type: multipart/mixed; boundary="${mix}"\r\n\r\n--${mix}\r\n` + cuerpoAlt + "\r\n" +
      partesAdj.join("\r\n") + `\r\n--${mix}--`;
  }

  // ---------- vistas ----------
  function mostrarVista(v) {
    state.view = v;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
    for (const s of ["bandeja", "leer", "seguimiento", "buscar"]) $("#view-" + s).hidden = s !== v;
    if (v === "bandeja") renderBandeja();
    if (v === "leer") renderLeer();
    if (v === "seguimiento") renderSeguimiento();
    if (v === "buscar") renderBuscar();
  }

  async function arrancar() {
    $("#view-login").hidden = true;
    $("#topbar").hidden = false;
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => mostrarVista(t.dataset.view)));
    $("#btn-salir").onclick = salir;
    const cont = $("#view-bandeja");
    cont.hidden = false;
    cont.innerHTML = `<div class="loading">Preparando tu bandeja…</div>`;
    try {
      state.me = (await api("/profile")).emailAddress;
      await cargarEtiquetas();
      await Promise.all([cargarBorradores(), cargarSendAs(), restaurarPospuestos()]);
      state.queue = await construirCola();
      state.pos = 0;
      mostrarVista("bandeja");
    } catch (e) {
      cont.innerHTML = `<div class="error-box">No se pudo cargar tu correo: ${esc(e.message)}</div>
        <button class="btn" id="reint">Reintentar</button>`;
      $("#reint").onclick = () => location.reload();
    }
  }

  function salir() {
    try { if (state.token) google.accounts.oauth2.revoke(state.token, () => {}); } catch (_) {}
    sessionStorage.removeItem("cn_token");
    location.reload();
  }

  // ----- Bandeja (modo vaciar) -----
  function colaFiltrada() {
    const f = state.filtro.trim().toLowerCase();
    if (!f) return state.queue;
    return state.queue.filter((m) => (m.from + " " + m.subject + " " + m.snippet + " " + m.org).toLowerCase().includes(f));
  }

  async function renderBandeja() {
    const cont = $("#view-bandeja");
    const cola = colaFiltrada();
    const pendientes = cola.length;
    const cab = `<div class="view-head"><h2>Bandeja</h2><span class="progress">${pendientes ? `${Math.min(state.pos + 1, pendientes)} / ${pendientes}` : ""}</span></div>
      <div class="filter-row"><input id="filtro" type="search" placeholder="Filtrar por persona, proyecto u organización (opcional)" value="${esc(state.filtro)}">
      <button class="btn btn-sm" id="recargar">↻ Actualizar</button></div>`;
    if (!pendientes) {
      cont.innerHTML = cab + `<div class="empty"><div class="big">🎉</div><p><b>Bandeja vacía.</b></p><p>No queda nada que requiera tu atención${state.filtro ? " con este filtro" : ""}.</p></div>`;
      conectarCabecera();
      return;
    }
    if (state.pos >= pendientes) state.pos = pendientes - 1;
    const m = cola[state.pos];
    cont.innerHTML = cab + `<div class="loading">Abriendo correo…</div>`;
    conectarCabecera();
    try {
      const hilo = await hiloCompleto(m.id);
      if (state.view !== "bandeja" || colaFiltrada()[state.pos] !== m) return;
      cont.innerHTML = cab + tarjeta(m, hilo);
      conectarCabecera();
      conectarTarjeta(m, hilo);
    } catch (e) {
      cont.innerHTML = cab + `<div class="error-box">${esc(e.message)}</div>`;
      conectarCabecera();
    }
  }

  function conectarCabecera() {
    const f = $("#filtro");
    if (f) f.oninput = () => { state.filtro = f.value; state.pos = 0; clearTimeout(f._t); f._t = setTimeout(renderBandeja, 350); };
    const r = $("#recargar");
    if (r) r.onclick = async () => {
      r.disabled = true; state.cache = {};
      await cargarBorradores(); state.queue = await construirCola(); state.pos = 0; renderBandeja();
    };
  }

  function chips(m) {
    const extra = [];
    if (m.labelIds.includes(lid(L.clave)) && m.bloque.key !== "clave") extra.push(`<span class="chip" style="--c:var(--c-clave)"><span class="dot"></span>Persona clave</span>`);
    if (m.labelIds.includes(lid(L.sensible))) extra.push(`<span class="chip" style="--c:var(--c-sensible)"><span class="dot"></span>🔒 Sensible</span>`);
    if (m.labelIds.includes(lid(L.urgente)) && m.bloque.key !== "urgente") extra.push(`<span class="chip" style="--c:var(--c-urgente)"><span class="dot"></span>Urgente</span>`);
    if (m.labelIds.includes(lid(L.pedirBorrador))) extra.push(`<span class="chip">✍ Borrador pedido</span>`);
    return `<div class="chips"><span class="chip" style="--c:${m.bloque.color}"><span class="dot"></span>${esc(m.bloque.titulo)}</span>
      <span class="chip">${esc(m.org)}</span>${extra.join("")}</div>`;
  }

  function tarjeta(m, hilo) {
    const d = state.drafts[m.id];
    const gmailUrl = `https://mail.google.com/mail/u/0/#all/${m.id}`;
    return `<article class="card" id="card">
      ${chips(m)}
      <div class="from">${esc(nombreDe(m.from))}</div>
      <div class="meta">${esc(emailDe(m.from))} · ${esc(fecha(m.date))}${m.count > 1 ? ` · ${m.count} mensajes` : ""}</div>
      <div class="subject">${esc(m.subject)}</div>
      <p class="snippet">${esc(m.snippet)}</p>
      <details class="original"><summary>Ver correo completo</summary><iframe sandbox="allow-popups allow-popups-to-escape-sandbox" title="Correo original" id="orig"></iframe></details>
      <div class="section-title">Borrador propuesto</div>
      ${d ? `<div class="draft-meta" id="draft-meta">Cargando borrador…</div><div class="draft" id="draft" contenteditable="true"></div>`
          : `<div class="no-draft">${m.labelIds.includes(lid(L.pedirBorrador)) ? "Borrador pedido: estará listo en la próxima pasada." : "Todavía no hay borrador para este correo."}</div>`}
      <div class="actions">
        ${d ? `<button class="btn btn-primary wide" data-a="enviar">✓ Enviar</button>` : `<button class="btn btn-primary wide" data-a="pedir">✍ Pídeme borrador</button>`}
        <button class="btn" data-a="delegar">→ Delegar</button>
        <button class="btn" data-a="posponer">⏰ Posponer</button>
        <button class="btn" data-a="etiqueta">🏷 Cambiar etiqueta</button>
        <button class="btn" data-a="archivar">🗄 Archivar</button>
        <button class="btn" data-a="saltar">Siguiente ›</button>
      </div>
      <div class="card-foot"><button class="link-btn" data-a="anterior">‹ Anterior</button><a class="small" href="${gmailUrl}" target="_blank" rel="noopener">Abrir en Gmail ↗</a></div>
    </article>`;
  }

  async function conectarTarjeta(m, hilo) {
    const det = $(".original");
    det.addEventListener("toggle", () => { if (det.open && !$("#orig").srcdoc) $("#orig").srcdoc = htmlOriginal(hilo); });
    const d = state.drafts[m.id];
    if (d) {
      try {
        const dr = await api(`/drafts/${d.id}?format=full`);
        d.full = dr;
        const p = partes(dr.message.payload);
        const from = header(dr.message, "From") || state.me;
        const to = header(dr.message, "To");
        $("#draft-meta").textContent = `De: ${from} · Para: ${to}`;
        $("#draft").innerHTML = p.html ? limpiarHtml(p.html) : esc(p.text).replace(/\n/g, "<br>");
      } catch (e) { $("#draft-meta").textContent = "No se pudo cargar el borrador: " + e.message; }
    }
    $("#card").querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => accion(b.dataset.a, m, hilo, b)));
  }

  function siguiente(quitar) {
    if (quitar) {
      const idx = state.queue.indexOf(colaFiltrada()[state.pos]);
      if (idx >= 0) state.queue.splice(idx, 1);
    } else {
      state.pos++;
    }
    if (state.pos >= colaFiltrada().length) state.pos = Math.max(0, colaFiltrada().length - 1);
    renderBandeja();
  }

  async function modificar(id, add = [], remove = []) {
    return api(`/threads/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add.filter(Boolean), removeLabelIds: remove.filter(Boolean) }) });
  }

  async function accion(a, m, hilo, btn) {
    try {
      if (a === "saltar") return siguiente(false);
      if (a === "anterior") { state.pos = Math.max(0, state.pos - 1); return renderBandeja(); }
      if (a === "archivar") {
        btn.disabled = true;
        await modificar(m.id, [], ["INBOX"]);
        const copia = m, pos = state.pos;
        siguiente(true);
        toast("Archivado", async () => { await modificar(copia.id, ["INBOX"], []); state.queue.splice(pos, 0, copia); state.pos = pos; renderBandeja(); });
        return;
      }
      if (a === "pedir") {
        await modificar(m.id, [lid(L.pedirBorrador)], []);
        m.labelIds.push(lid(L.pedirBorrador));
        toast("Borrador pedido. Lo tendrás en la próxima pasada.");
        return siguiente(false);
      }
      if (a === "enviar") return enviarBorrador(m, btn);
      if (a === "delegar") return dialogoDelegar(m, hilo);
      if (a === "posponer") return dialogoPosponer(m);
      if (a === "etiqueta") return dialogoEtiqueta(m);
    } catch (e) {
      toast("Error: " + e.message);
      if (btn) btn.disabled = false;
    }
  }

  async function enviarBorrador(m, btn) {
    const d = state.drafts[m.id];
    if (!d?.full) return toast("El borrador aún no ha cargado.");
    const ed = $("#draft");
    const msg = d.full.message;
    if (!confirm(`¿Enviar la respuesta a ${header(msg, "To")}?`)) return;
    btn.disabled = true;
    const raw = construirMime({
      from: header(msg, "From"),
      to: header(msg, "To"),
      cc: header(msg, "Cc"),
      subject: header(msg, "Subject"),
      inReplyTo: header(msg, "In-Reply-To"),
      references: header(msg, "References"),
      html: ed.innerHTML,
      text: ed.innerText
    });
    await api(`/drafts/${d.id}`, { method: "PUT", body: JSON.stringify({ id: d.id, message: { raw: toB64url(utf8ToB64(raw)), threadId: m.id } }) });
    await api("/drafts/send", { method: "POST", body: JSON.stringify({ id: d.id }) });
    delete state.drafts[m.id];
    await modificar(m.id, [], ["INBOX", lid(L.pedirBorrador)]);
    toast("Enviado ✓");
    siguiente(true);
  }

  // ----- Diálogos -----
  function modal(html, onMount) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const back = root.firstElementChild;
    const cerrar = () => (root.innerHTML = "");
    back.addEventListener("click", (e) => { if (e.target === back) cerrar(); });
    root.querySelectorAll("[data-cerrar]").forEach((b) => (b.onclick = cerrar));
    onMount?.(root, cerrar);
  }

  function dialogoDelegar(m, hilo) {
    const opts = CFG.equipo.map((p, i) => `<label class="opt"><input type="radio" name="p" value="${i}" ${i === 0 ? "checked" : ""}><span><b>${esc(p.nombre)}</b> <span class="muted small">${esc(p.email)}</span></span></label>`).join("");
    modal(`<h3>Delegar</h3>
      <p class="muted small">Se reenviará el correo con sus adjuntos desde ${esc(CFG.remitenteDelegar)}.</p>
      <div class="opts">${opts}</div>
      <textarea id="instr"></textarea>
      <div class="foot"><button class="btn" data-cerrar>Cancelar</button><button class="btn btn-primary" id="ok">Enviar reenvío</button></div>`,
    (root, cerrar) => {
      const ta = $("#instr", root);
      const texto = (p) => `${p.saludo}\n\nPara tu info, ¿te encargas tú? Gracias.\n\nUn abrazo,\nNorma`;
      ta.value = texto(CFG.equipo[0]);
      root.querySelectorAll("input[name=p]").forEach((r) => (r.onchange = () => (ta.value = texto(CFG.equipo[r.value]))));
      $("#ok", root).onclick = async (ev) => {
        ev.target.disabled = true;
        try {
          const p = CFG.equipo[root.querySelector("input[name=p]:checked").value];
          await reenviar(m, hilo, p.email, ta.value);
          await modificar(m.id, [lid(L.delegado)], ["INBOX"]);
          cerrar();
          toast(`Delegado a ${p.nombre} ✓`);
          siguiente(true);
        } catch (e) { ev.target.disabled = false; toast("Error: " + e.message); }
      };
    });
  }

  async function reenviar(m, hilo, destino, instrucciones) {
    const ultimo = [...hilo.messages].reverse().find((x) => !(x.labelIds || []).includes("SENT")) || hilo.messages[hilo.messages.length - 1];
    const p = partes(ultimo.payload);
    const adjuntos = [];
    let total = 0;
    for (const a of p.adjuntos) {
      total += a.size || 0;
      if (total > 20 * 1024 * 1024) break;
      const r = await api(`/messages/${ultimo.id}/attachments/${a.attachmentId}`);
      adjuntos.push({ filename: a.filename, mimeType: a.mimeType, b64: btoa(b64urlDecodeBytes(r.data)) });
    }
    const cabecera = `---------- Mensaje reenviado ----------\nDe: ${header(ultimo, "From")}\nFecha: ${header(ultimo, "Date")}\nAsunto: ${header(ultimo, "Subject")}\nPara: ${header(ultimo, "To")}\n\n`;
    const text = `${instrucciones}\n\n${cabecera}${p.text || ultimo.snippet}`;
    const html = `<div>${esc(instrucciones).replace(/\n/g, "<br>")}</div><br><div style="color:#555">${esc(cabecera).replace(/\n/g, "<br>")}</div>${p.html ? limpiarHtml(p.html) : esc(p.text).replace(/\n/g, "<br>")}`;
    const subject = /^(fwd?|rv):/i.test(m.subject) ? m.subject : "Fwd: " + m.subject;
    const from = state.sendAs.some((s) => s.sendAsEmail === CFG.remitenteDelegar) ? CFG.remitenteDelegar : "";
    const raw = construirMime({ from, to: destino, subject, html, text, adjuntos });
    await api("/messages/send", { method: "POST", body: JSON.stringify({ raw: toB64url(utf8ToB64(raw)) }) });
  }

  function dialogoPosponer(m) {
    const hoy = new Date();
    const manana = new Date(hoy); manana.setDate(hoy.getDate() + 1);
    const lunes = new Date(hoy); lunes.setDate(hoy.getDate() + ((8 - hoy.getDay()) % 7 || 7));
    const semana = new Date(hoy); semana.setDate(hoy.getDate() + 7);
    const f = (d) => d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    modal(`<h3>Posponer hasta…</h3>
      <div class="opts">
        <button class="btn" data-d="${isoDia(manana)}">Mañana <span class="muted small">(${f(manana)})</span></button>
        <button class="btn" data-d="${isoDia(lunes)}">El lunes <span class="muted small">(${f(lunes)})</span></button>
        <button class="btn" data-d="${isoDia(semana)}">En una semana <span class="muted small">(${f(semana)})</span></button>
      </div>
      <p>Otra fecha: <input type="date" id="otra" min="${isoDia(manana)}"></p>
      <div class="foot"><button class="btn" data-cerrar>Cancelar</button><button class="btn btn-primary" id="ok">Posponer</button></div>`,
    (root, cerrar) => {
      const aplicar = async (dia) => {
        if (!dia) return;
        const nombre = `${L.pospuesto}/${dia}`;
        if (!lid(nombre)) {
          const nueva = await api("/labels", { method: "POST", body: JSON.stringify({ name: nombre, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
          state.labels[nombre] = nueva.id;
        }
        await modificar(m.id, [lid(nombre)], ["INBOX"]);
        cerrar();
        toast(`Pospuesto hasta el ${new Date(dia + "T12:00").toLocaleDateString("es-ES", { day: "numeric", month: "long" })}`);
        siguiente(true);
      };
      root.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => aplicar(b.dataset.d).catch((e) => toast("Error: " + e.message))));
      $("#ok", root).onclick = () => aplicar($("#otra", root).value).catch((e) => toast("Error: " + e.message));
    });
  }

  function dialogoEtiqueta(m) {
    const posibles = [L.urgente, L.personal, L.ayto, L.responder, L.clave, L.firmar, L.delegar, L.leer, L.sensible];
    const opts = posibles.filter((n) => lid(n)).map((n) => `<label class="opt"><input type="checkbox" value="${esc(n)}" ${m.labelIds.includes(lid(n)) ? "checked" : ""}> ${esc(n)}</label>`).join("");
    modal(`<h3>Cambiar etiqueta</h3>
      <p class="muted small">Tu corrección queda registrada para que las próximas clasificaciones acierten más.</p>
      <div class="opts">${opts}</div>
      <div class="foot"><button class="btn" data-cerrar>Cancelar</button><button class="btn btn-primary" id="ok">Guardar</button></div>`,
    (root, cerrar) => {
      $("#ok", root).onclick = async () => {
        const marcadas = [...root.querySelectorAll("input:checked")].map((i) => lid(i.value));
        const todas = posibles.map(lid).filter(Boolean);
        const add = marcadas.filter((id) => !m.labelIds.includes(id)).concat(lid(L.corregido));
        const remove = todas.filter((id) => m.labelIds.includes(id) && !marcadas.includes(id));
        if (marcadas.includes(lid(L.leer))) remove.push("INBOX");
        try {
          await modificar(m.id, add, remove);
          cerrar();
          toast("Etiqueta cambiada ✓");
          state.queue = await construirCola();
          renderBandeja();
        } catch (e) { toast("Error: " + e.message); }
      };
    });
  }

  // ----- Solo leer -----
  async function renderLeer() {
    const cont = $("#view-leer");
    cont.innerHTML = `<div class="view-head"><h2>Solo leer</h2></div><div class="loading">Cargando…</div>`;
    try {
      const hilos = await listarHilos([lid(L.leer), "INBOX"], "", 100);
      const metas = await enParalelo(hilos.map((h) => h.id), async (id) => resumenMeta(await hiloMeta(id)));
      metas.sort((a, b) => Number(b.date) - Number(a.date));
      if (!metas.length) { cont.innerHTML = `<div class="view-head"><h2>Solo leer</h2></div><div class="empty"><div class="big">📭</div><p>Nada pendiente de leer.</p></div>`; return; }
      cont.innerHTML = `<div class="view-head"><h2>Solo leer</h2><button class="btn btn-sm" id="arch-todos">Archivar los ${metas.length}</button></div>
        <div class="list">${metas.map((m) => filaHtml(m, `<button class="btn btn-sm" data-arch="${m.id}">Archivar</button>`)).join("")}</div>`;
      conectarFilas(cont, metas);
      cont.querySelectorAll("[data-arch]").forEach((b) => (b.onclick = async () => {
        b.disabled = true;
        await modificar(b.dataset.arch, [], ["INBOX"]);
        b.closest(".row").remove();
      }));
      $("#arch-todos").onclick = async (ev) => {
        if (!confirm(`¿Archivar los ${metas.length} correos de «Solo leer»? Seguirán en Gmail, solo salen de la bandeja.`)) return;
        ev.target.disabled = true;
        await enParalelo(metas, (m) => modificar(m.id, [], ["INBOX"]), 4);
        toast("Archivados ✓");
        renderLeer();
      };
    } catch (e) { cont.innerHTML += `<div class="error-box">${esc(e.message)}</div>`; }
  }

  function filaHtml(m, extra = "") {
    return `<div class="row"><div class="row-main" data-open="${m.id}"><div class="t">${esc(nombreDe(m.from))} — ${esc(m.subject)}</div><div class="s">${esc(m.snippet)}</div></div>
      <span class="row-date">${esc(fecha(m.date))}</span>${extra}</div>`;
  }

  function conectarFilas(cont, metas) {
    cont.querySelectorAll("[data-open]").forEach((el) => (el.onclick = () => {
      const m = metas.find((x) => x.id === el.dataset.open);
      abrirSuelto(m);
    }));
  }

  // Abre un hilo fuera de la cola, como tarjeta, dentro de la bandeja
  function abrirSuelto(m) {
    if (!m.bloque) m.bloque = { key: "otro", titulo: "Correo", color: "var(--c-leer)" };
    if (!m.org) m.org = organizacion(m);
    const idx = state.queue.findIndex((x) => x.id === m.id);
    if (idx < 0) state.queue.unshift(m);
    state.filtro = "";
    state.pos = idx < 0 ? 0 : idx;
    mostrarVista("bandeja");
  }

  // ----- Seguimiento -----
  async function renderSeguimiento() {
    const cont = $("#view-seguimiento");
    const dias = CFG.diasSeguimiento;
    cont.innerHTML = `<div class="view-head"><h2>Seguimiento</h2></div>
      <div class="section-title">Sin responder (más de ${dias} días)</div><div id="seg-sin" class="loading">Buscando…</div>
      <div class="section-title">Esperando respuesta (más de ${dias} días)</div><div id="seg-esp" class="loading">Buscando…</div>
      <div class="section-title">Compromisos y plazos</div>
      <div class="card muted">Se rellenará automáticamente con las pasadas diarias (fase 3). Mientras tanto, las fechas cerradas ya se apuntan en tu Google Calendar.</div>`;
    try {
      const accion = [L.urgente, L.responder, L.firmar, L.clave].map((n) => lid(n)).filter(Boolean);
      const ids = new Set();
      for (const id of accion) (await listarHilos([id, "INBOX"], `older_than:${dias}d`, 50)).forEach((h) => ids.add(h.id));
      const sin = (await enParalelo([...ids], async (id) => resumenMeta(await hiloMeta(id)))).filter((m) => !m.ultimoMio);
      sin.sort((a, b) => Number(a.date) - Number(b.date));
      $("#seg-sin").className = "";
      $("#seg-sin").innerHTML = sin.length ? `<div class="list">${sin.map((m) => filaHtml(m)).join("")}</div>` : `<div class="card muted">Nada pendiente. 👍</div>`;
      conectarFilas($("#seg-sin"), sin);

      const enviados = await listarHilos(["SENT"], `older_than:${dias}d newer_than:30d`, 60);
      const esp = (await enParalelo(enviados.map((h) => h.id), async (id) => resumenMeta(await hiloMeta(id))))
        .filter((m) => m.ultimoMio && !/22q13\.org\.es/.test(m.to) );
      esp.sort((a, b) => Number(a.date) - Number(b.date));
      $("#seg-esp").className = "";
      $("#seg-esp").innerHTML = esp.length ? `<div class="list">${esp.map((m) => filaHtml({ ...m, from: "Tú → " + m.to })).join("")}</div>` : `<div class="card muted">Nadie te debe respuesta. 👍</div>`;
      conectarFilas($("#seg-esp"), esp);
    } catch (e) { cont.innerHTML += `<div class="error-box">${esc(e.message)}</div>`; }
  }

  // ----- Buscar -----
  function renderBuscar() {
    const cont = $("#view-buscar");
    if (cont.dataset.ready) return;
    cont.dataset.ready = "1";
    cont.innerHTML = `<div class="view-head"><h2>Buscar</h2></div>
      <form class="filter-row" id="fbus"><input id="q" type="search" placeholder="Busca como en Gmail: persona, asunto, palabras…" autocomplete="off"><button class="btn btn-primary">Buscar</button></form>
      <div id="res"></div>`;
    $("#fbus").onsubmit = async (e) => {
      e.preventDefault();
      const q = $("#q").value.trim();
      if (!q) return;
      const res = $("#res");
      res.innerHTML = `<div class="loading">Buscando…</div>`;
      try {
        const r = await api("/threads?" + new URLSearchParams({ q, maxResults: "30" }));
        const metas = await enParalelo((r.threads || []).map((t) => t.id), async (id) => resumenMeta(await hiloMeta(id)));
        res.innerHTML = metas.length ? `<div class="list">${metas.map((m) => filaHtml(m)).join("")}</div>` : `<div class="empty">Sin resultados.</div>`;
        conectarFilas(res, metas);
      } catch (err) { res.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
    };
  }

  window.addEventListener("load", initAuth);
})();
