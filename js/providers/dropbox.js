/* =========================================================
   Cosplay Archive — провайдер Dropbox
   Файл: js/providers/dropbox.js

   OAuth 2.0 PKCE (public client, без client_secret).
   Content API v2 для загрузки/скачивания файлов.
   Интерфейс совпадает с Google Drive (см. registry.js).
   ========================================================= */

(() => {
  "use strict";

  const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
  const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
  const CONTENT_URL = "https://content.dropboxapi.com/2";
  const API_URL = "https://api.dropboxapi.com/2";

  const STORAGE_KEY = "cosplay-dropbox-token";
  const VERIFIER_KEY = "cosplay-dropbox-verifier";
  const STATE_KEY = "cosplay-dropbox-state";

  const config = {
    appKey: "",
    rootFolderName: "Cosplay Archive",
    manifestName: "archive.json",
    photosFolderName: "photos"
  };

  let accessToken = "";
  let tokenExpiresAt = 0;
  let refreshToken = "";

  /* ---------- Токены ---------- */

  function loadTokens() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      accessToken = data.access || "";
      tokenExpiresAt = data.expiresAt || 0;
      refreshToken = data.refresh || "";
    } catch {
      /* ignore */
    }
  }

  function saveTokens() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        access: accessToken,
        expiresAt: tokenExpiresAt,
        refresh: refreshToken
      }));
    } catch {
      /* ignore */
    }
  }

  function clearTokens() {
    accessToken = "";
    tokenExpiresAt = 0;
    refreshToken = "";
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /* ---------- Конфигурация ---------- */

  function configure(options = {}) {
    config.appKey = String(options.appKey || "");
    config.rootFolderName = options.rootFolderName || config.rootFolderName;
    config.manifestName = options.manifestName || config.manifestName;
    config.photosFolderName = options.photosFolderName || config.photosFolderName;
  }

  function isConfigured() {
    return Boolean(config.appKey);
  }

  function hasToken() {
    if (!accessToken) loadTokens();
    return Boolean(accessToken) && Date.now() < tokenExpiresAt;
  }

  /* ---------- PKCE helpers ---------- */

  function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async function sha256Base64Url(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return base64url(new Uint8Array(digest));
  }

  function generateCodeVerifier() {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  function generateState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  function redirectUri() {
    // Убираем index.html из pathname, если есть.
    let path = window.location.pathname;
    path = path.replace(/index\.html$/, "");
    return window.location.origin + path;
  }

  /* ---------- OAuth ---------- */

  async function connect() {
    if (!isConfigured()) {
      throw new Error("Не задан Dropbox App Key (см. README).");
    }

    const verifier = generateCodeVerifier();
    const challenge = await sha256Base64Url(verifier);
    const state = generateState();

    try {
      sessionStorage.setItem(VERIFIER_KEY, verifier);
      sessionStorage.setItem(STATE_KEY, state);
    } catch {
      throw new Error("Dropbox OAuth: нет доступа к sessionStorage.");
    }

    const params = new URLSearchParams({
      client_id: config.appKey,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri(),
      state,
      token_access_type: "offline"
    });

    // Страница перезагрузится — промис не разрешится здесь.
    window.location.href = AUTHORIZE_URL + "?" + params;
    return new Promise(() => {});
  }

  /**
   * Если URL содержит ?code=… (вернулись из Dropbox OAuth),
   * обмениваем код на токен и чистим адресную строку.
   */
  async function tryHandleRedirect() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return false;

    const returnedState = url.searchParams.get("state") || "";
    let verifier = "";
    let savedState = "";

    try {
      verifier = sessionStorage.getItem(VERIFIER_KEY) || "";
      savedState = sessionStorage.getItem(STATE_KEY) || "";
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
    } catch {
      /* ignore */
    }

    // Чистим URL сразу, чтобы code не остался в истории.
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);

    if (!verifier) {
      throw new Error("Dropbox OAuth: нет сохранённого PKCE-verifier.");
    }
    if (savedState && returnedState !== savedState) {
      throw new Error("Dropbox OAuth: state mismatch.");
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: config.appKey,
        code_verifier: verifier,
        redirect_uri: redirectUri()
      })
    });

    if (!response.ok) {
      throw new Error("Dropbox OAuth: обмен кода не удался (" + response.status + ").");
    }

    const data = await response.json();
    accessToken = data.access_token || "";
    tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 14400) - 120) * 1000;
    refreshToken = data.refresh_token || "";
    saveTokens();
    return true;
  }

  async function refreshAccessToken() {
    if (!refreshToken) {
      clearTokens();
      throw new Error("Dropbox: нет refresh-токена.");
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.appKey
      })
    });

    if (!response.ok) {
      clearTokens();
      throw new Error("Dropbox: обновление токена не удалось (" + response.status + ").");
    }

    const data = await response.json();
    accessToken = data.access_token || "";
    tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 14400) - 120) * 1000;
    if (data.refresh_token) refreshToken = data.refresh_token;
    saveTokens();
  }

  async function trySilentConnect() {
    if (!isConfigured()) return false;

    // Сначала пробуем обработать redirect (если только что вернулись из OAuth).
    try {
      if (await tryHandleRedirect()) return true;
    } catch (error) {
      console.warn("Dropbox redirect handler:", error);
    }

    if (hasToken()) return true;

    if (refreshToken) {
      try {
        await refreshAccessToken();
        return true;
      } catch {
        /* ignore */
      }
    }

    loadTokens();
    return hasToken();
  }

  function signOut() {
    clearTokens();
  }

  async function ensureToken() {
    if (hasToken()) return accessToken;
    if (refreshToken) {
      await refreshAccessToken();
      return accessToken;
    }
    loadTokens();
    if (hasToken()) return accessToken;
    throw new Error("Dropbox: нет токена. Подключите аккаунт.");
  }

  /* ---------- HTTP helpers ---------- */

  async function dropboxError(response) {
    let detail = "";
    try {
      const data = await response.json();
      detail = data.error_summary || data.error?.[".tag"] || "";
    } catch {
      /* ignore */
    }
    return new Error(detail || "Dropbox API (" + response.status + ").");
  }

  async function apiJson(endpoint, body) {
    const token = await ensureToken();
    const response = await fetch(API_URL + endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw await dropboxError(response);
    return response.json();
  }

  async function contentRequest(endpoint, apiArg, body) {
    const token = await ensureToken();
    const response = await fetch(CONTENT_URL + endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Dropbox-API-Arg": JSON.stringify(apiArg)
      },
      body
    });

    if (!response.ok) throw await dropboxError(response);
    return response;
  }

  /* ---------- Папки ---------- */

  async function createFolderIfMissing(path) {
    try {
      await apiJson("/files/create_folder_v2", { path });
    } catch (error) {
      // path/conflict/folder — уже существует, это нормально.
      if (!String(error.message).includes("path/conflict")) {
        throw error;
      }
    }
  }

  async function ensureFolders() {
    const root = "/" + config.rootFolderName;
    const photos = root + "/" + config.photosFolderName;
    await createFolderIfMissing(root);
    await createFolderIfMissing(photos);
    return { rootPath: root, photosPath: photos };
  }

  /* ---------- Манифест ---------- */

  async function getManifest() {
    await ensureFolders();
    const path = "/" + config.rootFolderName + "/" + config.manifestName;

    try {
      const response = await contentRequest("/files/download", { path });
      return await response.json();
    } catch (error) {
      if (String(error.message).includes("not_found")) return null;
      throw error;
    }
  }

  async function saveManifest(manifestObject) {
    await ensureFolders();
    const path = "/" + config.rootFolderName + "/" + config.manifestName;
    const blob = new Blob([JSON.stringify(manifestObject)], { type: "application/json" });
    await contentRequest("/files/upload", { path, mode: "overwrite" }, blob);
  }

  /* ---------- Фото ---------- */

  async function listPhotos() {
    await ensureFolders();
    const path = "/" + config.rootFolderName + "/" + config.photosFolderName;
    const map = new Map();
    let cursor = "";

    do {
      const body = cursor
        ? { cursor, include_deleted: false }
        : { path, include_deleted: false };

      const data = cursor
        ? await apiJson("/files/list_folder/continue", body)
        : await apiJson("/files/list_folder", body);

      for (const entry of data.entries || []) {
        if (entry[".tag"] === "file") {
          map.set(entry.name, {
            id: entry.id,
            name: entry.name,
            size: entry.size
          });
        }
      }

      cursor = data.has_more ? data.cursor : "";
    } while (cursor);

    return map;
  }

  async function uploadPhoto(name, blob, mimeType, existingId) {
    await ensureFolders();
    const path = "/" + config.rootFolderName + "/" + config.photosFolderName + "/" + name;

    const response = await contentRequest(
      "/files/upload",
      { path, mode: "overwrite", autorename: false },
      blob
    );

    const data = await response.json();
    return data.id;
  }

  async function downloadFile(fileId) {
    const path = String(fileId).startsWith("id:") ? fileId : "id:" + fileId;
    const response = await contentRequest("/files/download", { path });
    return response.blob();
  }

  async function deleteFile(fileId) {
    const path = String(fileId).startsWith("id:") ? fileId : "id:" + fileId;
    await apiJson("/files/delete_v2", { path });
  }

  /* ---------- Экспорт ---------- */

  const provider = {
    id: "dropbox",
    label: "Dropbox",
    configure,
    isConfigured,
    hasToken,
    connect,
    trySilentConnect,
    signOut,
    ensureFolders,
    getManifest,
    saveManifest,
    listPhotos,
    uploadPhoto,
    downloadFile,
    deleteFile
  };

  window.CosplayDropbox = provider;
  window.CosplayProviders?.register("dropbox", provider);
})();
