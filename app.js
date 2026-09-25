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

  // Envía o guarda un correo por la vía de subida de Gmail (admite adjuntos de hasta 25 MB)
  async function subirMime(tipo, raw, { threadId, draftId } = {}) {
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
      const ajustar = () => { iframe.style.height = Math.min(Math.max(doc.body.scrollHeight + 32, 160), window.innerHeight * 0.75) + "px"; };
      ajustar();
      doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", ajustar));
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
  function mostrarVista(v) {
    state.view = v;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
    for (const s of ["bandeja", "borradores", "leer", "seguimiento", "buscar"]) $("#view-" + s).hidden = s !== v;
    if (v === "bandeja") renderBandeja();
    if (v === "borradores") renderBorradores();
    if (v === "leer") renderLeer();
    if (v === "seguimiento") renderSeguimiento();
    if (v === "buscar") renderBuscar();
  }

  async function arrancar() {
    $("#view-login").hidden = true;
    $("#topbar").hidden = false;
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => mostrarVista(t.dataset.view)));
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

  const adjuntosHilo = (hilo) => (hilo.messages || []).flatMap((msg) => partes(msg.payload, undefined, msg.id).adjuntos);

  function tarjeta(m, hilo) {
    const d = state.drafts[m.id];
    const gmailUrl = `https://mail.google.com/mail/u/0/#all/${m.id}`;
    const adjs = adjuntosHilo(hilo);
    return `<article class="card" id="card">
      ${chips(m)}
      <div class="from">${esc(nombreDe(m.from))}</div>
      <div class="meta">${esc(emailDe(m.from))} · ${esc(fecha(m.date))}${m.count > 1 ? ` · ${m.count} mensajes` : ""}</div>
      <div class="subject">${esc(m.subject)}</div>
      ${adjs.length ? `<div class="section-title">Adjuntos (${adjs.length})</div><div id="adjs">${listaAdjuntosHtml(adjs)}</div>` : ""}
      <details class="original" open><summary>Correo completo</summary><iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Correo original" id="orig"></iframe></details>
      <div class="section-title">Borrador propuesto</div>
      ${d ? `<div class="draft-meta" id="draft-meta">Cargando borrador…</div><div class="draft" id="draft" contenteditable="true"></div><div id="draft-adj" class="draft-adj"></div>`
          : `<div class="no-draft">${m.labelIds.includes(lid(L.pedirBorrador)) ? "Borrador pedido: estará listo en la próxima pasada." : "Todavía no hay borrador para este correo. Puedes pedirlo o escribir tú la respuesta."}</div>`}
      <div class="actions">
        ${d ? `<button class="btn btn-primary wide" data-a="enviar">✓ Enviar</button>` : `<button class="btn btn-primary wide" data-a="pedir">✍ Pídeme borrador</button>`}
        <button class="btn" data-a="responder">↩ Responder</button>
        <button class="btn" data-a="todos">↩ Responder a todos</button>
        <button class="btn" data-a="reenviar">↪ Reenviar</button>
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
    montarCorreo($("#orig"), hilo);
    if ($("#adjs")) conectarAdjuntos($("#adjs"), adjuntosHilo(hilo));
    $("#card").querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => accion(b.dataset.a, m, hilo, b)));
    const d = state.drafts[m.id];
    if (d) {
      try {
        const dr = d.full || await api(`/drafts/${d.id}?format=full`);
        d.full = dr;
        const p = partes(dr.message.payload, undefined, dr.message.id);
        const from = header(dr.message, "From") || state.me;
        const to = header(dr.message, "To");
        if (!d.adjuntos) d.adjuntos = p.adjuntos; // los que ya traía el borrador + los que añadas
        if (!$("#draft")) return;
        $("#draft-meta").textContent = `De: ${from} · Para: ${to}${header(dr.message, "Cc") ? " · Cc: " + header(dr.message, "Cc") : ""}`;
        if (d.editado != null) $("#draft").innerHTML = d.editado;
        else $("#draft").innerHTML = p.html ? limpiarHtml(p.html) : esc(p.text).replace(/\n/g, "<br>");
        $("#draft").oninput = () => (d.editado = $("#draft").innerHTML);
        selectorAdjuntos($("#draft-adj"), d.adjuntos, $("#card"));
      } catch (e) { if ($("#draft-meta")) $("#draft-meta").textContent = "No se pudo cargar el borrador: " + e.message; }
    }
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
    const adjs = d.adjuntos || [];
    if (!confirm(`¿Enviar la respuesta a ${header(msg, "To")}${adjs.length ? ` con ${adjs.length} adjunto${adjs.length > 1 ? "s" : ""}` : ""}?`)) return;
    btn.disabled = true;
    btn.textContent = "Enviando…";
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
    delete state.drafts[m.id];
    await modificar(m.id, [], ["INBOX", lid(L.pedirBorrador)]);
    toast("Enviado ✓");
    siguiente(true);
  }

  // ----- Diálogos -----
  function modal(html, onMount, { alCerrar, clase = "", fijo = false } = {}) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-back"><div class="modal ${clase}" role="dialog" aria-modal="true">${html}</div></div>`;
    const back = root.firstElementChild;
    const cerrar = () => { root.innerHTML = ""; alCerrar?.(); };
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
          if (m && archivar) {
            await modificar(m.id, [], ["INBOX", lid(L.pedirBorrador)]);
            delete state.cache[m.id];
            toast("Enviado ✓");
            if (state.view === "bandeja" && colaFiltrada()[state.pos] === m) siguiente(true);
          } else {
            if (m) delete state.cache[m.id];
            toast("Enviado ✓");
            if (m && state.view === "bandeja") renderBandeja();
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
          if (m && state.view === "bandeja") renderBandeja();
          alTerminar?.();
        } catch (e) { bloquear(false); toast("No se pudo guardar: " + e.message); }
      };
      // Un borrador puede guardarse sin destinatario todavía
      const montarSinDestino = async () => ({
        raw: construirMime({ from: fromCompleto($("#c-de", root).value), to: "", subject: $("#c-asunto", root).value, html: cuerpoEl.innerHTML, text: cuerpoEl.innerText, adjuntos: await prepararAdjuntos(lista) })
      });
    }, { clase: "big comp", fijo: true });
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
        const metas = await enParalelo((r.threads || []).map((t) => t.id), async (id) => resumenMeta(await hiloMeta(id)));
        res.innerHTML = metas.length ? `<div class="list">${metas.map((m) => filaHtml(m)).join("")}</div>` : `<div class="empty">Sin resultados.</div>`;
        conectarFilas(res, metas);
      } catch (err) { res.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
    };
  }

  window.addEventListener("load", initAuth);
})();
