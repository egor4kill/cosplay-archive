/* =========================================================
   Cosplay Archive — синхронизация с Google Drive
   Файл: js/drive.js

   Модуль инкапсулирует OAuth (Google Identity Services, поток
   access token) и обращения к Drive REST API. Наружу отдаёт
   window.CosplayDrive — небольшой набор промис-функций.
   ========================================================= */

(() => {
  "use strict";

  const GIS_SRC = "https://accounts.google.com/gsi/client";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const JSON_MIME = "application/json";

  const config = {
    clientId: "",
    scope: "https://www.googleapis.com/auth/drive.file",
    rootFolderName: "Cosplay Archive",
    manifestName: "archive.json",
    photosFolderName: "photos"
  };

  let tokenClient = null;
  let gisPromise = null;
  let accessToken = "";
  let tokenExpiresAt = 0;
  let rootFolderId = "";
  let photosFolderId = "";

  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      return Promise.resolve();
    }

    if (gisPromise) return gisPromise;

    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(
        new Error("Не удалось загрузить Google Identity Services.")
      );
      document.head.appendChild(script);
    });

    return gisPromise;
  }

  function configure(options = {}) {
    config.clientId = String(options.clientId || "");
    config.scope = options.scope || config.scope;
    config.rootFolderName = options.rootFolderName || config.rootFolderName;
    config.manifestName = options.manifestName || config.manifestName;
    config.photosFolderName = options.photosFolderName || config.photosFolderName;
  }

  function isConfigured() {
    return Boolean(config.clientId);
  }

  function hasToken() {
    return Boolean(accessToken) && Date.now() < tokenExpiresAt;
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

  function requestToken(options) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) {
        reject(new Error("Не задан Google OAuth Client ID."));
        return;
      }

      initTokenClient().then(client => {
        client.callback = response => {
          if (response.error) {
            reject(new Error(
              response.error_description || response.error
            ));
            return;
          }

          accessToken = response.access_token;
          const seconds = Number(response.expires_in || 3600);
          tokenExpiresAt = Date.now() + Math.max(60, seconds - 120) * 1000;
          resolve(accessToken);
        };

        client.requestAccessToken(options);
      }).catch(reject);
    });
  }

  function connect() {
    if (hasToken()) return Promise.resolve(accessToken);
    return requestToken();
  }

  function trySilentConnect() {
    if (hasToken()) return Promise.resolve(true);

    return requestToken({ prompt: "" })
      .then(() => true)
      .catch(() => false);
  }

  function signOut() {
    const token = accessToken;
    accessToken = "";
    tokenExpiresAt = 0;
    rootFolderId = "";
    photosFolderId = "";

    if (token && window.google && window.google.accounts
      && window.google.accounts.oauth2) {
      try {
        window.google.accounts.oauth2.revoke(token, () => {});
      } catch {
        /* игнорируем */
      }
    }
  }

  function ensureToken() {
    if (hasToken()) return Promise.resolve(accessToken);
    return requestToken({ prompt: "" });
  }

  async function apiFetch(url, options = {}) {
    const token = await ensureToken();

    const headers = Object.assign({}, options.headers, {
      Authorization: `Bearer ${token}`
    });

    const response = await fetch(url, Object.assign({}, options, { headers }));

    if (!response.ok) {
      let detail = "";

      try {
        const data = await response.json();
        detail = data?.error?.message || "";
      } catch {
        /* тело не JSON */
      }

      throw new Error(detail || `Ошибка Google Drive (${response.status}).`);
    }

    return response;
  }

  function escapeQueryValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  async function findChild(name, parentId, mimeType) {
    const clauses = [
      `name = '${escapeQueryValue(name)}'`,
      `'${parentId}' in parents`,
      "trashed = false"
    ];

    if (mimeType) clauses.push(`mimeType = '${mimeType}'`);

    const query = encodeURIComponent(clauses.join(" and "));
    const url = `${DRIVE_API}/files?q=${query}`
      + "&fields=files(id,name,mimeType)&pageSize=10";

    const response = await apiFetch(url);
    const data = await response.json();

    return data.files?.[0] || null;
  }

  async function createFolder(name, parentId) {
    const response = await apiFetch(`${DRIVE_API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": JSON_MIME },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: parentId ? [parentId] : undefined
      })
    });

    const data = await response.json();
    return data.id;
  }

  async function ensureFolders() {
    if (rootFolderId && photosFolderId) {
      return { rootFolderId, photosFolderId };
    }

    const root = await findChild(config.rootFolderName, "root", FOLDER_MIME);
    rootFolderId = root ? root.id : await createFolder(config.rootFolderName, "root");

    const photos = await findChild(
      config.photosFolderName, rootFolderId, FOLDER_MIME
    );
    photosFolderId = photos
      ? photos.id
      : await createFolder(config.photosFolderName, rootFolderId);

    return { rootFolderId, photosFolderId };
  }

  async function uploadNewFile(name, blob, parentId, mimeType) {
    const createResponse = await apiFetch(`${DRIVE_API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": JSON_MIME },
      body: JSON.stringify({
        name,
        parents: parentId ? [parentId] : undefined,
        mimeType: mimeType || "application/octet-stream"
      })
    });

    const created = await createResponse.json();

    await apiFetch(`${DRIVE_UPLOAD}/files/${created.id}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType || "application/octet-stream" },
      body: blob
    });

    return created.id;
  }

  async function updateFileMedia(fileId, blob, mimeType) {
    await apiFetch(`${DRIVE_UPLOAD}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType || "application/octet-stream" },
      body: blob
    });

    return fileId;
  }

  async function saveManifest(manifestObject) {
    await ensureFolders();

    const blob = new Blob(
      [JSON.stringify(manifestObject)],
      { type: JSON_MIME }
    );

    const existing = await findChild(
      config.manifestName, rootFolderId, JSON_MIME
    );

    if (existing) {
      return updateFileMedia(existing.id, blob, JSON_MIME);
    }

    return uploadNewFile(config.manifestName, blob, rootFolderId, JSON_MIME);
  }

  async function getManifest() {
    await ensureFolders();

    const existing = await findChild(
      config.manifestName, rootFolderId, JSON_MIME
    );

    if (!existing) return null;

    const response = await apiFetch(`${DRIVE_API}/files/${existing.id}?alt=media`);
    return response.json();
  }

  async function listPhotos() {
    await ensureFolders();

    const query = encodeURIComponent(
      `'${photosFolderId}' in parents and trashed = false`
    );

    const base = `${DRIVE_API}/files?q=${query}`
      + "&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000";

    const map = new Map();
    let pageToken = "";

    do {
      const url = pageToken
        ? `${base}&pageToken=${encodeURIComponent(pageToken)}`
        : base;

      const response = await apiFetch(url);
      const data = await response.json();

      for (const file of data.files || []) {
        map.set(file.name, file);
      }

      pageToken = data.nextPageToken || "";
    } while (pageToken);

    return map;
  }

  async function uploadPhoto(name, blob, mimeType, existingId) {
    await ensureFolders();

    if (existingId) {
      return updateFileMedia(existingId, blob, mimeType);
    }

    return uploadNewFile(name, blob, photosFolderId, mimeType);
  }

  async function downloadFile(fileId) {
    const response = await apiFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
    return response.blob();
  }

  async function deleteFile(fileId) {
    await apiFetch(`${DRIVE_API}/files/${fileId}`, { method: "DELETE" });
  }

  window.CosplayDrive = {
    configure,
    isConfigured,
    hasToken,
    connect,
    trySilentConnect,
    signOut,
    ensureToken,
    ensureFolders,
    getManifest,
    saveManifest,
    listPhotos,
    uploadPhoto,
    downloadFile,
    deleteFile
  };
})();
