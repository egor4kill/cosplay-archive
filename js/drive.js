/* Cosplay Archive — Google Drive multi-account */
(() => {
  "use strict";

  const GIS_SRC = "https://accounts.google.com/gsi/client";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const JSON_MIME = "application/json";

  const TOKENS_KEY = "cosplay-gdrive-tokens"; // array of {id,email,access,expiresAt,refresh?}
  const ACTIVE_KEY = "cosplay-gdrive-active-id";

  const config = {
    clientId: "",
    scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
    rootFolderName: "Cosplay Archive",
    manifestName: "archive.json",
    photosFolderName: "photos"
  };

  let tokenClient = null;
  let gisPromise = null;
  let tokens = [];
  let activeId = null;
  let rootMap = new Map();
  let photosMap = new Map();

  function loadAll() {
    try {
      const raw = localStorage.getItem(TOKENS_KEY);
      if (raw) tokens = JSON.parse(raw) || [];
    } catch {
      tokens = [];
    }
    try {
      activeId = localStorage.getItem(ACTIVE_KEY) || (tokens[0] && tokens[0].id) || null;
    } catch {
      activeId = (tokens[0] && tokens[0].id) || null;
    }
    if (!tokens.find(t => t.id === activeId)) activeId = (tokens[0] && tokens[0].id) || null;
  }

  function saveAll() {
    try { localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens)); } catch {}
    try { if (activeId) localStorage.setItem(ACTIVE_KEY, activeId); } catch {}
  }

  function genId() {
    return crypto.randomUUID ? crypto.randomUUID() : ("gd" + Date.now() + Math.random().toString(36).slice(2, 8));
  }

  function listTargets() {
    loadAll();
    return tokens.map(t => ({ id: t.id, email: t.email || "gdrive", label: t.email ? ("Google Drive (" + t.email + ")") : "Google Drive" }));
  }

  function getTargetById(id) {
    loadAll();
    if (!id) return null;
    return tokens.find(t => t.id === id || (t.email && t.email === id)) || null;
  }

  function getActiveTarget() {
    loadAll();
    return getTargetById(activeId) || tokens[0] || null;
  }

  function setActiveTarget(id) {
    loadAll();
    if (getTargetById(id)) { activeId = id; saveAll(); }
  }

  function configure(o = {}) {
    config.clientId = String(o.clientId || "");
    config.scope = o.scope || config.scope;
    config.rootFolderName = o.rootFolderName || config.rootFolderName;
    config.manifestName = o.manifestName || config.manifestName;
    config.photosFolderName = o.photosFolderName || config.photosFolderName;
  }

  function isConfigured() { return Boolean(config.clientId); }

  function isConnected() {
    loadAll();
    return tokens.length > 0;
  }

  function hasToken(tid) {
    loadAll();
    if (tid) {
      const t = getTargetById(tid);
      return Boolean(t) && Boolean(t.access) && Date.now() < (t.expiresAt || 0);
    }
    return tokens.some(t => Boolean(t.access) && Date.now() < (t.expiresAt || 0));
  }

  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = GIS_SRC; s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("GIS load failed"));
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  function initTokenClient() {
    return loadGis().then(() => {
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: config.clientId,
          scope: config.scope,
          callback: () => {}
        });
      }
      return tokenClient;
    });
  }

  function requestToken(opts, entry) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) { reject(new Error("no clientId")); return; }
      initTokenClient().then(c => {
        c.callback = res => {
          if (res.error) { reject(new Error(res.error_description || res.error)); return; }
          const access = res.access_token;
          const secs = Number(res.expires_in || 3600);
          const exp = Date.now() + Math.max(60, secs - 120) * 1000;
          const e = entry || getActiveTarget() || { id: genId(), email: "" };
          e.access = access; e.expiresAt = exp;
          if (!e.id) e.id = genId();
          loadAll();
          const idx = tokens.findIndex(t => t.id === e.id || (t.email && e.email && t.email === e.email));
          if (idx >= 0) tokens[idx] = Object.assign(tokens[idx], e); else tokens.push(e);
          activeId = e.id; saveAll();
          resolve(access);
        };
        const reqOpts = Object.assign({}, opts);
        // Если запрашивается выбор аккаунта — НЕ передаём hint, чтобы Google показал список всех аккаунтов
        if (reqOpts.prompt === "select_account" || reqOpts.prompt === "consent") {
          delete reqOpts.hint;
          delete reqOpts.login_hint;
        } else if (!reqOpts.hint && entry && entry.email) {
          reqOpts.hint = entry.email;
        }
        c.requestAccessToken(reqOpts);
      }).catch(reject);
    });
  }

  async function connect(tid, force) {
    loadAll();
    let e = tid ? getTargetById(tid) : (force ? null : getActiveTarget());
    if (!e) e = { id: genId(), email: "" };
    if (!force && e.access && Date.now() < (e.expiresAt || 0)) { activeId = e.id; saveAll(); return e.access; }
    const access = await requestToken({ prompt: "select_account" }, e);
    try {
      const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + access } });
      if (r.ok) {
        const j = await r.json();
        if (j.email) {
          loadAll();
          const existing = tokens.find(t => t.id !== e.id && t.email === j.email);
          if (existing) {
            existing.access = e.access;
            existing.expiresAt = e.expiresAt;
            tokens = tokens.filter(t => t.id !== e.id);
            activeId = existing.id;
          } else {
            const t = tokens.find(tok => tok.id === e.id);
            if (t) {
              t.email = j.email;
              t.id = j.email;
              if (activeId === e.id) activeId = j.email;
            }
          }
          saveAll();
        }
      }
    } catch {}
    return access;
  }

  async function trySilentConnect(tid) {
    loadAll();
    const t = tid ? getTargetById(tid) : getActiveTarget();
    if (!t) return false;
    if (t.access && Date.now() < (t.expiresAt || 0)) return true;
    try { await requestToken({ prompt: "" }, t); return true; } catch { return false; }
  }

  function signOut(tid) {
    loadAll();
    if (tid) {
      tokens = tokens.filter(t => t.id !== tid && t.email !== tid);
      if (activeId === tid) activeId = (tokens[0] && tokens[0].id) || null;
      saveAll();
      return;
    }
    tokens = [];
    activeId = null;
    saveAll();
  }

  async function ensureToken(tid) {
    loadAll();
    let t = tid ? getTargetById(tid) : getActiveTarget();
    if (!t && tid) t = getActiveTarget();
    if (!t) throw new Error("no token");
    if (t.access && Date.now() < (t.expiresAt || 0)) return t.access;
    await requestToken({ prompt: "" }, t);
    return (getTargetById(t.id) || getActiveTarget()).access;
  }

  async function apiFetch(url, opts = {}, tid) {
    const tok = await ensureToken(tid);
    const h = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + tok });
    const resp = await fetch(url, Object.assign({}, opts, { headers: h }));
    if (!resp.ok) {
      let d = ""; try { const j = await resp.json(); d = (j.error && j.error.message) || ""; } catch {}
      throw new Error(d || ("GD " + resp.status));
    }
    return resp;
  }

  function esc(v) { return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

  async function findChild(name, parent, mime, tid) {
    const c = ["name='" + esc(name) + "'", "'" + parent + "' in parents", "trashed=false"];
    if (mime) c.push("mimeType='" + mime + "'");
    const q = encodeURIComponent(c.join(" and "));
    const r = await apiFetch(DRIVE_API + "/files?q=" + q + "&fields=files(id,name,mimeType)&pageSize=10", {}, tid);
    const d = await r.json();
    return (d.files && d.files[0]) || null;
  }

  async function createFolder(name, parent, tid) {
    const r = await apiFetch(DRIVE_API + "/files?fields=id", { method: "POST", headers: { "Content-Type": JSON_MIME }, body: JSON.stringify({ name: name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined }) }, tid);
    const d = await r.json(); return d.id;
  }

  async function ensureFolders(tid) {
    const k = tid || "a";
    if (rootMap.has(k) && photosMap.has(k)) return { rootFolderId: rootMap.get(k), photosFolderId: photosMap.get(k) };
    const root = await findChild(config.rootFolderName, "root", FOLDER_MIME, tid);
    const rid = root ? root.id : await createFolder(config.rootFolderName, "root", tid);
    const pho = await findChild(config.photosFolderName, rid, FOLDER_MIME, tid);
    const pid = pho ? pho.id : await createFolder(config.photosFolderName, rid, tid);
    rootMap.set(k, rid); photosMap.set(k, pid);
    return { rootFolderId: rid, photosFolderId: pid };
  }

  async function uploadNewFile(name, blob, parent, mime, tid) {
    const cr = await apiFetch(DRIVE_API + "/files?fields=id", { method: "POST", headers: { "Content-Type": JSON_MIME }, body: JSON.stringify({ name: name, parents: parent ? [parent] : undefined, mimeType: mime || "application/octet-stream" }) }, tid);
    const c = await cr.json();
    await apiFetch(DRIVE_UPLOAD + "/files/" + c.id + "?uploadType=media", { method: "PATCH", headers: { "Content-Type": mime || "application/octet-stream" }, body: blob }, tid);
    return c.id;
  }

  async function updateFileMedia(id, blob, mime, tid) {
    await apiFetch(DRIVE_UPLOAD + "/files/" + id + "?uploadType=media", { method: "PATCH", headers: { "Content-Type": mime || "application/octet-stream" }, body: blob }, tid);
    return id;
  }

  async function saveManifest(m, tid) {
    const f = await ensureFolders(tid);
    const b = new Blob([JSON.stringify(m)], { type: JSON_MIME });
    const ex = await findChild(config.manifestName, f.rootFolderId, JSON_MIME, tid);
    if (ex) return updateFileMedia(ex.id, b, JSON_MIME, tid);
    return uploadNewFile(config.manifestName, b, f.rootFolderId, JSON_MIME, tid);
  }

  async function getManifest(tid) {
    const f = await ensureFolders(tid);
    const ex = await findChild(config.manifestName, f.rootFolderId, JSON_MIME, tid);
    if (!ex) return null;
    const r = await apiFetch(DRIVE_API + "/files/" + ex.id + "?alt=media", {}, tid);
    return r.json();
  }

  async function listPhotos(tid) {
    const f = await ensureFolders(tid);
    const q = encodeURIComponent("'" + f.photosFolderId + "' in parents and trashed=false");
    const base = DRIVE_API + "/files?q=" + q + "&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000";
    const map = new Map();
    let t = "";
    do {
      const url = t ? base + "&pageToken=" + encodeURIComponent(t) : base;
      const r = await apiFetch(url, {}, tid);
      const d = await r.json();
      for (const x of (d.files || [])) map.set(x.name, x);
      t = d.nextPageToken || "";
    } while (t);
    return map;
  }

  async function uploadPhoto(name, blob, mime, exid, tid) {
    const f = await ensureFolders(tid);
    if (exid) return updateFileMedia(exid, blob, mime, tid);
    return uploadNewFile(name, blob, f.photosFolderId, mime, tid);
  }

  async function downloadFile(fid, tid) {
    const r = await apiFetch(DRIVE_API + "/files/" + fid + "?alt=media", {}, tid);
    return r.blob();
  }

  async function deleteFile(fid, tid) {
    await apiFetch(DRIVE_API + "/files/" + fid, { method: "DELETE" }, tid);
  }

  async function getQuota(tid) {
    const r = await apiFetch(DRIVE_API + "/about?fields=storageQuota", {}, tid);
    const d = await r.json();
    return d.storageQuota || null;
  }

  const p = {
    id: "gdrive",
    label: "Google Drive",
    configure,
    isConfigured,
    hasToken: (tid) => hasToken(tid),
    isConnected: () => isConnected(),
    connect: (tid, force) => connect(tid, force),
    trySilentConnect: (tid) => trySilentConnect(tid),
    signOut: (tid) => signOut(tid),
    ensureFolders: (tid) => ensureFolders(tid),
    getManifest: (tid) => getManifest(tid),
    saveManifest: (m, tid) => saveManifest(m, tid),
    listPhotos: (tid) => listPhotos(tid),
    uploadPhoto: (n, b, m, e, tid) => uploadPhoto(n, b, m, e, tid),
    downloadFile: (f, tid) => downloadFile(f, tid),
    deleteFile: (f, tid) => deleteFile(f, tid),
    getQuota: (tid) => getQuota(tid),
    listTargets,
    getTargetById,
    setActiveTarget,
    getActiveTarget,
    activeIdGetter: () => { loadAll(); return activeId; }
  };

  window.CosplayDrive = p;
  window.CosplayProviders && window.CosplayProviders.register("gdrive", p);
})();
