/* Correo Norma — web de gestión de correo sobre Gmail.
   Todo ocurre en el navegador: la web habla directamente con la API de Gmail
   usando el acceso que Norma concede al entrar con Google. */
(() => {
  "use strict";

  const CFG = window.CORREO_CONFIG;
  const API = "https://gmail.googleapis.com/gmail/v1/users/me";
  const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
  const LIMITE_ADJUNTOS = 24 * 1024 * 1024; // Gmail admite 25 MB por correo
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
    sel: new Set(),    // correos marcados en la bandeja
    abierto: null,     // { m, lista, origen } del correo que se está leyendo
    scroll: {},
    plegados: new Set((() => { try { return JSON.parse(localStorage.getItem("cn_plegados") || "[]"); } catch (_) { return []; } })()),
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
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const toB64url = (b64) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64urlToB64 = (s) => { const b = s.replace(/-/g, "+").replace(/_/g, "/"); return b + "===".slice((b.length + 3) % 4); };
  const wrap76 = (b64) => b64.replace(/.{76}/g, "$&\r\n");
  const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8ToB64(s)}?=`);

  // Direcciones: "Nombre <correo>, otro@correo" -> lista, y codificadas para la cabecera
  function dividirDirecciones(s) {
    const out = [];
    let cur = "", q = false, ang = false;
    for (const ch of String(s || "")) {
      if (ch === '"') q = !q;
      else if (ch === "<") ang = true;
      else if (ch === ">") ang = false;
      if ((ch === "," || ch === ";") && !q && !ang) { if (cur.trim()) out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function encDireccion(a) {
    const m = a.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (!m) return a.trim();
    const n = m[1].trim();
    if (!n) return m[2].trim();
    return `${/^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/"/g, "")}"` : encHeader(n)} <${m[2].trim()}>`;
  }
  const encDirecciones = (s) => dividirDirecciones(s).map(encDireccion).join(", ");

  function tamano(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
  }
  const extension = (nombre) => (String(nombre).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const MIME_POR_EXT = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    txt: "text/plain", csv: "text/csv", html: "text/html", htm: "text/html", xml: "text/xml",
    mp3: "audio/mpeg", mp4: "video/mp4", mov: "video/quicktime",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel", ods: "application/vnd.oasis.opendocument.spreadsheet"
  };
  function mimeReal(a) {
    const ext = extension(a.filename);
    if ((!a.mimeType || a.mimeType === "application/octet-stream") && MIME_POR_EXT[ext]) return MIME_POR_EXT[ext];
    return a.mimeType || MIME_POR_EXT[ext] || "application/octet-stream";
  }
  function icono(a) {
    const ext = extension(a.filename), mt = mimeReal(a);
    if (ext === "pdf") return "📄";
    if (mt.startsWith("image/")) return "🖼";
    if (["xlsx", "xls", "ods", "csv"].includes(ext)) return "📊";
    if (["doc", "docx", "odt", "rtf"].includes(ext)) return "📝";
    if (["zip", "rar", "7z"].includes(ext)) return "🗜";
    return "📎";
  }

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
    const esError = /^(error|no se pudo)/i.test(msg);
    t.classList.toggle("toast-error", esError);
    t.innerHTML = `<span>${esc(msg)}</span>` + (undoFn ? `<button type="button" data-undo>Deshacer</button>` : "") + (esError ? `<button type="button" data-x aria-label="Cerrar">✕</button>` : "");
    t.hidden = false;
    if (undoFn) t.querySelector("[data-undo]").onclick = async () => { t.hidden = true; await undoFn(); };
    if (esError) t.querySelector("[data-x]").onclick = () => (t.hidden = true);
    clearTimeout(toast._t);
    if (!esError) toast._t = setTimeout(() => (t.hidden = true), 6000); // los errores se quedan hasta cerrarlos
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

  // Google limita las consultas por minuto: si nos frena, esperamos y reintentamos solos
  const ESPERAS = [2000, 5000, 15000, 30000, 45000];
  async function api(path, opts = {}, retry = true, intento = 0) {
    if (!state.token || Date.now() > state.tokenExp - 60000) await pedirToken("");
    const url = path.startsWith("http") ? path : API + path;
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: "Bearer " + state.token, "Content-Type": "application/json", ...(opts.headers || {}) }
    });
    if (res.status === 401 && retry) { state.token = null; return api(path, opts, false, intento); }
    if (!res.ok) {
      let detalle = "";
      try { detalle = (await res.json()).error?.message || ""; } catch (_) {}
      const frenado = res.status === 429 || (res.status === 403 && /quota|rate limit/i.test(detalle));
      if (frenado && intento < ESPERAS.length) {
        const aviso = $(".loading");
        if (aviso && intento >= 1) aviso.textContent = "Gmail nos pide ir más despacio. Espera unos segundos, sigo cargando…";
        await sleep(ESPERAS[intento] + Math.random() * 1000);
        return api(path, opts, retry, intento + 1);
      }
      throw new Error(frenado ? "Gmail ha frenado las consultas un momento. Espera un minuto y pulsa Reintentar."
        : `Gmail ${res.status}${detalle ? ": " + detalle : ""}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // Envía o guarda un correo por la vía de subida de Gmail (admite adjuntos de hasta 25 MB)
  // Hasta ~5 MB se usa la vía normal de Gmail (si algo falla, Gmail explica el motivo).
  // Solo los correos más grandes van por la vía de subida, cuyos errores el navegador no deja leer.
  async function subirMime(tipo, raw, { threadId, draftId } = {}) {
    if (raw.length < 5 * 1024 * 1024) {
      const r64 = toB64url(utf8ToB64(raw));
      const message = threadId ? { raw: r64, threadId } : { raw: r64 };
      if (tipo === "enviar") return api("/messages/send", { method: "POST", body: JSON.stringify(message) });
      if (draftId) return api(`/drafts/${draftId}`, { method: "PUT", body: JSON.stringify({ id: draftId, message }) });
      return api("/drafts", { method: "POST", body: JSON.stringify({ message }) });
    }
    try { return await subirGrande(tipo, raw, { threadId, draftId }); }
    catch (e) {
      if (e instanceof TypeError) throw new Error("Gmail no ha aceptado el correo. Con adjuntos grandes, prueba a quitar alguno o a compartirlo desde Drive.");
      throw e;
    }
  }

  async function subirGrande(tipo, raw, { threadId, draftId } = {}) {
    const b = "cn_" + Math.random().toString(36).slice(2);
    let url, method = "POST", meta;
    if (tipo === "enviar") {
      url = UPLOAD + "/messages/send?uploadType=multipart";
      meta = threadId ? { threadId } : {};
    } else {
      url = UPLOAD + "/drafts" + (draftId ? "/" + draftId : "") + "?uploadType=multipart";
      if (draftId) method = "PUT";
      meta = { ...(draftId ? { id: draftId } : {}), message: threadId ? { threadId } : {} };
    }
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${b}\r\nContent-Type: message/rfc822\r\n\r\n${raw}\r\n--${b}--`;
    return api(url, { method, headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
  }

  async function enParalelo(items, fn, n = 3) {
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
    // Si Norma la ha fijado a mano, manda eso
    if (meta.labelIds.includes(lid(L.orgAspm))) return "ASPM";
    if (meta.labelIds.includes(lid(L.orgPmsgo))) return "PMS GO";
    if (meta.labelIds.includes(lid(L.personal)) || meta.labelIds.includes(lid(L.sensible))) return "Personal";
    if (meta.labelIds.includes(lid(L.ayto)) || CFG.aytoPistas.some((p) => texto.includes(p))) return "Ayto";
    if (CFG.pmsgoPistas.some((p) => texto.includes(p))) return "PMS GO";
    if (texto.includes("22q13.org.es")) return "ASPM";
    return "";
  }

  const BLOQUES = [
    { key: "urgente", titulo: "Urgente", color: "var(--c-urgente)", etiquetas: () => [L.urgente] },
    { key: "personal", titulo: "Personal", color: "var(--c-personal)", etiquetas: () => [L.personal, L.sensible] },
    { key: "ayto", titulo: "Trabajo Ayto", color: "var(--c-ayto)", etiquetas: () => [L.ayto] },
    { key: "responder", titulo: "Responder", color: "var(--c-responder)", etiquetas: () => [L.responder] },
    { key: "clave", titulo: "Personas clave", color: "var(--c-clave)", etiquetas: () => [L.clave] },
    { key: "firmar", titulo: "Firmar o decidir", color: "var(--c-firmar)", etiquetas: () => [L.firmar] },
    { key: "delegar", titulo: "Delegar", color: "var(--c-delegar)", etiquetas: () => [L.delegar] }
  ];
  const BLOQUE_SUELTO = { key: "otro", titulo: "Sin etiqueta", color: "var(--c-leer)" };
  const BLOQUE_LEER = { key: "leer", titulo: "Solo leer", color: "var(--c-leer)" };
  function bloqueDe(m) {
    // «Sensible» solo decide el bloque (Personal) si el correo no tiene otra etiqueta de prioridad
    const tiene = (n) => m.labelIds.includes(lid(n));
    return BLOQUES.find((b) => b.etiquetas().some((n) => n !== L.sensible && tiene(n)))
      || (tiene(L.sensible) ? BLOQUES.find((b) => b.key === "personal") : null)
      || (tiene(L.leer) ? BLOQUE_LEER : BLOQUE_SUELTO);
  }
  const ordenCola = (a, b) => BLOQUES.indexOf(a.bloque) - BLOQUES.indexOf(b.bloque) || Number(b.date) - Number(a.date);

  const decodificar = (s) => { const t = document.createElement("textarea"); t.innerHTML = s || ""; return t.value; };

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
      snippet: decodificar(ultimo.snippet),
      date: ultimo.internalDate,
      count: msgs.length,
      labelIds,
      adjunto: msgs.some((x) => /multipart\/mixed/i.test(x.payload?.mimeType || "")),
      ultimoMio: (ultimo.labelIds || []).includes("SENT")
    };
  }

  // Los datos de cada hilo se guardan mientras dura la sesión y solo se vuelven a pedir
  // si el hilo ha cambiado (historyId). Así la web hace muchas menos consultas a Gmail.
  const metaCache = new Map();
  try { for (const [k, v] of JSON.parse(sessionStorage.getItem("cn_meta") || "[]")) metaCache.set(k, v); } catch (_) {}
  function guardarMetaCache() {
    clearTimeout(guardarMetaCache._t);
    guardarMetaCache._t = setTimeout(() => {
      try { sessionStorage.setItem("cn_meta", JSON.stringify([...metaCache].slice(-600))); } catch (_) {}
    }, 500);
  }
  async function metasDe(hilos) {
    return enParalelo(hilos, async (h) => {
      const c = metaCache.get(h.id);
      if (c && h.historyId && c.historyId === h.historyId) return { ...c.meta, labelIds: [...c.meta.labelIds] };
      const meta = resumenMeta(await hiloMeta(h.id));
      metaCache.set(h.id, { historyId: h.historyId, meta });
      guardarMetaCache();
      return { ...meta, labelIds: [...meta.labelIds] };
    });
  }

  async function construirCola() {
    const vistos = new Map();
    for (const b of BLOQUES) {
      for (const id of b.etiquetas().map(lid).filter(Boolean)) {
        for (const h of await listarHilos([id, "INBOX"], "", 50)) vistos.set(h.id, h);
      }
    }
    const metas = await metasDe([...vistos.values()]);
    for (const m of metas) { m.bloque = bloqueDe(m); m.org = organizacion(m); }
    // por prioridad y, dentro de cada una, lo más reciente arriba
    return metas.filter((m) => BLOQUES.includes(m.bloque)).sort(ordenCola);
  }

  // ---------- cuerpo de los mensajes ----------
  const cabeceraParte = (p, name) => ((p.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase())?.value || "");

  function partes(payload, acc = { text: "", html: "", adjuntos: [], inline: [] }, msgId = "") {
    if (!payload) return acc;
    const mime = payload.mimeType || "";
    const cid = cabeceraParte(payload, "Content-ID").replace(/[<>\s]/g, "");
    const disp = cabeceraParte(payload, "Content-Disposition");
    const conDatos = payload.body?.attachmentId || (payload.body?.data && (payload.filename || cid));
    if (conDatos && (payload.filename || cid)) {
      const a = { filename: payload.filename || "imagen", mimeType: mime, attachmentId: payload.body.attachmentId, data: payload.body.data, size: payload.body.size, cid, msgId };
      const esInline = cid && mime.startsWith("image/") && !/^attachment/i.test(disp);
      if (esInline) acc.inline.push(a);
      if (payload.filename && !(esInline && /^inline/i.test(disp))) acc.adjuntos.push(a);
    } else if (mime === "text/plain" && payload.body?.data && !acc.text) {
      acc.text = b64urlDecode(payload.body.data);
    } else if (mime === "text/html" && payload.body?.data && !acc.html) {
      acc.html = b64urlDecode(payload.body.data);
    }
    for (const p of payload.parts || []) partes(p, acc, msgId);
    return acc;
  }

  // Convierte en enlace las direcciones web y de correo que vienen como texto
  const RE_URL = /(\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]|\bwww\.[^\s<>"'()]+[^\s<>"'().,;:!?]|\b[\w.+-]+@[\w-]+\.[\w.-]+\b)/gi;
  function enlazarTexto(texto) {
    return esc(texto).replace(RE_URL, (u) => {
      const href = u.includes("@") && !/^https?:|^www\./i.test(u) ? "mailto:" + u : (/^www\./i.test(u) ? "https://" + u : u);
      return `<a href="${href.replace(/&amp;/g, "&").replace(/"/g, "%22")}">${u}</a>`;
    });
  }
  function enlazarDom(doc) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const nodos = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement?.closest("a, style, script, textarea")) continue;
      RE_URL.lastIndex = 0;
      if (RE_URL.test(n.nodeValue)) nodos.push(n);
    }
    for (const n of nodos) {
      const span = doc.createElement("span");
      span.innerHTML = enlazarTexto(n.nodeValue);
      n.replaceWith(...span.childNodes);
    }
  }

  function limpiarHtml(html, { enlazar = false, estilos = false } = {}) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, iframe, object, embed, form, base, meta, link").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((n) => {
      for (const a of [...n.attributes]) {
        if (/^on/i.test(a.name) || (/^(href|src|action|formaction)$/i.test(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value))) n.removeAttribute(a.name);
      }
    });
    // Todos los enlaces se abren en una pestaña nueva (antes algunos quedaban bloqueados)
    doc.querySelectorAll("a[href]").forEach((a) => { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); });
    if (enlazar) enlazarDom(doc);
    const css = estilos ? [...doc.querySelectorAll("style")].map((s) => s.outerHTML).join("") : "";
    return css + doc.body.innerHTML;
  }

  function htmlOriginal(hilo) {
    const bloques = (hilo.messages || []).map((m) => {
      const p = partes(m.payload, undefined, m.id);
      const cuerpo = p.html ? limpiarHtml(p.html, { enlazar: true, estilos: true })
        : `<div style="white-space:pre-wrap">${enlazarTexto(p.text || m.snippet)}</div>`;
      const adj = p.adjuntos.length ? `<p style="color:#666">📎 ${p.adjuntos.map((a) => esc(a.filename)).join(", ")} <i>(los tienes arriba, en «Adjuntos»)</i></p>` : "";
      return `<div class="cn-msg" style="border-bottom:1px solid #ddd;padding:12px 0">
        <div style="color:#555;font-size:13px"><b>${esc(header(m, "From"))}</b> · ${esc(new Date(Number(m.internalDate)).toLocaleString("es-ES"))}</div>
        <div style="color:#555;font-size:13px">Para: ${esc(header(m, "To"))}${header(m, "Cc") ? " · Cc: " + esc(header(m, "Cc")) : ""}</div>
        ${adj}<div>${cuerpo}</div></div>`;
    }).reverse().join("");
    return `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:15px/1.5 system-ui,sans-serif;margin:12px;color:#222;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#1a5fb4}</style>${bloques}`;
  }

  // Muestra el correo en el marco y hace que enlaces, imágenes y altura funcionen
  function montarCorreo(iframe, hilo) {
    iframe.onload = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      // El marco crece con el correo: se lee entero haciendo scroll en la página, sin barras dentro
      const ajustar = () => { iframe.style.height = Math.max(doc.body.scrollHeight + 32, 120) + "px"; };
      ajustar();
      doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", ajustar));
      try { new ResizeObserver(ajustar).observe(doc.body); } catch (_) {}
      doc.addEventListener("click", (e) => {
        const a = e.target.closest?.("a[href]");
        if (!a) return;
        const href = a.getAttribute("href") || "";
        if (href.startsWith("#")) return;
        e.preventDefault();
        if (/^mailto:/i.test(href)) {
          const [dir, query] = href.slice(7).split("?");
          const qs = new URLSearchParams(query || "");
          return abrirRedactor({ modo: "nuevo", para: decodeURIComponent(dir), asunto: qs.get("subject") || "" });
        }
        window.open(a.href, "_blank", "noopener");
      });
      // Imágenes incrustadas (cid:)
      const inline = (hilo.messages || []).flatMap((m) => partes(m.payload, undefined, m.id).inline);
      doc.querySelectorAll('img[src^="cid:"]').forEach(async (img) => {
        const cid = img.getAttribute("src").slice(4).replace(/[<>]/g, "");
        const a = inline.find((x) => x.cid === cid);
        if (!a) return;
        try { img.src = URL.createObjectURL(await blobDeAdjunto(a)); } catch (_) {}
      });
    };
    iframe.srcdoc = htmlOriginal(hilo);
  }

  // ---------- adjuntos: leer, ver y descargar ----------
  async function datosAdjunto(a) { // base64 estándar
    if (a.b64) return a.b64;
    if (a.data) return (a.b64 = b64urlToB64(a.data));
    const r = await api(`/messages/${a.msgId}/attachments/${a.attachmentId}`);
    return (a.b64 = b64urlToB64(r.data));
  }
  async function blobDeAdjunto(a) {
    if (a.file) return a.file;
    const bin = atob(await datosAdjunto(a));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mimeReal(a) });
  }
  function descargar(url, nombre) {
    const link = document.createElement("a");
    link.href = url; link.download = nombre; link.rel = "noopener";
    document.body.appendChild(link); link.click(); link.remove();
  }
  const cargarScript = (src) => (cargarScript[src] ||= new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => ko(new Error("no se pudo cargar el visor"));
    document.head.appendChild(s);
  }));
  const LIB_WORD = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js";
  const LIB_EXCEL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
  const docVisor = (cuerpo) => `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:15px/1.5 system-ui,sans-serif;margin:16px;color:#222;background:#fff}img{max-width:100%}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #ccc;padding:3px 6px;vertical-align:top}h3{font:700 14px system-ui;margin:18px 0 6px;color:#256d5a}</style>${cuerpo}`;

  async function verAdjunto(a) {
    modal(`<div class="visor-head"><h3 title="${esc(a.filename)}">${icono(a)} ${esc(a.filename)}</h3><span class="muted small">${esc(tamano(a.size))}</span></div>
      <div class="visor" id="visor"><div class="loading">Abriendo documento…</div></div>
      <div class="foot"><button class="btn" data-cerrar>Cerrar</button><button class="btn" id="v-tab" disabled>↗ Abrir en pestaña nueva</button><button class="btn btn-primary" id="v-desc" disabled>⬇ Descargar</button></div>`,
    async (root) => {
      const visor = $("#visor", root);
      let url;
      try {
        const blob = await blobDeAdjunto(a);
        url = URL.createObjectURL(blob);
        const tipo = mimeReal(a), ext = extension(a.filename);
        $("#v-desc", root).disabled = false; $("#v-tab", root).disabled = false;
        $("#v-desc", root).onclick = () => descargar(url, a.filename);
        $("#v-tab", root).onclick = () => window.open(url, "_blank", "noopener");
        if (tipo === "application/pdf" || tipo.startsWith("text/plain")) {
          visor.innerHTML = `<iframe title="Documento" src="${url}"></iframe>`;
        } else if (tipo.startsWith("image/")) {
          visor.innerHTML = `<img alt="${esc(a.filename)}" src="${url}">`;
        } else if (tipo.startsWith("video/")) {
          visor.innerHTML = `<video controls src="${url}"></video>`;
        } else if (tipo.startsWith("audio/")) {
          visor.innerHTML = `<audio controls src="${url}"></audio>`;
        } else if (tipo === "text/html") {
          const f = document.createElement("iframe");
          f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox"); f.title = "Documento";
          f.srcdoc = docVisor(limpiarHtml(await blob.text()));
          visor.replaceChildren(f);
        } else if (ext === "docx") {
          await cargarScript(LIB_WORD);
          const r = await window.mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
          const f = document.createElement("iframe");
          f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox"); f.title = "Documento";
          f.srcdoc = docVisor(limpiarHtml(r.value));
          visor.replaceChildren(f);
        } else if (["xlsx", "xls", "ods", "csv"].includes(ext)) {
          await cargarScript(LIB_EXCEL);
          const wb = window.XLSX.read(await blob.arrayBuffer(), { type: "array" });
          const html = wb.SheetNames.map((n) => `<h3>${esc(n)}</h3>` + window.XLSX.utils.sheet_to_html(wb.Sheets[n], { header: "", footer: "" })).join("");
          const f = document.createElement("iframe");
          f.setAttribute("sandbox", ""); f.title = "Hoja de cálculo";
          f.srcdoc = docVisor(limpiarHtml(html));
          visor.replaceChildren(f);
        } else {
          visor.innerHTML = `<div class="empty"><div class="big">${icono(a)}</div><p>Este tipo de archivo no se puede ver aquí.</p><p class="small">Descárgalo y se abrirá con el programa de tu ordenador.</p></div>`;
        }
      } catch (e) {
        visor.innerHTML = `<div class="error-box">No se pudo abrir: ${esc(e.message)}</div>`;
      }
    }, { alCerrar: () => url && setTimeout(() => URL.revokeObjectURL(url), 60000), clase: "big" });
  }

  async function descargarAdjunto(a, btn) {
    if (btn) btn.disabled = true;
    try {
      const url = URL.createObjectURL(await blobDeAdjunto(a));
      descargar(url, a.filename);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast("No se pudo descargar: " + e.message); }
    if (btn) btn.disabled = false;
  }

  function listaAdjuntosHtml(adjs) {
    return `<div class="adj-list">${adjs.map((a, i) => `<div class="adj">
      <button class="adj-main" data-ver="${i}" title="Ver"><span class="adj-ico">${icono(a)}</span><span class="adj-name">${esc(a.filename)}</span><span class="adj-size">${esc(tamano(a.size))}</span></button>
      <button class="btn btn-sm" data-ver="${i}">Ver</button><button class="btn btn-sm" data-desc="${i}" title="Descargar">⬇</button></div>`).join("")}</div>`;
  }
  function conectarAdjuntos(cont, adjs) {
    cont.querySelectorAll("[data-ver]").forEach((b) => (b.onclick = () => verAdjunto(adjs[b.dataset.ver])));
    cont.querySelectorAll("[data-desc]").forEach((b) => (b.onclick = () => descargarAdjunto(adjs[b.dataset.desc], b)));
  }

  // Selector de archivos para adjuntar (lo usan el borrador y el redactor)
  function leerArchivo(file) {
    return new Promise((ok, ko) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1] || "");
      r.onerror = () => ko(r.error);
      r.readAsDataURL(file);
    });
  }
  function selectorAdjuntos(cont, lista, zonaSoltar) {
    const pintar = () => {
      const total = lista.reduce((s, a) => s + (a.size || 0), 0);
      cont.innerHTML = `<div class="adj-edit">${lista.map((a, i) => `<span class="adj-pill" title="${esc(a.filename)}">${icono(a)} <span class="adj-name">${esc(a.filename)}</span> <span class="muted">${esc(tamano(a.size))}</span><button type="button" data-quitar="${i}" aria-label="Quitar">✕</button></span>`).join("")}</div>
        <div class="adj-bar"><button type="button" class="btn btn-sm" data-add>📎 Adjuntar archivo</button>
        ${lista.length ? `<span class="small ${total > LIMITE_ADJUNTOS ? "danger" : "muted"}">${lista.length} archivo${lista.length > 1 ? "s" : ""} · ${esc(tamano(total))}${total > LIMITE_ADJUNTOS ? " — supera el límite de 25 MB de Gmail" : ""}</span>` : `<span class="small muted">o arrastra aquí los archivos</span>`}</div>
        <input type="file" multiple hidden>`;
      const input = cont.querySelector("input[type=file]");
      cont.querySelector("[data-add]").onclick = () => input.click();
      input.onchange = () => { anadir(input.files); };
      cont.querySelectorAll("[data-quitar]").forEach((b) => (b.onclick = () => { lista.splice(Number(b.dataset.quitar), 1); pintar(); }));
    };
    const anadir = (files) => {
      for (const f of files) lista.push({ filename: f.name, mimeType: f.type || MIME_POR_EXT[extension(f.name)] || "application/octet-stream", size: f.size, file: f });
      pintar();
    };
    const zona = zonaSoltar || cont;
    zona.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); zona.classList.add("drop"); } });
    zona.addEventListener("dragleave", (e) => { if (!zona.contains(e.relatedTarget)) zona.classList.remove("drop"); });
    zona.addEventListener("drop", (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); zona.classList.remove("drop"); anadir(e.dataTransfer.files); });
    pintar();
  }
  // ---------- dictado por voz (Chrome y Edge) ----------
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  let dictadoActivo = null;
  const COMANDOS_VOZ = [
    [/\s*punto y aparte\s*/gi, ".\n"], [/\s*nueva línea\s*/gi, "\n"], [/\s*punto y seguido\s*/gi, ". "],
    [/\s*dos puntos\s*/gi, ": "], [/\s*punto y coma\s*/gi, "; "], [/\s*coma\s*/gi, ", "], [/\s*punto\s*/gi, ". "],
    [/\s*abrir interrogación\s*/gi, " ¿"], [/\s*cerrar interrogación\s*/gi, "? "],
    [/\s*abrir exclamación\s*/gi, " ¡"], [/\s*cerrar exclamación\s*/gi, "! "]
  ];
  function textoDictado(t, anterior) {
    for (const [re, s] of COMANDOS_VOZ) t = t.replace(re, s);
    t = t.replace(/ +/g, " ");
    const inicioFrase = !anterior.trim() || /[.!?¡¿\n]\s*$/.test(anterior);
    if (inicioFrase) t = t.replace(/^\s*(\S)/, (x, c) => c.toUpperCase());
    t = t.replace(/([.!?]\s+|\n)(\p{Ll})/gu, (x, p, c) => p + c.toUpperCase());
    if (anterior && !/[\s\n]$/.test(anterior) && !/^[\s.,;:!?\n]/.test(t)) t = " " + t;
    return t;
  }
  function botonDictar(btn, editor) {
    if (!btn) return;
    if (!Reconocimiento) { btn.hidden = true; return; }
    btn.onclick = () => {
      if (dictadoActivo) { dictadoActivo.stop(); return; }
      const rec = new Reconocimiento();
      rec.lang = "es-ES"; rec.continuous = true; rec.interimResults = true;
      // Marca donde está el cursor (o antes de la firma) para ir escribiendo ahí
      const marca = document.createElement("span");
      marca.className = "dictando";
      const sel = window.getSelection();
      if (sel.rangeCount && editor.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); r.collapse(false); r.insertNode(marca); }
      else {
        const primero = editor.firstElementChild;
        if (primero && primero.tagName === "DIV" && !primero.classList.contains("cn-firma") && !primero.textContent.trim()) { primero.innerHTML = ""; primero.appendChild(marca); }
        else { const firma = editor.querySelector(".cn-firma"); firma ? firma.before(marca) : editor.appendChild(marca); }
      }
      const previo = () => { const r = document.createRange(); r.selectNodeContents(editor); r.setEndBefore(marca); return r.toString(); };
      rec.onresult = (e) => {
        let prov = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) {
            const texto = textoDictado(t, previo());
            texto.split("\n").forEach((trozo, k) => { if (k) marca.before(document.createElement("br")); if (trozo) marca.before(document.createTextNode(trozo)); });
          } else prov += t;
        }
        marca.textContent = prov;
        editor.dispatchEvent(new Event("input"));
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("No se pudo dictar: permite el uso del micrófono en el navegador.");
        else if (!["no-speech", "aborted"].includes(e.error)) toast("No se pudo dictar: " + e.error);
      };
      rec.onend = () => {
        marca.remove(); dictadoActivo = null;
        btn.classList.remove("on"); btn.textContent = "🎤 Dictar";
        editor.dispatchEvent(new Event("input"));
      };
      rec.start();
      dictadoActivo = rec;
      btn.classList.add("on"); btn.textContent = "⏹ Parar dictado";
    };
  }

  async function prepararAdjuntos(lista) {
    const total = lista.reduce((s, a) => s + (a.size || 0), 0);
    if (total > LIMITE_ADJUNTOS) throw new Error("los adjuntos pasan de 25 MB. Quita alguno o compártelo desde Drive.");
    return enParalelo(lista, async (a) => ({ filename: a.filename, mimeType: mimeReal(a), b64: a.file ? await leerArchivo(a.file) : await datosAdjunto(a) }), 3);
  }

  // ---------- MIME ----------
  function construirMime({ from, to, cc, bcc, subject, inReplyTo, references, html, text, adjuntos = [] }) {
    const alt = "alt_" + Math.random().toString(36).slice(2);
    const lineas = [];
    if (from) lineas.push("From: " + encDirecciones(from));
    if (to) lineas.push("To: " + encDirecciones(to));
    if (cc) lineas.push("Cc: " + encDirecciones(cc));
    if (bcc) lineas.push("Bcc: " + encDirecciones(bcc));
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
  const VISTAS = ["bandeja", "correo", "borradores", "leer", "seguimiento", "buscar"];
  function mostrarVista(v, { render = true } = {}) {
    state.view = v;
    const tab = v === "correo" ? (state.abierto?.origen || "bandeja") : v;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === tab));
    for (const s of VISTAS) $("#view-" + s).hidden = s !== v;
    document.body.classList.toggle("leyendo", v === "correo");
    if (!render) return;
    if (v === "bandeja") renderBandeja();
    if (v === "correo") renderCorreo();
    if (v === "borradores") renderBorradores();
    if (v === "leer") renderLeer();
    if (v === "seguimiento") renderSeguimiento();
    if (v === "buscar") renderBuscar();
  }

  async function arrancar() {
    $("#view-login").hidden = true;
    $("#topbar").hidden = false;
    const altoBarra = () => document.documentElement.style.setProperty("--topbar-h", $("#topbar").offsetHeight + "px");
    altoBarra();
    window.addEventListener("resize", altoBarra);
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => { state.abierto = null; mostrarVista(t.dataset.view); window.scrollTo(0, 0); }));
    $("#btn-salir").onclick = salir;
    $("#btn-redactar").onclick = () => abrirRedactor({ modo: "nuevo" });
    const cont = $("#view-bandeja");
    cont.hidden = false;
    cont.innerHTML = `<div class="loading">Preparando tu bandeja…</div>`;
    try {
      state.me = (await api("/profile")).emailAddress;
      await cargarEtiquetas();
      await Promise.all([cargarBorradores(), cargarSendAs(), restaurarPospuestos()]);
      state.queue = await construirCola();
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
    sessionStorage.removeItem("cn_meta");
    location.reload();
  }

  async function modificar(id, add = [], remove = []) {
    return api(`/threads/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add.filter(Boolean), removeLabelIds: remove.filter(Boolean) }) });
  }

  // ----- Filas de correo (se usan en todas las listas) -----
  function etiquetasFila(m) {
    const t = [];
    t.push(chipEtq(m));
    if (m.org && m.org !== m.bloque.titulo && !(m.org === "Ayto" && m.bloque.key === "ayto")) t.push(`<button type="button" class="tag tag-org etq-org" data-etq="${m.id}" data-org="${esc(m.org)}" title="Cambiar organización">${esc(m.org)} ▾</button>`);
    if (m.labelIds.includes(lid(L.sensible))) t.push(`<span class="tag">🔒 Sensible</span>`);
    if (state.drafts[m.id]) t.push(`<span class="tag tag-draft">✍ Borrador listo</span>`);
    else if (m.labelIds.includes(lid(L.pedirBorrador))) t.push(`<span class="tag">✍ Pedido</span>`);
    if (m.adjunto) t.push(`<span class="tag tag-adj" title="Trae adjuntos">📎</span>`);
    return t.join("");
  }

  // ----- Etiqueta con desplegable: pasar el ratón (o tocar) para cambiarla -----
  const OPCIONES_ETQ = () => [...BLOQUES.map((b) => ({ nombre: b.etiquetas()[0], titulo: b.titulo, color: b.color, key: b.key })),
    { nombre: L.leer, titulo: BLOQUE_LEER.titulo, color: BLOQUE_LEER.color, key: BLOQUE_LEER.key }].filter((o) => lid(o.nombre));

  function chipEtq(m) {
    return `<button type="button" class="etq" data-etq="${m.id}" style="--c:${m.bloque.color}" aria-haspopup="menu" title="Cambiar etiqueta"><span class="dot"></span>${esc(m.bloque.titulo)}<span class="etq-chev">▾</span></button>`;
  }

  let etqMenu = null, etqCierre = 0, etqAbierto = null;
  const cerrarEtq = () => { clearTimeout(etqCierre); if (etqMenu) etqMenu.hidden = true; etqAbierto = null; };
  const cerrarEtqLuego = () => { clearTimeout(etqCierre); etqCierre = setTimeout(cerrarEtq, 350); };

  function abrirMenuEtq(chip, m) {
    if (!etqMenu) {
      etqMenu = document.createElement("div");
      etqMenu.className = "etq-menu";
      etqMenu.setAttribute("role", "menu");
      document.body.appendChild(etqMenu);
      etqMenu.addEventListener("mouseenter", () => clearTimeout(etqCierre));
      etqMenu.addEventListener("mouseleave", cerrarEtqLuego);
      document.addEventListener("click", (e) => { if (!e.target.closest(".etq-menu, .etq")) cerrarEtq(); });
      window.addEventListener("scroll", () => { if (etqAbierto) cerrarEtq(); }, { passive: true });
    }
    clearTimeout(etqCierre);
    etqAbierto = chip;
    etqMenu.innerHTML = `<div class="etq-tit">Prioridad</div>` + OPCIONES_ETQ().map((o) => {
      const actual = o.key === m.bloque.key;
      return `<button type="button" role="menuitem" data-dest="${esc(o.nombre)}" style="--c:${o.color}" ${actual ? 'aria-current="true"' : ""}><span class="dot"></span>${esc(o.titulo)}${actual ? '<span class="etq-ok">✓</span>' : ""}</button>`;
    }).join("") + `<div class="etq-tit etq-sep">Organización</div>` + ORGS.map((o) => {
      const actual = o === m.org;
      return `<button type="button" role="menuitem" data-org-dest="${esc(o)}" ${actual ? 'aria-current="true"' : ""}><span class="tag tag-org" data-org="${esc(o)}">${esc(o)}</span>${actual ? '<span class="etq-ok">✓</span>' : ""}</button>`;
    }).join("");
    etqMenu.querySelectorAll("[data-org-dest]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      cerrarEtq();
      if (b.hasAttribute("aria-current")) return;
      try { await cambiarOrg(m, b.dataset.orgDest); trasMover(m, null, `Organización: ${m.org} ✓`); }
      catch (err) { toast("Error: " + err.message); }
    }));
    etqMenu.hidden = false;
    const r = chip.getBoundingClientRect(), mh = etqMenu.offsetHeight, mw = etqMenu.offsetWidth;
    etqMenu.style.top = (r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + "px";
    etqMenu.style.left = Math.min(r.left, window.innerWidth - mw - 8) + "px";
    etqMenu.querySelectorAll("[data-dest]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      cerrarEtq();
      if (b.hasAttribute("aria-current")) return;
      const destino = b.dataset.dest;
      try { await moverA([m], destino); trasMover(m, destino); }
      catch (err) { toast("Error: " + err.message); }
    }));
  }

  function conectarEtiquetas(cont, metas) {
    const conRaton = window.matchMedia("(hover: hover)").matches;
    cont.querySelectorAll("[data-etq]").forEach((chip) => {
      const m = metas.find((x) => x.id === chip.dataset.etq);
      if (!m) return;
      chip.onclick = (e) => { e.stopPropagation(); etqAbierto === chip ? cerrarEtq() : abrirMenuEtq(chip, m); };
      if (conRaton) {
        chip.onmouseenter = () => { clearTimeout(etqCierre); chip._t = setTimeout(() => abrirMenuEtq(chip, m), 120); };
        chip.onmouseleave = () => { clearTimeout(chip._t); if (etqAbierto === chip) cerrarEtqLuego(); };
      }
    });
  }

  // Cambia la etiqueta de clasificación en Gmail (quita la anterior, pone la nueva)
  async function moverA(ms, destino) {
    const otras = CLASIFICACION().map(lid).filter((id) => id && id !== lid(destino));
    await enParalelo(ms, async (m) => {
      const remove = otras.filter((id) => m.labelIds.includes(id));
      const add = [lid(destino), lid(L.corregido)];
      if (destino === L.leer) remove.push("INBOX"); else add.push("INBOX");
      await modificar(m.id, add, remove);
      m.labelIds = m.labelIds.filter((id) => !remove.includes(id)).concat(add.filter((id) => !m.labelIds.includes(id)));
      m.bloque = bloqueDe(m);
      m.org = organizacion(m);
    });
  }

  // Organización: ASPM y PMS GO se guardan como etiquetas «Org/…»; Ayto y Personal son sus propios bloques
  const ORGS = ["ASPM", "PMS GO", "Ayto", "Personal"];
  async function asegurarEtiqueta(nombre) {
    if (lid(nombre)) return lid(nombre);
    const nueva = await api("/labels", { method: "POST", body: JSON.stringify({ name: nombre, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
    state.labels[nombre] = nueva.id; state.labelsById[nueva.id] = nombre;
    return nueva.id;
  }
  async function cambiarOrg(m, org) {
    if (org === "Personal") return moverA([m], L.personal);
    if (org === "Ayto") return moverA([m], L.ayto);
    const idOrg = await asegurarEtiqueta(org === "ASPM" ? L.orgAspm : L.orgPmsgo);
    const remove = [lid(org === "ASPM" ? L.orgPmsgo : L.orgAspm), lid(L.personal), lid(L.ayto)].filter((id) => id && m.labelIds.includes(id));
    const quedan = m.labelIds.filter((id) => !remove.includes(id));
    const add = [idOrg, lid(L.corregido), "INBOX"];
    // Si deja de ser Personal/Ayto y no tiene otra prioridad, pasa a «Responder»
    const otraPrioridad = BLOQUES.some((b) => !["personal", "ayto"].includes(b.key) && b.etiquetas().some((n) => quedan.includes(lid(n))));
    if (!otraPrioridad) add.push(lid(L.responder));
    await modificar(m.id, add.filter(Boolean), remove);
    m.labelIds = quedan.concat(add.filter((id) => id && !quedan.includes(id)));
    m.bloque = bloqueDe(m);
    m.org = organizacion(m);
  }

  function trasMover(m, destino, mensaje) {
    const titulo = m.bloque.titulo;
    if (destino === L.leer) return trasAccion(m, `Movido a «${titulo}»`);
    const q = state.queue.find((x) => x.id === m.id);
    if (q && q !== m) Object.assign(q, { labelIds: [...m.labelIds], bloque: m.bloque, org: m.org });
    if (!q) state.queue.push(m);
    state.queue.sort(ordenCola);
    toast(mensaje || `Movido a «${titulo}» ✓`);
    if (state.view === "bandeja") return pintarLista();
    if (state.view === "correo") return renderCorreo();
    if (state.view === "leer") return document.querySelectorAll(`#view-leer [data-row="${m.id}"]`).forEach((r) => r.remove());
    document.querySelectorAll(`#view-${state.view} [data-etq="${m.id}"]`).forEach((c) => {
      c.outerHTML = chipEtq(m);
    });
    conectarEtiquetas($("#view-" + state.view), [m]);
  }

  function filaHtml(m, seleccionable = false, extra = "") {
    if (!m.bloque) m.bloque = bloqueDe(m);
    if (m.org == null) m.org = organizacion(m);
    const noLeido = m.labelIds.includes("UNREAD");
    return `<div class="row ${noLeido ? "unread" : ""} ${state.sel.has(m.id) ? "sel" : ""}" data-row="${m.id}">
      ${seleccionable ? `<label class="chk"><input type="checkbox" data-sel="${m.id}" ${state.sel.has(m.id) ? "checked" : ""} aria-label="Seleccionar"></label>` : ""}
      <div class="row-main" data-open="${m.id}" role="button" tabindex="0">
        <div class="r1"><span class="r-from">${esc(nombreDe(m.from))}${m.count > 1 ? ` <span class="r-n">${m.count}</span>` : ""}</span><span class="r-tags">${etiquetasFila(m)}</span><span class="row-date">${esc(fecha(m.date))}</span></div>
        <div class="r-subj">${esc(m.subject)}</div>
        <div class="r-snip">${esc(m.snippet)}</div>
      </div>${extra}</div>`;
  }

  function conectarFilas(cont, metas, origen) {
    cont.querySelectorAll("[data-open]").forEach((el) => {
      const abrir = () => abrirCorreo(metas.find((x) => x.id === el.dataset.open), metas, origen);
      el.onclick = abrir;
      el.onkeydown = (e) => { if (e.key === "Enter") abrir(); };
    });
    conectarEtiquetas(cont, metas);
  }

  // ----- Bandeja: lista por bloques de prioridad -----
  function colaFiltrada() {
    const f = state.filtro.trim().toLowerCase();
    if (!f) return [...state.queue];
    return state.queue.filter((m) => (m.from + " " + m.subject + " " + m.snippet + " " + m.org + " " + m.bloque.titulo).toLowerCase().includes(f));
  }

  function renderBandeja() {
    const cont = $("#view-bandeja");
    cont.innerHTML = `<div class="view-head"><h2>Bandeja</h2>
        <div class="head-btns"><button class="btn btn-sm" id="recargar">↻ Actualizar</button><button class="btn btn-sm btn-primary" id="empezar">Empezar por el primero ›</button></div></div>
      <div class="filter-row"><input id="filtro" type="search" placeholder="Filtrar por persona, asunto u organización" value="${esc(state.filtro)}"></div>
      <div id="b-lista"></div>`;
    const f = $("#filtro");
    f.oninput = () => { state.filtro = f.value; clearTimeout(f._t); f._t = setTimeout(pintarLista, 250); };
    $("#recargar").onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = "Actualizando…";
      try { state.cache = {}; await cargarBorradores(); state.queue = await construirCola(); }
      catch (e) { toast("Error: " + e.message); }
      renderBandeja();
    };
    $("#empezar").onclick = () => { const c = colaFiltrada(); if (c.length) abrirCorreo(c[0], c, "bandeja"); };
    pintarLista();
  }

  function pintarLista() {
    const cont = $("#b-lista");
    if (!cont) return;
    for (const id of [...state.sel]) if (!state.queue.some((m) => m.id === id)) state.sel.delete(id);
    const cola = colaFiltrada();
    $("#empezar").hidden = !cola.length;
    const grupos = BLOQUES.map((b) => ({ b, items: cola.filter((m) => m.bloque.key === b.key) })).filter((g) => g.items.length);
    if (!grupos.length) {
      cont.innerHTML = `<div class="empty"><div class="big">🎉</div><p><b>Bandeja vacía.</b></p><p>No queda nada que requiera tu atención${state.filtro ? " con este filtro" : ""}.</p></div>`;
      return;
    }
    cont.innerHTML = `<div class="resumen">${grupos.map((g) => `<button class="sum" data-ir="${g.b.key}" style="--c:${g.b.color}"><span class="dot"></span>${esc(g.b.titulo)} <b>${g.items.length}</b></button>`).join("")}</div>
      <div id="selbar" class="selbar" hidden></div>
      ${grupos.map((g) => bloqueHtml(g.b, g.items)).join("")}`;

    conectarFilas(cont, cola, "bandeja");
    cont.querySelectorAll("[data-sel]").forEach((c) => (c.onchange = () => {
      c.checked ? state.sel.add(c.dataset.sel) : state.sel.delete(c.dataset.sel);
      c.closest(".row").classList.toggle("sel", c.checked);
      actualizarChecksBloque(cont, cola);
      pintarSelbar(cola);
    }));
    cont.querySelectorAll("[data-selb]").forEach((c) => (c.onchange = () => {
      for (const m of cola.filter((x) => x.bloque.key === c.dataset.selb)) c.checked ? state.sel.add(m.id) : state.sel.delete(m.id);
      pintarLista();
    }));
    cont.querySelectorAll("[data-plegar]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.plegar;
      state.plegados.has(k) ? state.plegados.delete(k) : state.plegados.add(k);
      try { localStorage.setItem("cn_plegados", JSON.stringify([...state.plegados])); } catch (_) {}
      pintarLista();
    }));
    cont.querySelectorAll("[data-ir]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.ir;
      if (state.plegados.has(k)) { state.plegados.delete(k); pintarLista(); }
      const el = $(`[data-bloque="${k}"]`);
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" });
    }));
    actualizarChecksBloque(cont, cola);
    pintarSelbar(cola);
  }

  function bloqueHtml(b, items) {
    const plegado = state.plegados.has(b.key);
    return `<section class="bloque" data-bloque="${b.key}" style="--c:${b.color}">
      <div class="bloque-head">
        <label class="chk" title="Seleccionar todo el bloque"><input type="checkbox" data-selb="${b.key}" aria-label="Seleccionar todo ${esc(b.titulo)}"></label>
        <button class="bloque-tit" data-plegar="${b.key}" aria-expanded="${!plegado}"><span class="dot"></span>${esc(b.titulo)} <span class="bloque-n">${items.length}</span><span class="chev">${plegado ? "▸" : "▾"}</span></button>
      </div>
      ${plegado ? "" : `<div class="list">${items.map((m) => filaHtml(m, true)).join("")}</div>`}
    </section>`;
  }

  function actualizarChecksBloque(cont, cola) {
    cont.querySelectorAll("[data-selb]").forEach((c) => {
      const items = cola.filter((x) => x.bloque.key === c.dataset.selb);
      const n = items.filter((x) => state.sel.has(x.id)).length;
      c.checked = n > 0 && n === items.length;
      c.indeterminate = n > 0 && n < items.length;
    });
  }

  function pintarSelbar(cola) {
    const bar = $("#selbar");
    if (!bar) return;
    const n = state.sel.size;
    bar.hidden = !n;
    if (!n) return;
    bar.innerHTML = `<span class="sel-n"><b>${n}</b> seleccionado${n > 1 ? "s" : ""}</span>
      <button class="btn btn-sm" data-sa="archivar">🗄 Archivar</button>
      <button class="btn btn-sm" data-sa="posponer">⏰ Posponer</button>
      <button class="btn btn-sm" data-sa="mover">🏷 Mover a…</button>
      <button class="btn btn-sm" data-sa="leido">✓ Marcar como leído</button>
      <button class="link-btn" data-sa="nada">✕ Quitar selección</button>`;
    bar.querySelectorAll("[data-sa]").forEach((b) => (b.onclick = () => accionVarios(b.dataset.sa, b)));
  }

  async function accionVarios(a, btn) {
    const ms = state.queue.filter((m) => state.sel.has(m.id));
    const terminar = (msg, undo) => {
      const ids = new Set(ms.map((m) => m.id));
      state.queue = state.queue.filter((m) => !ids.has(m.id));
      state.sel.clear();
      pintarLista();
      if (msg) toast(msg, undo);
    };
    try {
      if (a === "nada") { state.sel.clear(); return pintarLista(); }
      if (a === "archivar") {
        btn.disabled = true;
        await enParalelo(ms, (m) => modificar(m.id, [], ["INBOX"]));
        return terminar(`${ms.length} archivado${ms.length > 1 ? "s" : ""}`, async () => {
          await enParalelo(ms, (m) => modificar(m.id, ["INBOX"], []));
          state.queue = await construirCola(); pintarLista();
        });
      }
      if (a === "leido") {
        btn.disabled = true;
        const noLeidos = ms.filter((m) => m.labelIds.includes("UNREAD"));
        await enParalelo(noLeidos, (m) => modificar(m.id, [], ["UNREAD"]));
        for (const m of noLeidos) m.labelIds = m.labelIds.filter((x) => x !== "UNREAD");
        state.sel.clear();
        return pintarLista();
      }
      if (a === "posponer") return dialogoPosponer(ms, (texto) => terminar(`${ms.length} pospuesto${ms.length > 1 ? "s" : ""} hasta ${texto}`));
      if (a === "mover") return dialogoMover(ms, async (destino) => {
        state.sel.clear();
        state.queue = await construirCola();
        pintarLista();
        toast(`${ms.length} movido${ms.length > 1 ? "s" : ""} a «${destino}»`);
      });
    } catch (e) { toast("Error: " + e.message); if (btn) btn.disabled = false; }
  }

  // ----- Correo abierto -----
  function abrirCorreo(m, lista, origen) {
    if (!m) return;
    state.scroll[origen] = window.scrollY;
    state.abierto = { m, lista, origen };
    mostrarVista("correo");
    window.scrollTo(0, 0);
  }

  function volverALista(alFinal) {
    const origen = state.abierto?.origen || "bandeja";
    state.abierto = null;
    if (origen === "bandeja") mostrarVista("bandeja");
    else mostrarVista(origen, { render: false });
    window.scrollTo(0, state.scroll[origen] || 0);
    if (alFinal) toast(origen === "bandeja" && !state.queue.length ? "¡Bandeja vacía! 🎉" : "Has llegado al final de la lista");
  }

  function irA(delta) {
    const ab = state.abierto;
    const idx = ab.lista.findIndex((x) => x.id === ab.m.id);
    const otro = ab.lista[idx + delta];
    if (!otro) return delta > 0 ? volverALista(true) : undefined;
    ab.m = otro;
    renderCorreo();
    window.scrollTo(0, 0);
  }

  // Tras archivar, enviar, delegar o posponer: se abre sola la siguiente
  function trasAccion(m, msg, undo) {
    const ab = state.abierto;
    const abierto = ab && ab.m.id === m.id;
    let siguienteM = null;
    if (ab) {
      const idx = ab.lista.findIndex((x) => x.id === m.id);
      if (idx >= 0) { ab.lista.splice(idx, 1); if (abierto) siguienteM = ab.lista[idx] || null; }
    }
    state.queue = state.queue.filter((x) => x.id !== m.id);
    state.sel.delete(m.id);
    document.querySelectorAll(`[data-row="${m.id}"]`).forEach((r) => r.remove());
    if (msg) toast(msg, undo);
    if (abierto && state.view === "correo") {
      if (siguienteM) { ab.m = siguienteM; renderCorreo(); window.scrollTo(0, 0); }
      else volverALista(true);
    } else if (state.view === "bandeja") pintarLista();
  }

  function marcarLeido(m) {
    if (!m.labelIds.includes("UNREAD")) return;
    m.labelIds = m.labelIds.filter((x) => x !== "UNREAD");
    const q = state.queue.find((x) => x.id === m.id);
    if (q && q !== m) q.labelIds = q.labelIds.filter((x) => x !== "UNREAD");
    modificar(m.id, [], ["UNREAD"]).catch(() => {});
  }

  const adjuntosHilo = (hilo) => (hilo.messages || []).flatMap((msg) => partes(msg.payload, undefined, msg.id).adjuntos);

  function chipsCorreo(m) {
    const c = [chipEtq(m)];
    c.push(`<button type="button" class="etq" data-etq="${m.id}" title="Cambiar organización">${esc(m.org || "Sin organización")}<span class="etq-chev">▾</span></button>`);
    if (m.labelIds.includes(lid(L.clave)) && m.bloque.key !== "clave") c.push(`<span class="chip" style="--c:var(--c-clave)"><span class="dot"></span>Persona clave</span>`);
    if (m.labelIds.includes(lid(L.sensible))) c.push(`<span class="chip" style="--c:var(--c-sensible)"><span class="dot"></span>🔒 Sensible</span>`);
    if (m.labelIds.includes(lid(L.urgente)) && m.bloque.key !== "urgente") c.push(`<span class="chip" style="--c:var(--c-urgente)"><span class="dot"></span>Urgente</span>`);
    return `<div class="chips">${c.join("")}</div>`;
  }

  function navHtml() {
    const ab = state.abierto;
    const idx = ab.lista.findIndex((x) => x.id === ab.m.id);
    const hayMas = idx >= 0 && idx < ab.lista.length - 1;
    return `<div class="lector-nav">
      <button class="btn btn-sm" data-a="volver">‹ Volver a la lista</button>
      <span class="pos">${idx >= 0 ? `${idx + 1} de ${ab.lista.length}` : ""}</span>
      ${idx > 0 ? `<button class="btn btn-sm" data-a="anterior" title="Correo anterior">‹ Anterior</button>` : ""}
      <button class="btn btn-sig" data-a="siguiente">${hayMas ? "Siguiente ›" : "Terminar ✓"}</button>
    </div>`;
  }

  function respuestaHtml(m) {
    const d = state.drafts[m.id];
    if (d) return `<div class="section-title">Respuesta preparada</div>
      <div class="draft-meta" id="draft-meta">Cargando borrador…</div>
      <div class="draft" id="draft" contenteditable="true"></div>
      <div id="draft-adj" class="draft-adj"></div>
      <div class="resp-btns"><button class="btn btn-primary" data-a="enviar">✓ Enviar respuesta</button><button class="btn btn-sm dictar" id="dictar-draft" type="button">🎤 Dictar</button><button class="btn btn-sm" data-a="responder">Abrir en grande</button></div>`;
    const pedido = m.labelIds.includes(lid(L.pedirBorrador));
    return `<div class="section-title">Respuesta</div>
      <div class="no-draft">${pedido ? "✍ Borrador pedido. Estará listo en la próxima pasada (8:00, 12:00 o 17:00)." : "Todavía no hay respuesta preparada para este correo."}</div>
      <div class="resp-btns">${pedido ? "" : `<button class="btn btn-primary" data-a="pedir">✍ Pídeme borrador</button>`}<button class="btn" data-a="responder">↩ Escribir yo la respuesta</button></div>`;
  }

  function barraHtml(m) {
    const d = state.drafts[m.id];
    const gmailUrl = `https://mail.google.com/mail/u/0/#all/${m.id}`;
    return `<div class="lector-bar"><div class="bar-in">
      ${d ? `<button class="btn btn-primary" data-a="enviar">✓ <span>Enviar borrador</span></button>` : ""}
      <button class="btn" data-a="responder">↩ <span>Responder</span></button>
      <button class="btn" data-a="todos">↩ <span>A todos</span></button>
      <button class="btn" data-a="reenviar">↪ <span>Reenviar</span></button>
      <button class="btn" data-a="delegar">→ <span>Delegar</span></button>
      <div class="mas"><button class="btn" data-a="mas" aria-haspopup="menu" aria-expanded="false">⋯ <span>Más</span></button>
        <div class="menu" role="menu" hidden>
          <button role="menuitem" data-a="archivar">🗄 Archivar</button>
          <button role="menuitem" data-a="posponer">⏰ Posponer</button>
          <button role="menuitem" data-a="etiqueta">🏷 Cambiar etiqueta</button>
          ${d ? "" : `<button role="menuitem" data-a="pedir">✍ Pídeme borrador</button>`}
          <button role="menuitem" data-a="noleido">✉ Marcar como no leído</button>
          <a role="menuitem" href="${gmailUrl}" target="_blank" rel="noopener">↗ Abrir en Gmail</a>
        </div></div>
      <button class="btn btn-sig" data-a="siguiente">Siguiente ›</button>
    </div></div>`;
  }

  async function renderCorreo() {
    const cont = $("#view-correo");
    const ab = state.abierto;
    if (!ab) return volverALista();
    const m = ab.m;
    if (!m.bloque) m.bloque = BLOQUE_SUELTO;
    if (m.org == null) m.org = organizacion(m);
    if (dictadoActivo) dictadoActivo.stop();
    cont.innerHTML = navHtml() + `<div class="loading">Abriendo correo…</div>`;
    conectarAcciones(cont, m, null);
    try {
      const hilo = await hiloCompleto(m.id);
      if (state.abierto?.m !== m) return;
      const adjs = adjuntosHilo(hilo);
      const cuando = new Date(Number(m.date)).toLocaleString("es-ES", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
      cont.innerHTML = navHtml() + `<article class="lector">
          ${chipsCorreo(m)}
          <h2 class="lector-asunto">${esc(m.subject)}</h2>
          <div class="lector-de"><b>${esc(nombreDe(m.from))}</b> <span class="muted">${esc(emailDe(m.from))}</span></div>
          <div class="lector-meta">${esc(cuando)}${m.count > 1 ? ` · ${m.count} mensajes en la conversación` : ""}</div>
          ${adjs.length ? `<div class="section-title">Adjuntos (${adjs.length})</div><div id="adjs">${listaAdjuntosHtml(adjs)}</div>` : ""}
          <div class="lector-cols">
            <div class="lector-correo"><iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Correo" id="orig"></iframe></div>
            <aside class="lector-resp" id="resp">${respuestaHtml(m)}</aside>
          </div>
        </article>` + barraHtml(m);
      montarCorreo($("#orig"), hilo);
      conectarEtiquetas(cont, [m]);
      if ($("#adjs")) conectarAdjuntos($("#adjs"), adjs);
      conectarAcciones(cont, m, hilo);
      marcarLeido(m);
      cargarBorradorEn(m);
      // Deja preparado el siguiente para que abra al instante
      const sig = ab.lista[ab.lista.findIndex((x) => x.id === m.id) + 1];
      if (sig) setTimeout(() => hiloCompleto(sig.id).catch(() => {}), 800);
    } catch (e) {
      cont.innerHTML = navHtml() + `<div class="error-box">${esc(e.message)}</div>`;
      conectarAcciones(cont, m, null);
    }
  }

  async function cargarBorradorEn(m) {
    const d = state.drafts[m.id];
    if (!d) return;
    try {
      const dr = d.full || await api(`/drafts/${d.id}?format=full`);
      d.full = dr;
      const p = partes(dr.message.payload, undefined, dr.message.id);
      if (!d.adjuntos) d.adjuntos = p.adjuntos; // los que ya traía el borrador + los que añadas
      if (!$("#draft") || state.abierto?.m !== m) return;
      const cc = header(dr.message, "Cc");
      $("#draft-meta").textContent = `De: ${header(dr.message, "From") || state.me} · Para: ${header(dr.message, "To")}${cc ? " · Cc: " + cc : ""}`;
      $("#draft").innerHTML = d.editado != null ? d.editado : (p.html ? limpiarHtml(p.html) : esc(p.text).replace(/\n/g, "<br>"));
      $("#draft").oninput = () => (d.editado = $("#draft").innerHTML);
      selectorAdjuntos($("#draft-adj"), d.adjuntos, $("#resp"));
      botonDictar($("#dictar-draft"), $("#draft"));
    } catch (e) { if ($("#draft-meta")) $("#draft-meta").textContent = "No se pudo cargar el borrador: " + e.message; }
  }

  function conectarAcciones(cont, m, hilo) {
    cont.querySelectorAll("[data-a]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); accion(b.dataset.a, m, hilo, b); }));
    const menu = $(".menu", cont);
    if (menu) {
      document.onclick = (e) => { if (!e.target.closest(".mas")) { menu.hidden = true; $("[data-a=mas]", cont)?.setAttribute("aria-expanded", "false"); } };
    }
  }

  async function accion(a, m, hilo, btn) {
    const menu = $("#view-correo .menu");
    if (menu && a !== "mas") menu.hidden = true;
    try {
      if (a === "mas") { menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); return; }
      if (a === "volver") return volverALista();
      if (a === "siguiente") return irA(1);
      if (a === "anterior") return irA(-1);
      if (!hilo) return toast("Espera a que cargue el correo.");
      if (a === "archivar") {
        btn.disabled = true;
        await modificar(m.id, [], ["INBOX"]);
        return trasAccion(m, "Archivado", async () => { await modificar(m.id, ["INBOX"], []); state.queue = await construirCola(); if (state.view === "bandeja") pintarLista(); });
      }
      if (a === "pedir") {
        await modificar(m.id, [lid(L.pedirBorrador)], []);
        m.labelIds.push(lid(L.pedirBorrador));
        toast("Borrador pedido. Lo tendrás en la próxima pasada.");
        return renderCorreo();
      }
      if (a === "noleido") {
        await modificar(m.id, ["UNREAD"], []);
        m.labelIds.push("UNREAD");
        return volverALista();
      }
      if (a === "enviar") return enviarBorrador(m, btn);
      if (a === "responder" || a === "todos" || a === "reenviar") {
        const d = state.drafts[m.id];
        const usarBorrador = a !== "reenviar" && d?.full;
        return abrirRedactor({
          modo: a, m, hilo,
          cuerpo: usarBorrador ? (d.editado ?? $("#draft")?.innerHTML) : "",
          adjuntos: usarBorrador ? d.adjuntos : undefined,
          draftId: usarBorrador ? d.id : undefined
        });
      }
      if (a === "delegar") return dialogoDelegar(m, hilo);
      if (a === "posponer") return dialogoPosponer([m], (texto) => trasAccion(m, `Pospuesto hasta ${texto}`));
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
    const adjs = d.adjuntos || [];
    if (!confirm(`¿Enviar la respuesta a ${header(msg, "To")}${adjs.length ? ` con ${adjs.length} adjunto${adjs.length > 1 ? "s" : ""}` : ""}?`)) return;
    document.querySelectorAll('[data-a="enviar"]').forEach((b) => { b.disabled = true; b.textContent = "Enviando…"; });
    try {
      const raw = construirMime({
        from: header(msg, "From"),
        to: header(msg, "To"),
        cc: header(msg, "Cc"),
        bcc: header(msg, "Bcc"),
        subject: header(msg, "Subject"),
        inReplyTo: header(msg, "In-Reply-To"),
        references: header(msg, "References"),
        html: ed.innerHTML,
        text: ed.innerText,
        adjuntos: await prepararAdjuntos(adjs)
      });
      await subirMime("borrador", raw, { threadId: m.id, draftId: d.id });
      await api("/drafts/send", { method: "POST", body: JSON.stringify({ id: d.id }) });
    } catch (e) {
      document.querySelectorAll('[data-a="enviar"]').forEach((b) => { b.disabled = false; b.textContent = "✓ Enviar respuesta"; });
      throw e;
    }
    delete state.drafts[m.id];
    delete state.cache[m.id];
    await modificar(m.id, [], ["INBOX", lid(L.pedirBorrador)]);
    trasAccion(m, "Enviado ✓");
  }

  // ----- Diálogos -----
  function modal(html, onMount, { alCerrar, clase = "", fijo = false } = {}) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-back"><div class="modal ${clase}" role="dialog" aria-modal="true">${html}</div></div>`;
    const back = root.firstElementChild;
    const cerrar = () => { if (dictadoActivo) dictadoActivo.stop(); root.innerHTML = ""; alCerrar?.(); };
    if (!fijo) back.addEventListener("click", (e) => { if (e.target === back) cerrar(); });
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
        ev.target.textContent = "Enviando…";
        try {
          const p = CFG.equipo[root.querySelector("input[name=p]:checked").value];
          await reenviar(m, hilo, p.email, ta.value);
          await modificar(m.id, [lid(L.delegado)], ["INBOX"]);
          cerrar();
          trasAccion(m, `Delegado a ${p.nombre} ✓`);
        } catch (e) { ev.target.disabled = false; ev.target.textContent = "Enviar reenvío"; toast("Error: " + e.message); }
      };
    });
  }

  async function reenviar(m, hilo, destino, instrucciones) {
    const ultimo = [...hilo.messages].reverse().find((x) => !(x.labelIds || []).includes("SENT")) || hilo.messages[hilo.messages.length - 1];
    const p = partes(ultimo.payload, undefined, ultimo.id);
    const lista = [];
    let total = 0;
    for (const a of p.adjuntos) {
      total += a.size || 0;
      if (total > LIMITE_ADJUNTOS) break;
      lista.push(a);
    }
    const adjuntos = await prepararAdjuntos(lista);
    const cabecera = `---------- Mensaje reenviado ----------\nDe: ${header(ultimo, "From")}\nFecha: ${header(ultimo, "Date")}\nAsunto: ${header(ultimo, "Subject")}\nPara: ${header(ultimo, "To")}\n\n`;
    const text = `${instrucciones}\n\n${cabecera}${p.text || ultimo.snippet}`;
    const html = `<div>${esc(instrucciones).replace(/\n/g, "<br>")}</div><br><div style="color:#555">${esc(cabecera).replace(/\n/g, "<br>")}</div>${p.html ? limpiarHtml(p.html) : esc(p.text).replace(/\n/g, "<br>")}`;
    const subject = /^(fwd?|rv):/i.test(m.subject) ? m.subject : "Fwd: " + m.subject;
    const from = state.sendAs.some((s) => s.sendAsEmail === CFG.remitenteDelegar) ? CFG.remitenteDelegar : "";
    const raw = construirMime({ from, to: destino, subject, html, text, adjuntos });
    await subirMime("enviar", raw);
  }

  // ----- Redactor: nuevo, responder, responder a todos y reenviar -----
  function misDirecciones() {
    return new Set([state.me, ...state.sendAs.map((s) => s.sendAsEmail)].filter(Boolean).map((x) => x.toLowerCase()));
  }
  function remitentePara(msg) {
    // Se responde desde la dirección que recibió el correo
    if (msg) {
      const texto = [header(msg, "To"), header(msg, "Cc"), header(msg, "Delivered-To")].join(" ").toLowerCase();
      const s = state.sendAs.find((x) => texto.includes(x.sendAsEmail.toLowerCase()) && x.sendAsEmail.toLowerCase() !== state.me?.toLowerCase());
      if (s) return s.sendAsEmail;
    }
    return (state.sendAs.find((x) => x.isDefault) || {}).sendAsEmail || state.me;
  }
  const firmaDe = (email) => state.sendAs.find((x) => x.sendAsEmail === email)?.signature || "";
  const fromCompleto = (email) => { const s = state.sendAs.find((x) => x.sendAsEmail === email); return s?.displayName ? `${s.displayName} <${email}>` : email; };

  function abrirRedactor({ modo, m, hilo, para = "", asunto = "", cuerpo = "", adjuntos, draftId, borrador, alTerminar }) {
    const msgs = hilo?.messages || [];
    const ref = [...msgs].reverse().find((x) => !(x.labelIds || []).includes("SENT")) || msgs[msgs.length - 1];
    const mias = misDirecciones();
    let ccIni = "", bcc = "", desdeFijo = "", refsBorrador = null, threadBorrador;
    if (borrador) { // abrir un borrador que ya existe en Gmail
      const bm = borrador.message;
      const p = partes(bm.payload, undefined, bm.id);
      para = header(bm, "To"); ccIni = header(bm, "Cc"); bcc = header(bm, "Bcc"); asunto = header(bm, "Subject");
      cuerpo = (p.html ? limpiarHtml(p.html) : esc(p.text).replace(/\n/g, "<br>")) || "<div><br></div>";
      adjuntos = p.adjuntos; draftId = borrador.id;
      desdeFijo = header(bm, "From") ? emailDe(header(bm, "From")) : "";
      refsBorrador = { inReplyTo: header(bm, "In-Reply-To"), references: header(bm, "References") };
      if (refsBorrador.inReplyTo) { threadBorrador = bm.threadId; m = m || { id: bm.threadId }; }
    }
    let to = para, cc = ccIni, subject = asunto, cita = "";
    const lista = adjuntos || [];
    if (ref && modo !== "nuevo") {
      const asuntoOrig = header(msgs[0], "Subject") || m?.subject || "";
      const pOrig = partes(ref.payload, undefined, ref.id);
      const cuerpoOrig = pOrig.html ? limpiarHtml(pOrig.html) : esc(pOrig.text || ref.snippet).replace(/\n/g, "<br>");
      if (modo === "reenviar") {
        subject = /^(fwd?|rv|reenv):/i.test(asuntoOrig) ? asuntoOrig : "Fwd: " + asuntoOrig;
        cita = `<br><div style="color:#555">---------- Mensaje reenviado ----------<br>De: ${esc(header(ref, "From"))}<br>Fecha: ${esc(header(ref, "Date"))}<br>Asunto: ${esc(header(ref, "Subject"))}<br>Para: ${esc(header(ref, "To"))}${header(ref, "Cc") ? "<br>Cc: " + esc(header(ref, "Cc")) : ""}</div><br>${cuerpoOrig}`;
        if (!adjuntos) lista.push(...pOrig.adjuntos);
      } else {
        subject = /^(re|rv):/i.test(asuntoOrig) ? asuntoOrig : "Re: " + asuntoOrig;
        const remitente = header(ref, "Reply-To") || header(ref, "From");
        to = remitente;
        if (modo === "todos") {
          const yaEsta = new Set([emailDe(remitente), ...mias]);
          cc = dividirDirecciones(header(ref, "To") + "," + header(ref, "Cc"))
            .filter((x) => { const e = emailDe(x); if (yaEsta.has(e)) return false; yaEsta.add(e); return true; }).join(", ");
        }
        const cuando = new Date(Number(ref.internalDate)).toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" });
        cita = `<br><div class="gmail_quote"><div>El ${esc(cuando)}, ${esc(header(ref, "From"))} escribió:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${cuerpoOrig}</blockquote></div>`;
      }
    }
    const desde = state.sendAs.find((s) => s.sendAsEmail.toLowerCase() === desdeFijo)?.sendAsEmail || remitentePara(ref && modo !== "nuevo" ? ref : null);
    const opcionesDe = (state.sendAs.length ? state.sendAs.map((s) => s.sendAsEmail) : [state.me])
      .map((e) => `<option value="${esc(e)}" ${e === desde ? "selected" : ""}>${esc(fromCompleto(e))}</option>`).join("");
    const titulo = { nuevo: "Nuevo correo", responder: "Responder", todos: "Responder a todos", reenviar: "Reenviar", borrador: "Borrador" }[modo];
    const esRespuesta = modo === "responder" || modo === "todos";

    modal(`<div class="comp-head"><h3>${titulo}</h3><button class="link-btn" data-cerrar-comp aria-label="Cerrar">✕</button></div>
      <div class="comp-fields">
        <label>De<select id="c-de">${opcionesDe}</select></label>
        <label>Para<input id="c-para" type="text" autocomplete="off" value="${esc(to)}" placeholder="correo@ejemplo.org, otra persona…"></label>
        <label ${cc ? "" : 'hidden'} id="l-cc">Cc<input id="c-cc" type="text" autocomplete="off" value="${esc(cc)}"></label>
        <label ${bcc ? "" : "hidden"} id="l-cco">Cco<input id="c-cco" type="text" autocomplete="off" value="${esc(bcc)}"></label>
        <div class="comp-links">${cc ? "" : '<button type="button" class="link-btn" id="add-cc">+ Cc</button>'}${bcc ? "" : '<button type="button" class="link-btn" id="add-cco">+ Cco</button>'}</div>
        <label>Asunto<input id="c-asunto" type="text" value="${esc(subject)}"></label>
      </div>
      <div class="comp-tools"><button type="button" class="btn btn-sm dictar" id="c-dictar">🎤 Dictar</button><span class="muted small">Di «coma», «punto» o «punto y aparte» para puntuar.</span></div>
      <div class="draft comp-body" id="c-cuerpo" contenteditable="true"></div>
      ${cita ? `<label class="check"><input type="checkbox" id="c-cita" checked> ${modo === "reenviar" ? "Incluir el mensaje reenviado" : "Incluir el mensaje anterior"}</label>` : ""}
      <div id="c-adj"></div>
      ${m ? `<label class="check"><input type="checkbox" id="c-arch" ${esRespuesta || threadBorrador ? "checked" : ""}> Quitar ${threadBorrador ? "el correo al que respondes" : "este correo"} de la bandeja al enviar</label>` : ""}
      <div class="foot"><button class="btn" data-cerrar-comp>Cancelar</button><button class="btn" id="c-guardar">Guardar borrador</button><button class="btn btn-primary" id="c-enviar">✓ Enviar</button></div>`,
    (root, cerrar) => {
      const cuerpoEl = $("#c-cuerpo", root);
      const firmaHtml = (email) => { const f = firmaDe(email); return f ? `<div class="cn-firma"><br>${limpiarHtml(f)}</div>` : ""; };
      cuerpoEl.innerHTML = cuerpo ? cuerpo : `<div><br></div>${firmaHtml(desde)}`;
      $("#c-de", root).onchange = (e) => {
        const f = cuerpoEl.querySelector(".cn-firma");
        const nueva = firmaHtml(e.target.value);
        if (f) f.outerHTML = nueva || ""; else if (nueva && !cuerpo) cuerpoEl.insertAdjacentHTML("beforeend", nueva);
      };
      $("#add-cc", root)?.addEventListener("click", (e) => { $("#l-cc", root).hidden = false; e.target.remove(); $("#c-cc", root).focus(); });
      $("#add-cco", root)?.addEventListener("click", (e) => { $("#l-cco", root).hidden = false; e.target.remove(); $("#c-cco", root).focus(); });
      selectorAdjuntos($("#c-adj", root), lista, root.querySelector(".modal"));
      botonDictar($("#c-dictar", root), cuerpoEl);
      setTimeout(() => { (to ? cuerpoEl : $("#c-para", root)).focus(); }, 50);

      const inicial = cuerpoEl.innerHTML;
      const cerrarConAviso = () => {
        if (cuerpoEl.innerHTML !== inicial && !confirm("¿Descartar lo que has escrito?")) return;
        cerrar();
      };
      root.querySelectorAll("[data-cerrar-comp]").forEach((b) => (b.onclick = cerrarConAviso));

      const montar = async () => {
        const destinos = [$("#c-para", root).value, $("#c-cc", root).value, $("#c-cco", root).value].flatMap(dividirDirecciones);
        if (!destinos.length) throw new Error("falta el destinatario.");
        const malas = destinos.filter((x) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailDe(x)));
        if (malas.length) throw new Error("revisa esta dirección: " + malas.join(", "));
        const conCita = cita && $("#c-cita", root)?.checked;
        const html = cuerpoEl.innerHTML + (conCita ? cita : "");
        const tmp = document.createElement("div");
        tmp.innerHTML = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|h\d|tr|blockquote)>/gi, "$&\n");
        const inReplyTo = refsBorrador ? refsBorrador.inReplyTo : esRespuesta ? (header(ref, "Message-ID") || header(ref, "Message-Id")) : "";
        const references = refsBorrador ? refsBorrador.references : inReplyTo ? [header(ref, "References"), inReplyTo].filter(Boolean).join(" ") : "";
        return {
          raw: construirMime({
            from: fromCompleto($("#c-de", root).value),
            to: $("#c-para", root).value, cc: $("#c-cc", root).value, bcc: $("#c-cco", root).value,
            subject: $("#c-asunto", root).value.trim() || "(sin asunto)",
            inReplyTo, references,
            html, text: tmp.innerText, adjuntos: await prepararAdjuntos(lista)
          }),
          destinos
        };
      };
      const threadId = borrador ? threadBorrador : (modo !== "nuevo" && m ? m.id : undefined);
      const bloquear = (si, texto) => { root.querySelectorAll(".foot .btn").forEach((b) => (b.disabled = si)); if (texto) $("#c-enviar", root).textContent = texto; };

      $("#c-enviar", root).onclick = async () => {
        try {
          const destinos = [$("#c-para", root).value, $("#c-cc", root).value, $("#c-cco", root).value].flatMap(dividirDirecciones);
          if (destinos.length && !confirm(`¿Enviar a ${destinos.map(nombreDe).join(", ")}${lista.length ? ` con ${lista.length} adjunto${lista.length > 1 ? "s" : ""}` : ""}?`)) return;
          bloquear(true, "Enviando…");
          const { raw } = await montar();
          await subirMime("enviar", raw, { threadId });
          if (draftId) { try { await api(`/drafts/${draftId}`, { method: "DELETE" }); } catch (_) {} if (m) delete state.drafts[m.id]; }
          const archivar = m && $("#c-arch", root)?.checked;
          cerrar();
          if (m) delete state.cache[m.id];
          if (m && archivar) {
            await modificar(m.id, [], ["INBOX", lid(L.pedirBorrador)]);
            trasAccion(m, "Enviado ✓"); // abre sola la siguiente
          } else {
            toast("Enviado ✓");
            if (m && state.view === "correo" && state.abierto?.m.id === m.id) renderCorreo();
          }
          alTerminar?.();
        } catch (e) { bloquear(false, "✓ Enviar"); toast("No se pudo enviar: " + e.message); }
      };
      $("#c-guardar", root).onclick = async () => {
        try {
          bloquear(true);
          const { raw } = await montar().catch((e) => { if (/destinatario/.test(e.message)) return montarSinDestino(); throw e; });
          const r = await subirMime("borrador", raw, { threadId, draftId });
          if (m && threadId) { state.drafts[m.id] = { id: r.id, messageId: r.message?.id }; }
          cerrar();
          toast("Borrador guardado en Gmail ✓");
          if (m && state.view === "correo" && state.abierto?.m.id === m.id) renderCorreo();
          alTerminar?.();
        } catch (e) { bloquear(false); toast("No se pudo guardar: " + e.message); }
      };
      // Un borrador puede guardarse sin destinatario todavía
      const montarSinDestino = async () => ({
        raw: construirMime({ from: fromCompleto($("#c-de", root).value), to: "", subject: $("#c-asunto", root).value, html: cuerpoEl.innerHTML, text: cuerpoEl.innerText, adjuntos: await prepararAdjuntos(lista) })
      });
    }, { clase: "big comp", fijo: true });
  }

  function dialogoPosponer(ms, alHecho) {
    const hoy = new Date();
    const manana = new Date(hoy); manana.setDate(hoy.getDate() + 1);
    const lunes = new Date(hoy); lunes.setDate(hoy.getDate() + ((8 - hoy.getDay()) % 7 || 7));
    const semana = new Date(hoy); semana.setDate(hoy.getDate() + 7);
    const f = (d) => d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    modal(`<h3>Posponer${ms.length > 1 ? ` ${ms.length} correos` : ""} hasta…</h3>
      <p class="muted small">Sale de la bandeja y vuelve ese día, la primera vez que abras la web.</p>
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
        root.querySelectorAll("button").forEach((b) => (b.disabled = true));
        const nombre = `${L.pospuesto}/${dia}`;
        if (!lid(nombre)) {
          const nueva = await api("/labels", { method: "POST", body: JSON.stringify({ name: nombre, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
          state.labels[nombre] = nueva.id;
        }
        await enParalelo(ms, (m) => modificar(m.id, [lid(nombre)], ["INBOX"]));
        cerrar();
        alHecho(`el ${new Date(dia + "T12:00").toLocaleDateString("es-ES", { day: "numeric", month: "long" })}`);
      };
      const fallo = (e) => { root.querySelectorAll("button").forEach((b) => (b.disabled = false)); toast("Error: " + e.message); };
      root.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => aplicar(b.dataset.d).catch(fallo)));
      $("#ok", root).onclick = () => aplicar($("#otra", root).value).catch(fallo);
    });
  }

  const CLASIFICACION = () => [L.urgente, L.personal, L.ayto, L.responder, L.clave, L.firmar, L.delegar, L.leer];

  // Un correo: marcar o desmarcar etiquetas
  function dialogoEtiqueta(m) {
    const posibles = [...CLASIFICACION(), L.sensible];
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
        const aLeer = marcadas.includes(lid(L.leer));
        if (aLeer) remove.push("INBOX");
        try {
          await modificar(m.id, add, remove);
          cerrar();
          m.labelIds = m.labelIds.filter((id) => !remove.includes(id)).concat(add);
          const fuera = aLeer || !BLOQUES.some((b) => b.etiquetas().some((n) => m.labelIds.includes(lid(n))));
          construirCola().then((q) => { state.queue = q; if (state.view === "bandeja") pintarLista(); }).catch(() => {});
          if (fuera) return trasAccion(m, aLeer ? "Movido a «Solo leer»" : "Etiqueta cambiada ✓");
          m.bloque = BLOQUES.find((b) => b.etiquetas().some((n) => m.labelIds.includes(lid(n)))) || m.bloque;
          m.org = organizacion(m);
          toast("Etiqueta cambiada ✓");
          if (state.view === "correo") renderCorreo();
        } catch (e) { toast("Error: " + e.message); }
      };
    });
  }

  // Varios correos: moverlos todos a un mismo bloque
  function dialogoMover(ms, alHecho) {
    const opts = CLASIFICACION().filter((n) => lid(n)).map((n, i) => `<label class="opt"><input type="radio" name="dest" value="${esc(n)}" ${i === 0 ? "checked" : ""}> ${esc(n)}</label>`).join("");
    modal(`<h3>Mover ${ms.length} correo${ms.length > 1 ? "s" : ""} a…</h3>
      <p class="muted small">Se les quita su etiqueta actual y se les pone la que elijas. Queda registrado para que la clasificación aprenda.</p>
      <div class="opts">${opts}</div>
      <div class="foot"><button class="btn" data-cerrar>Cancelar</button><button class="btn btn-primary" id="ok">Mover</button></div>`,
    (root, cerrar) => {
      $("#ok", root).onclick = async (ev) => {
        const destino = root.querySelector("input[name=dest]:checked").value;
        ev.target.disabled = true;
        try {
          await moverA(ms, destino);
          cerrar();
          await alHecho(destino);
        } catch (e) { ev.target.disabled = false; toast("Error: " + e.message); }
      };
    });
  }

  // ----- Solo leer -----
  async function renderLeer() {
    const cont = $("#view-leer");
    cont.innerHTML = `<div class="view-head"><h2>Solo leer</h2></div><div class="loading">Cargando…</div>`;
    try {
      const hilos = await listarHilos([lid(L.leer), "INBOX"], "", 100);
      const metas = await metasDe(hilos);
      for (const m of metas) m.bloque = { key: "leer", titulo: "Solo leer", color: "var(--c-leer)" };
      metas.sort((a, b) => Number(b.date) - Number(a.date));
      if (!metas.length) { cont.innerHTML = `<div class="view-head"><h2>Solo leer</h2></div><div class="empty"><div class="big">📭</div><p>Nada pendiente de leer.</p></div>`; return; }
      cont.innerHTML = `<div class="view-head"><h2>Solo leer <span class="muted">${metas.length}</span></h2><button class="btn btn-sm" id="arch-todos">🗄 Archivar todos</button></div>
        <p class="muted small">Boletines, avisos y copias. No requieren respuesta.</p>
        <div class="list">${metas.map((m) => filaHtml(m, false, `<button class="btn btn-sm row-btn" data-arch="${m.id}" title="Archivar">🗄</button>`)).join("")}</div>`;
      conectarFilas(cont, metas, "leer");
      cont.querySelectorAll("[data-arch]").forEach((b) => (b.onclick = async () => {
        b.disabled = true;
        try { await modificar(b.dataset.arch, [], ["INBOX"]); b.closest(".row").remove(); }
        catch (e) { b.disabled = false; toast("Error: " + e.message); }
      }));
      $("#arch-todos").onclick = async (ev) => {
        if (!confirm(`¿Archivar los ${metas.length} correos de «Solo leer»? Seguirán en Gmail, solo salen de la bandeja.`)) return;
        ev.target.disabled = true;
        await enParalelo(metas, (m) => modificar(m.id, [], ["INBOX"]));
        toast("Archivados ✓");
        renderLeer();
      };
    } catch (e) { cont.innerHTML += `<div class="error-box">${esc(e.message)}</div>`; }
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
      const accionables = [L.urgente, L.responder, L.firmar, L.clave].map((n) => lid(n)).filter(Boolean);
      const hilos = new Map();
      for (const id of accionables) (await listarHilos([id, "INBOX"], `older_than:${dias}d`, 50)).forEach((h) => hilos.set(h.id, h));
      const sin = (await metasDe([...hilos.values()])).filter((m) => !m.ultimoMio);
      sin.sort((a, b) => Number(a.date) - Number(b.date));
      $("#seg-sin").className = "";
      $("#seg-sin").innerHTML = sin.length ? `<div class="list">${sin.map((m) => filaHtml(m)).join("")}</div>` : `<div class="card muted">Nada pendiente. 👍</div>`;
      conectarFilas($("#seg-sin"), sin, "seguimiento");

      const enviados = await listarHilos(["SENT"], `older_than:${dias}d newer_than:30d`, 60);
      const esp = (await metasDe(enviados)).filter((m) => m.ultimoMio && !/22q13\.org\.es/.test(m.to)).map((m) => ({ ...m, from: "Tú → " + m.to }));
      esp.sort((a, b) => Number(a.date) - Number(b.date));
      $("#seg-esp").className = "";
      $("#seg-esp").innerHTML = esp.length ? `<div class="list">${esp.map((m) => filaHtml(m)).join("")}</div>` : `<div class="card muted">Nadie te debe respuesta. 👍</div>`;
      conectarFilas($("#seg-esp"), esp, "seguimiento");
    } catch (e) { cont.innerHTML += `<div class="error-box">${esc(e.message)}</div>`; }
  }

  // ----- Borradores: todos los de Gmail (los que prepara Claude y los tuyos) -----
  async function renderBorradores() {
    const cont = $("#view-borradores");
    const cab = `<div class="view-head"><h2>Borradores</h2><button class="btn btn-sm" id="bor-recargar">↻ Actualizar</button></div>
      <p class="muted small">Son los mismos borradores que ves en Gmail. Ábrelos para leerlos, cambiarlos, adjuntar archivos y enviarlos.</p>`;
    cont.innerHTML = cab + `<div class="loading">Cargando borradores…</div>`;
    $("#bor-recargar").onclick = renderBorradores;
    try {
      await cargarBorradores();
      const r = await api("/drafts?maxResults=100");
      const lista = await enParalelo(r.drafts || [], (d) => api(`/drafts/${d.id}?format=full`));
      lista.sort((a, b) => Number(b.message.internalDate) - Number(a.message.internalDate));
      if (!lista.length) { cont.innerHTML = cab + `<div class="empty"><div class="big">📝</div><p>No tienes borradores.</p></div>`; $("#bor-recargar").onclick = renderBorradores; return; }
      cont.innerHTML = cab + `<div class="list">${lista.map((d, i) => {
        const bm = d.message;
        const nAdj = partes(bm.payload).adjuntos.length;
        return `<div class="row"><div class="row-main" data-bor="${i}">
          <div class="t">${esc(header(bm, "To") ? "Para: " + dividirDirecciones(header(bm, "To")).map(nombreDe).join(", ") : "(sin destinatario)")} — ${esc(header(bm, "Subject") || "(sin asunto)")}</div>
          <div class="s">${nAdj ? `📎 ${nAdj} · ` : ""}${esc(bm.snippet || "")}</div></div>
          <span class="row-date">${esc(fecha(bm.internalDate))}</span>
          <button class="btn btn-sm" data-bor="${i}">Abrir</button>
          <button class="btn btn-sm btn-danger" data-del="${i}" title="Descartar borrador">🗑</button></div>`;
      }).join("")}</div>`;
      $("#bor-recargar").onclick = renderBorradores;
      cont.querySelectorAll("[data-bor]").forEach((el) => (el.onclick = () => abrirRedactor({ modo: "borrador", borrador: lista[el.dataset.bor], alTerminar: renderBorradores })));
      cont.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
        if (!confirm("¿Descartar este borrador? Se borra también de Gmail.")) return;
        b.disabled = true;
        try { await api(`/drafts/${lista[b.dataset.del].id}`, { method: "DELETE" }); toast("Borrador descartado"); renderBorradores(); }
        catch (e) { b.disabled = false; toast("Error: " + e.message); }
      }));
    } catch (e) { cont.innerHTML = cab + `<div class="error-box">${esc(e.message)}</div>`; $("#bor-recargar").onclick = renderBorradores; }
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
        const metas = await metasDe(r.threads || []);
        res.innerHTML = metas.length ? `<div class="list">${metas.map((m) => filaHtml(m)).join("")}</div>` : `<div class="empty">Sin resultados.</div>`;
        conectarFilas(res, metas, "buscar");
      } catch (err) { res.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
    };
  }

  window.addEventListener("load", initAuth);
})();
