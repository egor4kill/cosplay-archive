/* =========================================================
   Cosplay Archive — основная логика приложения
   Файл: js/app.js
   ========================================================= */

(() => {
  "use strict";

  const CONFIG = window.COSPLAY_CONFIG || {
    appName: "Cosplay Archive",
    dataVersion: 1,
    databaseName: "cosplay-archive",
    databaseVersion: 1,
    stores: {
      models: "models",
      sets: "sets",
      photos: "photos"
    },
    maxPhotosPerImport: 200,
    allowedImageTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/avif"
    ],
    imageProcessing: {
      enabled: true,
      storeOriginal: false,
      maxDimension: 3200,
      quality: 0.90,
      previewMaxDimension: 960,
      previewQuality: 0.88,
      outputType: "image/webp"
    },
    backup: {
      format: "cosplay-archive-backup",
      version: 1
    },
    providers: {
      gdrive: {
        enabled: false,
        clientId: "",
        scope: "https://www.googleapis.com/auth/drive.file",
        rootFolderName: "Cosplay Archive",
        manifestName: "archive.json",
        photosFolderName: "photos",
        autoSync: true,
        autoSyncDelayMs: 4000
      }
    },
    multiAccount: {
      reserveFreeBytes: 250 * 1024 * 1024, // 250 МБ (200-300 МБ)
      strategy: "fill",                    // fill | roundrobin
      quotaCacheMs: 60000
    }
  };

  // Активный облачный провайдер (обновляется через refreshActiveProvider).
  let drive = null;
  const providers = window.CosplayProviders || null;
  const quotaCache = new Map(); // key: targetId -> {ts, quota}

  function refreshActiveProvider() {
    drive = providers?.getActive() || null;
  }

  const $ = (selector, root = document) =>
    root.querySelector(selector);

  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));

  const uid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const escapeHTML = (value = "") =>
    String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);

  const normalize = value =>
    String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("ru")
      .trim();

  const parseTags = value =>
    [...new Set(
      String(value || "")
        .split(/[,;\n]+/)
        .map(tag => tag.trim().replace(/^#/, ""))
        .filter(Boolean)
    )];

  const formatDate = value => {
    if (!value) return "Дата не указана";

    const date = new Date(`${value}T12:00:00`);

    if (Number.isNaN(date.getTime())) return "Дата не указана";

    return new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric"
    }).format(date);
  };

  const today = () => {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000)
      .toISOString()
      .slice(0, 10);
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const requestResult = request =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error || new Error("Ошибка базы данных")
      );
    });

  const transactionDone = transaction =>
    new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error || new Error("Ошибка транзакции")
      );
      transaction.onabort = () => reject(
        transaction.error || new Error("Транзакция отменена")
      );
    });

  class ArchiveDB {
    constructor() {
      this.db = null;
    }

    async open() {
      if (!("indexedDB" in window)) {
        throw new Error(
          "Этот браузер не поддерживает IndexedDB. Попробуйте другой браузер."
        );
      }

      const request = indexedDB.open(
        CONFIG.databaseName,
        CONFIG.databaseVersion
      );

      request.onupgradeneeded = () => {
        const db = request.result;
        const stores = CONFIG.stores;

        if (!db.objectStoreNames.contains(stores.models)) {
          const models = db.createObjectStore(stores.models, {
            keyPath: "id"
          });

          models.createIndex("name", "name", { unique: false });
        }

        if (!db.objectStoreNames.contains(stores.sets)) {
          const sets = db.createObjectStore(stores.sets, {
            keyPath: "id"
          });

          sets.createIndex("modelId", "modelId", {
            unique: false
          });

          sets.createIndex("date", "date", {
            unique: false
          });

          sets.createIndex("favorite", "favorite", {
            unique: false
          });
        }

        if (!db.objectStoreNames.contains(stores.photos)) {
          const photos = db.createObjectStore(stores.photos, {
            keyPath: "id"
          });

          photos.createIndex("setId", "setId", {
            unique: false
          });
        }
      };

      this.db = await requestResult(request);
      return this;
    }

    store(name, mode = "readonly") {
      if (!this.db) {
        throw new Error("База данных ещё не открыта");
      }

      return this.db
        .transaction(name, mode)
        .objectStore(name);
    }

    async getAll(name) {
      return requestResult(this.store(name).getAll());
    }

    async get(name, id) {
      return requestResult(this.store(name).get(id));
    }

    async put(name, record) {
      const tx = this.db.transaction(name, "readwrite");
      tx.objectStore(name).put(record);
      await transactionDone(tx);
      return record;
    }

    async delete(name, id) {
      const tx = this.db.transaction(name, "readwrite");
      tx.objectStore(name).delete(id);
      await transactionDone(tx);
    }

    async clear(name) {
      const tx = this.db.transaction(name, "readwrite");
      tx.objectStore(name).clear();
      await transactionDone(tx);
    }

    async clearAll() {
      const names = Object.values(CONFIG.stores);
      const tx = this.db.transaction(names, "readwrite");
      for (const name of names) {
        tx.objectStore(name).clear();
      }
      await transactionDone(tx);
    }

    async replaceAll(recordsByStore) {
      const names = Object.keys(recordsByStore);
      const tx = this.db.transaction(names, "readwrite");

      for (const name of names) {
        const store = tx.objectStore(name);
        store.clear();

        for (const record of recordsByStore[name]) {
          store.put(record);
        }
      }

      await transactionDone(tx);
    }

    async saveSetWithPhotos(setRecord, newPhotos, removedPhotoIds) {
      const tx = this.db.transaction(
        [CONFIG.stores.sets, CONFIG.stores.photos],
        "readwrite"
      );

      const setsStore = tx.objectStore(CONFIG.stores.sets);
      const photosStore = tx.objectStore(CONFIG.stores.photos);

      for (const id of removedPhotoIds) {
        photosStore.delete(id);
      }

      for (const photo of newPhotos) {
        photosStore.put(photo);
      }

      setsStore.put(setRecord);

      await transactionDone(tx);
    }

    async deleteSet(setRecord) {
      const tx = this.db.transaction(
        [CONFIG.stores.sets, CONFIG.stores.photos],
        "readwrite"
      );

      tx.objectStore(CONFIG.stores.sets).delete(setRecord.id);

      const photosStore = tx.objectStore(CONFIG.stores.photos);
      const request = photosStore.index("setId").openCursor(
        IDBKeyRange.only(setRecord.id)
      );

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      await transactionDone(tx);
    }

    async deleteModelAndSets(modelId, sets) {
      const tx = this.db.transaction(
        [
          CONFIG.stores.models,
          CONFIG.stores.sets,
          CONFIG.stores.photos
        ],
        "readwrite"
      );

      tx.objectStore(CONFIG.stores.models).delete(modelId);

      const setsStore = tx.objectStore(CONFIG.stores.sets);
      const photosStore = tx.objectStore(CONFIG.stores.photos);

      for (const set of sets) {
        setsStore.delete(set.id);

        const request = photosStore.index("setId").openCursor(
          IDBKeyRange.only(set.id)
        );

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      }

      await transactionDone(tx);
    }
  }

  const db = new ArchiveDB();

  const state = {
    models: [],
    sets: [],
    photos: [],
    page: "models",
    selectedModelId: null,
    viewedSetId: null,
    routeKey: "",
    reopeningLightbox: false,
    route: null,
    slugCache: null,
    activeTag: "",
    lightboxPhotos: [],
    lightboxIndex: 0,
    objectURLs: new Map(),
    draftNewPhotos: [],
    draftRemovedPhotoIds: new Set(),
    draftCoverPhotoId: null,
    draftModelCoverPhotoId: null,
    draftPhotoList: [],
    draftSelectedPhotoIds: new Set(),
    privacyActive: true,
    isLocked: true,
    hasPin: false,
    pinBuffer: "",
    pinSetupStep: 1,
    pinSetupFirst: null,
    pinMode: "unlock",
    autolockBlur: true,
    disguiseActive: true,
    disguisePreset: "docs",
    customTitle: "",
    massUploadPhotos: [],
    massUploadObjectURLs: new Map(),
    massUploadTargetSetId: null,
    busy: false,
    drive: {
      configured: false,
      signedIn: false,
      syncing: false,
      lastSyncAt: null,
      error: ""
    }
  };

  function showToast(message, type = "") {
    const toast = $("#toast");
    if (!toast) {
      console.log(`[Cosplay Archive] ${message}`);
      return;
    }

    toast.textContent = message;
    toast.className = "toast";

    if (type) toast.classList.add(type);

    toast.classList.remove("hidden");

    // Popover переводит уведомление в top-layer, чтобы оно было видно
    // поверх открытых модальных диалогов.
    if (typeof toast.showPopover === "function") {
      try {
        if (!toast.matches(":popover-open")) toast.showPopover();
      } catch {
        /* игнорируем, покажем обычным способом */
      }
    }

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.classList.add("hidden");
      if (typeof toast.hidePopover === "function") {
        try {
          if (toast.matches(":popover-open")) toast.hidePopover();
        } catch {}
      }
    }, 3500);
  }

  function setBusy(value, label = "") {
    state.busy = value;

    $$("button[type='submit']").forEach(button => {
      button.disabled = value;
    });

    document.body.classList.toggle("is-busy", value);

    if (value) {
      showProgress(label);
    } else {
      hideProgress();
    }
  }

  function showProgress(label = "") {
    const bar = $("#progressBar");
    if (!bar) return;

    if (label) bar.setAttribute("aria-label", label);

    clearTimeout(showProgress.timer);
    showProgress.timer = setTimeout(() => {
      bar.classList.remove("hidden");
      if (typeof bar.showPopover === "function") {
        try {
          if (!bar.matches(":popover-open")) bar.showPopover();
        } catch {}
      }
    }, 300);
  }

  function hideProgress() {
    clearTimeout(showProgress.timer);
    const bar = $("#progressBar");
    if (bar) {
      bar.classList.add("hidden");
      if (typeof bar.hidePopover === "function") {
        try {
          if (bar.matches(":popover-open")) bar.hidePopover();
        } catch {}
      }
    }
  }

  /* -------------------- Плавающий оверлей прогресса (HUD) и прогресс в диалогах -------------------- */

  let hudHideTimer = null;

  function getActiveUploadProgressPrefix() {
    const setDialog = $("#setDialog");
    if (setDialog && setDialog.open) return "set";
    const massDialog = $("#massUploadDialog");
    if (massDialog && massDialog.open) return "mass";
    return null;
  }

  function showHUD({ title = "Загрузка…", subtitle = "", percent = 0, current = null, total = null, icon = "⚡" } = {}) {
    clearTimeout(hudHideTimer);
    const hud = $("#progressHud");
    if (hud) {
      const titleEl = $("#progressHudTitle");
      const iconEl = $("#progressHudIcon");
      if (titleEl) titleEl.textContent = title;
      if (iconEl) iconEl.textContent = icon;

      hud.classList.remove("hidden");

      if (typeof hud.showPopover === "function") {
        try {
          if (!hud.matches(":popover-open")) hud.showPopover();
        } catch {
          /* игнорируем */
        }
      }
    }

    // Также обновляем инлайн-прогресс в активном модальном окне
    const prefix = getActiveUploadProgressPrefix();
    if (prefix) {
      const inlineBox = $(`#${prefix}UploadProgress`);
      if (inlineBox) {
        const inTitle = $(`#${prefix}UploadTitle`);
        const inIcon = $(`#${prefix}UploadIcon`);
        if (inTitle) inTitle.textContent = title;
        if (inIcon) inIcon.textContent = icon;
        inlineBox.classList.remove("hidden");
      }
    }

    updateHUD({ subtitle, percent, current, total });
  }

  function updateHUD({ subtitle = null, percent = null, current = null, total = null } = {}) {
    let pct = null;
    if (current != null && total != null && total > 0) {
      pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
    } else if (percent != null) {
      pct = Math.min(100, Math.max(0, Math.round(percent)));
    }

    // Обновление плавающего HUD
    const hud = $("#progressHud");
    if (hud && !hud.classList.contains("hidden")) {
      const fillEl = $("#progressHudFill");
      const pctEl = $("#progressHudPercent");
      const subEl = $("#progressHudSubtitle");

      if (pct != null) {
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (pctEl) pctEl.textContent = `${pct}%`;
      }

      if (subtitle != null && subEl) {
        subEl.textContent = subtitle;
      }
    }

    // Обновление инлайн-прогресса в открытом окне
    const prefix = getActiveUploadProgressPrefix();
    if (prefix) {
      const inlineBox = $(`#${prefix}UploadProgress`);
      if (inlineBox && !inlineBox.classList.contains("hidden")) {
        const inFill = $(`#${prefix}UploadFill`);
        const inPct = $(`#${prefix}UploadPercent`);
        const inSub = $(`#${prefix}UploadSubtitle`);

        if (pct != null) {
          if (inFill) inFill.style.width = `${pct}%`;
          if (inPct) inPct.textContent = `${pct}%`;
        }

        if (subtitle != null && inSub) {
          inSub.textContent = subtitle;
        }
      }
    }
  }

  function hideHUD(delay = 600) {
    clearTimeout(hudHideTimer);
    const doHide = () => {
      const hud = $("#progressHud");
      if (hud) {
        hud.classList.add("hidden");
        if (typeof hud.hidePopover === "function") {
          try {
            if (hud.matches(":popover-open")) hud.hidePopover();
          } catch {}
        }
      }

      $("#setUploadProgress")?.classList.add("hidden");
      $("#massUploadProgress")?.classList.add("hidden");
    };

    if (delay <= 0) {
      doHide();
    } else {
      hudHideTimer = setTimeout(doHide, delay);
    }
  }

  /* -------------------- Извлечение ZIP-архивов с поддержкой паролей -------------------- */

  function promptArchivePassword(archiveName, isRetry = false) {
    return new Promise(resolve => {
      const dialog = $("#archivePasswordDialog");
      const form = $("#archivePasswordForm");
      const input = $("#archivePasswordInput");
      const sub = $("#archivePasswordSub");
      const errorMsg = $("#archivePasswordError");
      const cancelBtn = $("#archivePasswordCancel");

      if (!dialog || !form || !input) {
        const fallback = prompt(
          `Введи пароль от архива «${archiveName}»:` +
            (isRetry ? "\n(Предыдущий пароль неверен!)" : "")
        );
        resolve(fallback);
        return;
      }

      if (sub) {
        sub.textContent = `Файл «${archiveName}» защищён паролем. Введи пароль для распаковки:`;
      }

      if (errorMsg) {
        errorMsg.classList.toggle("hidden", !isRetry);
      }

      input.value = "";
      let resolved = false;

      const cleanup = () => {
        form.removeEventListener("submit", onSubmit);
        cancelBtn?.removeEventListener("click", onCancel);
        dialog.removeEventListener("close", onClose);
      };

      const onSubmit = (e) => {
        e.preventDefault();
        const pwd = input.value;
        resolved = true;
        cleanup();
        closeDialog(dialog);
        resolve(pwd);
      };

      const onCancel = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          closeDialog(dialog);
          resolve(null);
        }
      };

      const onClose = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      };

      form.addEventListener("submit", onSubmit);
      cancelBtn?.addEventListener("click", onCancel);
      dialog.addEventListener("close", onClose, { once: true });

      openDialog(dialog);
      setTimeout(() => input.focus(), 60);
    });
  }

  async function extractZipImages(file) {
    if (!window.zip) {
      showToast("Модуль распаковки архивов ещё загружается…", "error");
      return [];
    }

    try {
      if (typeof window.zip.configure === "function") {
        window.zip.configure({ useWebWorkers: false });
      }
    } catch {}

    let reader;
    try {
      reader = new window.zip.ZipReader(new window.zip.BlobReader(file));
      const entries = await reader.getEntries();

      // Фильтруем файлы изображений, пропуская папки и служебный мусор
      const imageEntries = entries.filter(e => {
        if (e.directory) return false;
        const name = (e.filename || "").toLowerCase();
        if (name.includes("__macosx/") || name.includes("thumbs.db") || name.startsWith(".")) return false;
        return /\.(jpe?g|png|webp|gif|avif)$/i.test(name);
      });

      if (!imageEntries.length) {
        showToast(`В архиве «${file.name}» не найдено поддерживаемых фотографий.`, "error");
        await reader.close();
        return [];
      }

      const isEncrypted = imageEntries.some(e => e.encrypted);
      let password = "";

      if (isEncrypted) {
        password = await promptArchivePassword(file.name);
        if (password === null) {
          await reader.close();
          return [];
        }
      }

      showHUD({
        title: "Распаковка архива",
        subtitle: `Извлечение 0 из ${imageEntries.length}…`,
        current: 0,
        total: imageEntries.length,
        icon: "📦"
      });

      const extractedFiles = [];

      for (let i = 0; i < imageEntries.length; i++) {
        const entry = imageEntries[i];
        const baseName = entry.filename.split("/").pop() || `photo_${i + 1}.jpg`;
        const ext = baseName.split(".").pop().toLowerCase();
        const mime = ext === "png" ? "image/png"
          : ext === "webp" ? "image/webp"
          : ext === "gif" ? "image/gif"
          : ext === "avif" ? "image/avif"
          : "image/jpeg";

        let blob = null;
        let attempt = 0;

        while (attempt < 3) {
          try {
            blob = await entry.getData(
              new window.zip.BlobWriter(mime),
              { password: password || undefined }
            );
            break;
          } catch (err) {
            const msg = String(err?.message || "");
            if (msg.includes("password") || msg.includes("encrypted") || msg.includes("signature")) {
              password = await promptArchivePassword(file.name, true);
              if (password === null) {
                hideHUD(0);
                await reader.close();
                return extractedFiles;
              }
              attempt++;
            } else {
              console.warn("Ошибка извлечения фото из архива:", entry.filename, err);
              break;
            }
          }
        }

        if (blob) {
          const extractedFile = new File([blob], baseName, {
            type: mime,
            lastModified: Date.now()
          });
          extractedFiles.push(extractedFile);
        }

        updateHUD({
          subtitle: `Извлечено ${i + 1} из ${imageEntries.length} (${baseName})`,
          current: i + 1,
          total: imageEntries.length
        });
      }

      await reader.close();
      hideHUD(600);
      showToast(`Из архива извлечено фотографий: ${extractedFiles.length}`, "success");
      return extractedFiles;
    } catch (error) {
      console.error("Ошибка при распаковке архива:", error);
      showToast(`Не удалось прочитать архив «${file.name}»: ${error.message}`, "error");
      hideHUD(0);
      try { await reader?.close(); } catch {}
      return [];
    }
  }

  /* -------------------- Извлечение RAR-архивов с поддержкой паролей -------------------- */

  async function extractRarImages(file) {
    if (!window.unrar || typeof window.unrar.createExtractorFromData !== "function") {
      showToast("Модуль распаковки RAR ещё загружается…", "error");
      return [];
    }

    try {
      const arrayBuffer = await file.arrayBuffer();

      let password = "";
      let extractor = null;
      let headers = null;
      let passAttempts = 0;

      // Чтение оглавления архива (с поддержкой зашифрованных заголовков)
      while (passAttempts < 3) {
        try {
          extractor = await window.unrar.createExtractorFromData({
            data: arrayBuffer.slice(0),
            password: password || undefined
          });
          const list = extractor.getFileList();
          headers = [...list.fileHeaders];
          break;
        } catch (err) {
          const isPassErr = err?.reason === "ERAR_MISSING_PASSWORD"
            || err?.reason === "ERAR_BAD_PASSWORD"
            || /password/i.test(err?.message || "");

          if (isPassErr) {
            password = await promptArchivePassword(file.name, passAttempts > 0);
            if (password === null) {
              return [];
            }
            passAttempts++;
          } else {
            throw err;
          }
        }
      }

      if (!headers) {
        showToast(`Не удалось прочитать RAR-архив «${file.name}».`, "error");
        return [];
      }

      // Фильтруем файлы изображений, исключая папки и системный мусор
      const imageHeaders = headers.filter(h => {
        if (h.flags && h.flags.directory) return false;
        const norm = (h.name || "").replace(/\\/g, "/").toLowerCase();
        if (norm.includes("__macosx/") || norm.includes("thumbs.db") || norm.split("/").pop().startsWith(".")) return false;
        return /\.(jpe?g|png|webp|gif|avif)$/i.test(norm);
      });

      if (!imageHeaders.length) {
        showToast(`В архиве «${file.name}» не найдено поддерживаемых фотографий.`, "error");
        return [];
      }

      // Проверяем шифрование содержимого файлов
      const isEncrypted = imageHeaders.some(h => h.flags && h.flags.encrypted);
      if (isEncrypted && !password) {
        password = await promptArchivePassword(file.name, false);
        if (password === null) {
          return [];
        }
      }

      showHUD({
        title: "Распаковка RAR-архива",
        subtitle: `Извлечение 0 из ${imageHeaders.length}…`,
        current: 0,
        total: imageHeaders.length,
        icon: "📦"
      });

      const extractedFiles = [];
      const imageNames = imageHeaders.map(h => h.name);

      let extractAttempts = 0;
      while (extractAttempts < 3) {
        try {
          extractedFiles.length = 0;

          // Создаём отдельный чистый экземпляр для распаковки
          const runExtractor = await window.unrar.createExtractorFromData({
            data: arrayBuffer.slice(0),
            password: password || undefined
          });

          const extracted = runExtractor.extract({
            files: imageNames,
            password: password || undefined
          });

          let count = 0;
          for (const item of extracted.files) {
            if (!item || !item.fileHeader || item.fileHeader.flags?.directory) continue;
            const normPath = (item.fileHeader.name || "").replace(/\\/g, "/");
            const baseName = normPath.split("/").pop() || `photo_${count + 1}.jpg`;
            const ext = baseName.split(".").pop().toLowerCase();
            const mime = ext === "png" ? "image/png"
              : ext === "webp" ? "image/webp"
              : ext === "gif" ? "image/gif"
              : ext === "avif" ? "image/avif"
              : "image/jpeg";

            if (item.extraction && item.extraction.length > 0) {
              const blob = new Blob([item.extraction], { type: mime });
              const extractedFile = new File([blob], baseName, {
                type: mime,
                lastModified: Date.now()
              });
              extractedFiles.push(extractedFile);
            }

            count++;
            updateHUD({
              subtitle: `Извлечено ${count} из ${imageHeaders.length} (${baseName})`,
              current: count,
              total: imageHeaders.length
            });
          }

          break;
        } catch (err) {
          const isPassErr = err?.reason === "ERAR_MISSING_PASSWORD"
            || err?.reason === "ERAR_BAD_PASSWORD"
            || /password/i.test(err?.message || "");

          if (isPassErr) {
            password = await promptArchivePassword(file.name, true);
            if (password === null) {
              hideHUD(0);
              return extractedFiles;
            }
            extractAttempts++;
          } else {
            console.warn("Ошибка извлечения файлов из RAR:", err);
            throw err;
          }
        }
      }

      hideHUD(600);
      showToast(`Из RAR-архива извлечено фотографий: ${extractedFiles.length}`, "success");
      return extractedFiles;
    } catch (error) {
      console.error("Ошибка при распаковке RAR-архива:", error);
      showToast(`Не удалось прочитать RAR-архив «${file.name}»: ${error.message || error}`, "error");
      hideHUD(0);
      return [];
    }
  }

  async function processFilesOrArchives(fileList, targetDialog = "set") {
    const rawFiles = Array.from(fileList || []);
    if (!rawFiles.length) return [];

    const resultFiles = [];
    let detectedArchiveName = "";

    for (const file of rawFiles) {
      const isZip = file.name.toLowerCase().endsWith(".zip")
        || file.type === "application/zip"
        || file.type === "application/x-zip-compressed";
      const isRar = file.name.toLowerCase().endsWith(".rar")
        || file.type === "application/x-rar-compressed"
        || file.type === "application/vnd.rar"
        || file.type === "application/x-rar";
      const is7z = file.name.toLowerCase().endsWith(".7z")
        || file.type === "application/x-7z-compressed";

      if (is7z) {
        showToast(
          `Архив «${file.name}» (.7z): пересохрани его в .zip или .rar для прямой распаковки в браузере.`,
          "error"
        );
        continue;
      }

      if (isRar) {
        detectedArchiveName = file.name.replace(/\.rar$/i, "");
        const extracted = await extractRarImages(file);
        if (extracted && extracted.length) {
          resultFiles.push(...extracted);
        }
      } else if (isZip) {
        detectedArchiveName = file.name.replace(/\.zip$/i, "");
        const extracted = await extractZipImages(file);
        if (extracted && extracted.length) {
          resultFiles.push(...extracted);
        }
      } else if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name)) {
        resultFiles.push(file);
      } else {
        showToast(`Пропущен неподдерживаемый файл: ${file.name}`, "error");
      }
    }

    // Если создаём новый сет и поля персонажа/названия ещё пусты — автозаполняем из названия архива
    if (targetDialog === "set" && detectedArchiveName) {
      const charInput = $("#setCharacter");
      const titleInput = $("#setTitle");
      if (charInput && !charInput.value.trim() && titleInput && !titleInput.value.trim()) {
        charInput.value = detectedArchiveName.replace(/[_\-]+/g, " ").trim();
        const setSlugInput = $("#setSlug");
        if (setSlugInput && !setSlugInput.dataset.touched) {
          setSlugInput.value = slugify(charInput.value);
        }
      }
    }

    return resultFiles;
  }

  function closeCardMenus() {
    $$(".card-menu-wrap.is-open").forEach(wrap => {
      wrap.classList.remove("is-open");
      wrap
        .querySelector(".card-menu-toggle")
        ?.setAttribute("aria-expanded", "false");
    });
  }

  function openDialog(dialog) {
    if (!dialog) return;

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  function closeDialog(dialog) {
    if (!dialog) return;

    if (dialog.id === "setDialog") {
      $("#setUploadProgress")?.classList.add("hidden");
    }
    if (dialog.id === "massUploadDialog") {
      $("#massUploadProgress")?.classList.add("hidden");
    }

    if (dialog.id === "photoDialog") {
      window.removeEventListener("resize", handleLightboxWindowResize);
      window.removeEventListener("orientationchange", handleLightboxWindowResize);
      const image = $("#lightboxImage");
      if (image) {
        image.style.width = "";
        image.style.height = "";
      }
    }

    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  function requestCloseDialog(id) {
    if (
      id === "setDialog"
      && state.draftNewPhotos.length
      && !confirm(
        "Закрыть без сохранения? Выбранные фотографии не будут добавлены."
      )
    ) {
      return;
    }

    if (
      id === "massUploadDialog"
      && state.massUploadPhotos.length
      && !confirm(
        "Закрыть без загрузки? Выбранные фотографии не будут добавлены."
      )
    ) {
      return;
    }

    closeDialog(document.getElementById(id));
  }

  function getModel(id) {
    return state.models.find(model => model.id === id);
  }

  function getSet(id) {
    return state.sets.find(set => set.id === id);
  }

  /* -------------------- Адреса (slug) -------------------- */

  function slugify(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("ru")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]+/gu, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function slugMaps() {
    if (state.slugCache) return state.slugCache;

    const byDate = (a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      || String(a.id).localeCompare(String(b.id));

    const assign = (items, used, baseOf, fallback, out) => {
      for (const item of [...items].sort(byDate)) {
        if (item.slug) {
          out.set(item.id, item.slug);
          continue;
        }

        const base = slugify(baseOf(item)) || fallback;
        let candidate = base;
        let n = 1;

        while (used.has(candidate)) candidate = `${base}-${++n}`;

        used.add(candidate);
        out.set(item.id, candidate);
      }
    };

    const models = new Map();
    assign(
      state.models,
      new Set(state.models.map(model => model.slug).filter(Boolean)),
      model => model.name,
      "model",
      models
    );

    const sets = new Map();
    const groups = new Map();

    for (const set of state.sets) {
      if (!groups.has(set.modelId)) groups.set(set.modelId, []);
      groups.get(set.modelId).push(set);
    }

    for (const group of groups.values()) {
      assign(
        group,
        new Set(group.map(set => set.slug).filter(Boolean)),
        set => set.title || set.character,
        "set",
        sets
      );
    }

    state.slugCache = { models, sets };
    return state.slugCache;
  }

  function modelSlug(modelOrId) {
    const model = typeof modelOrId === "string"
      ? getModel(modelOrId)
      : modelOrId;

    return model ? slugMaps().models.get(model.id) || "" : "";
  }

  function setSlug(setOrId) {
    const set = typeof setOrId === "string" ? getSet(setOrId) : setOrId;
    return set ? slugMaps().sets.get(set.id) || "" : "";
  }

  function findModelByRef(ref) {
    if (!ref) return null;

    const lower = String(ref).toLocaleLowerCase("ru");

    return state.models.find(model => modelSlug(model) === lower)
      || state.models.find(model => model.id === ref)
      || null;
  }

  function findSetByRef(modelId, ref) {
    if (!ref) return null;

    const lower = String(ref).toLocaleLowerCase("ru");

    return state.sets.find(
      set => set.modelId === modelId && setSlug(set) === lower
    ) || state.sets.find(
      set => set.modelId === modelId && set.id === ref
    ) || null;
  }

  function getSetPhotos(set) {
    // Для ещё не сохранённого сета возвращаем только что выбранные фото,
    // чтобы превью и обложка работали при создании нового сета.
    if (!set) return [...state.draftNewPhotos];

    const removed = state.draftRemovedPhotoIds;

    const saved = (set.photoIds || [])
      .filter(id => !removed.has(id))
      .map(id => state.photos.find(photo => photo.id === id))
      .filter(Boolean);

    return [...saved, ...state.draftNewPhotos.filter(
      photo => photo.setId === set.id || !photo.setId
    )];
  }

  function getSavedPhoto(id) {
    return state.photos.find(photo => photo.id === id);
  }

  // Временный кэш потоковых URL оригиналов из облака (в оперативной памяти, не в IndexedDB)
  const streamCache = new Map();

  async function loadFullPhotoURL(photo) {
    if (!photo) return "";
    if (photo.blob instanceof Blob) {
      return photoURL(photo, "full");
    }
    if (streamCache.has(photo.id)) {
      return streamCache.get(photo.id);
    }
    if (photo.driveFileId && drive) {
      try {
        const blob = await drive.downloadFile(photo.driveFileId, photo.providerTargetId);
        if (blob) {
          const url = URL.createObjectURL(blob);
          streamCache.set(photo.id, url);
          // Кэшируем скачанный оригинал в IndexedDB для мгновенного последующего открытия
          photo.blob = blob;
          db.put(CONFIG.stores.photos, photo).catch(() => {});
          return url;
        }
      } catch (err) {
        console.warn("Не удалось подгрузить фото из облака:", photo.id, err);
      }
    }
    return photoURL(photo, "preview");
  }

  let isFetchingCovers = false;
  async function ensureHighResCovers() {
    if (isFetchingCovers || !isUserAuthenticated()) return;
    refreshActiveProvider();
    if (!drive || typeof drive.downloadFile !== "function") return;

    isFetchingCovers = true;
    try {
      const coverPhotoMap = new Map();

      for (const model of state.models) {
        const cover = getModelCover(model.id);
        if (cover && cover.id) coverPhotoMap.set(cover.id, cover);
      }

      for (const set of state.sets) {
        const cover = getCover(set);
        if (cover && cover.id) coverPhotoMap.set(cover.id, cover);
      }

      const missing = [];
      for (const [id, photo] of coverPhotoMap.entries()) {
        if (!(photo.blob instanceof Blob) && photo.driveFileId) {
          missing.push(photo);
        }
      }

      if (!missing.length) return;

      for (const photo of missing) {
        try {
          const blob = await drive.downloadFile(photo.driveFileId, photo.providerTargetId);
          if (blob) {
            photo.blob = blob;
            await db.put(CONFIG.stores.photos, photo);

            const hdUrl = photoURL(photo, "cover");
            const imgs = document.querySelectorAll(`img[data-cover-photo-id="${photo.id}"]`);
            imgs.forEach(img => {
              if (img.src !== hdUrl) {
                img.src = hdUrl;
              }
            });
          }
        } catch (err) {
          console.warn("Не удалось подгрузить HD обложку:", photo.id, err);
        }
        await new Promise(r => setTimeout(r, 60));
      }
    } finally {
      isFetchingCovers = false;
    }
  }

  function isUserAuthenticated() {
    refreshActiveProvider();
    if (!drive || !drive.isConfigured()) return false;
    if (typeof drive.hasToken === "function" && drive.hasToken()) return true;
    if (typeof drive.isConnected === "function" && drive.isConnected()) return true;
    return false;
  }

  function photoURL(photo, variant = "full") {
    if (!photo || !isUserAuthenticated()) return "";

    let blob = null;
    let isPreview = false;

    if (variant === "preview") {
      if (photo.preview instanceof Blob) {
        blob = photo.preview;
        isPreview = true;
      } else if (photo.blob instanceof Blob) {
        blob = photo.blob;
      }
    } else if (variant === "cover") {
      // Для обложек: отдаём приоритет оригинальному качеству photo.blob (Ultra-HD WebP)!
      // Если оригинала на устройстве нет (ещё не скачан из облака), отдаём preview.
      if (photo.blob instanceof Blob) {
        blob = photo.blob;
      } else if (photo.preview instanceof Blob) {
        blob = photo.preview;
        isPreview = true;
      }
    } else {
      // "full"
      if (photo.blob instanceof Blob) {
        blob = photo.blob;
      } else if (photo.preview instanceof Blob) {
        blob = photo.preview;
        isPreview = true;
      }
    }

    if (blob) {
      const key = isPreview ? `${photo.id}:preview` : `${photo.id}:full`;

      if (!state.objectURLs.has(key)) {
        state.objectURLs.set(key, URL.createObjectURL(blob));
      }

      return state.objectURLs.get(key);
    }

    if (typeof photo.dataURL === "string" && photo.dataURL) {
      return photo.dataURL;
    }

    if (typeof photo.previewDataURL === "string" && photo.previewDataURL) {
      return photo.previewDataURL;
    }

    return "";
  }

  function cleanupObjectURLs() {
    for (const url of state.objectURLs.values()) {
      URL.revokeObjectURL(url);
    }

    state.objectURLs.clear();

    for (const url of streamCache.values()) {
      URL.revokeObjectURL(url);
    }
    streamCache.clear();
  }

  async function refreshData() {
    const [models, sets, photos] = await Promise.all([
      db.getAll(CONFIG.stores.models),
      db.getAll(CONFIG.stores.sets),
      db.getAll(CONFIG.stores.photos)
    ]);

    state.models = models;
    state.sets = sets;
    state.photos = photos;
    state.slugCache = null;
  }

  function modelActivityDate(model) {
    if (!model) return "";
    let latest = model.updatedAt || model.createdAt || "";
    for (const set of state.sets) {
      if (set.modelId === model.id) {
        const setTime = set.updatedAt || set.createdAt || set.date || "";
        if (setTime > latest) {
          latest = setTime;
        }
      }
    }
    return latest;
  }

  async function touchModel(modelId) {
    if (!modelId) return;
    const model = getModel(modelId);
    if (!model) return;
    const now = new Date().toISOString();
    const updatedModel = {
      ...model,
      updatedAt: now
    };
    try {
      await db.put(CONFIG.stores.models, updatedModel);
      const idx = state.models.findIndex(m => m.id === modelId);
      if (idx !== -1) {
        state.models[idx] = updatedModel;
      }
    } catch (err) {
      console.warn("Не удалось обновить дату активности модели:", err);
    }
  }

  function sortModels(models, sort) {
    const result = [...models];

    if (sort === "oldest") {
      return result.sort((a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      );
    }

    if (sort === "updated") {
      return result.sort((a, b) =>
        String(modelActivityDate(b)).localeCompare(
          String(modelActivityDate(a))
        )
      );
    }

    if (sort === "sets") {
      return result.sort((a, b) =>
        countModelSets(b.id) - countModelSets(a.id)
      );
    }

    return result.sort((a, b) =>
      normalize(a.name).localeCompare(normalize(b.name), "ru")
    );
  }

  function sortSets(sets, sort) {
    const result = [...sets];

    switch (sort) {
      case "updated":
        return result.sort((a, b) =>
          String(b.updatedAt || b.createdAt || b.date || "").localeCompare(
            String(a.updatedAt || a.createdAt || a.date || "")
          )
        );

      case "oldest":
        return result.sort((a, b) =>
          String(a.date || a.createdAt || "").localeCompare(
            String(b.date || b.createdAt || "")
          )
        );

      case "rating":
        return result.sort((a, b) =>
          Number(b.rating || 0) - Number(a.rating || 0)
        );

      case "name":
        return result.sort((a, b) =>
          normalize(a.character).localeCompare(normalize(b.character), "ru")
        );

      case "photos":
        return result.sort(
          (a, b) =>
            (b.photoIds || []).length - (a.photoIds || []).length
        );

      case "random":
        return result.sort(() => Math.random() - 0.5);

      case "newest":
        return result.sort((a, b) =>
          String(b.date || b.createdAt || "").localeCompare(
            String(a.date || a.createdAt || "")
          )
        );

      default:
        return result.sort((a, b) =>
          String(b.updatedAt || b.createdAt || b.date || "").localeCompare(
            String(a.updatedAt || a.createdAt || a.date || "")
          )
        );
    }
  }

  function countModelSets(modelId) {
    return state.sets.filter(set => set.modelId === modelId).length;
  }

  function countPhotos(set) {
    return (set?.photoIds || []).filter(id => getSavedPhoto(id)).length;
  }

  function getCover(set) {
    if (!set) return null;

    const photos = getSetPhotos(set);

    return photos.find(photo => photo.id === set.coverPhotoId)
      || photos[0]
      || null;
  }

  function getModelCover(modelId) {
    const model = getModel(modelId);
    if (model?.coverPhotoId) {
      const explicitCover = getSavedPhoto(model.coverPhotoId);
      if (explicitCover) return explicitCover;
    }

    const sets = state.sets
      .filter(set => set.modelId === modelId)
      .sort((a, b) => String(b.date || b.createdAt || "").localeCompare(
        String(a.date || a.createdAt || "")
      ));

    for (const set of sets) {
      const cover = getCover(set);
      if (cover) return cover;
    }

    return null;
  }

  function getModelInitial(model) {
    return String(model?.name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  function renderTags(tags, className = "mini-tag") {
    if (!tags?.length) return "";

    return tags.map(tag => {
      const cleanTag = String(tag || "").trim().replace(/^#+/, "");
      if (!cleanTag) return "";
      const isActive = state.activeTag && state.activeTag.toLowerCase() === cleanTag.toLowerCase();
      return `<button type="button" class="${className} tag-chip-btn ${isActive ? "active" : ""}"
        data-action="filter-tag" data-tag="${escapeHTML(cleanTag)}"
        title="Показать только сеты с тегом #${escapeHTML(cleanTag)}">#${escapeHTML(cleanTag)}</button>`;
    }).join("");
  }

  function renderCardTags(tags, limit = 3) {
    if (!tags?.length) return "";

    const visible = tags.slice(0, limit);
    const remainder = tags.length - visible.length;

    return `
      <div class="card-tags">
        ${renderTags(visible)}
        ${remainder > 0
          ? `<span class="mini-tag" title="${tags.slice(limit).map(t => '#' + t).join(' ')}">+${remainder}</span>`
          : ""}
      </div>
    `;
  }

  function renderRatingStars(rating) {
    const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    let stars = "";

    for (let i = 1; i <= 5; i += 1) {
      stars += `<span class="star ${i <= value ? "on" : "off"}">★</span>`;
    }

    return `<span class="card-rating" role="img"
      aria-label="Рейтинг ${value} из 5">${stars}</span>`;
  }

  function renderCardMenu(id, kind) {
    const isModel = kind === "model";
    const set = isModel ? null : getSet(id);

    return `
      <div class="card-menu-wrap">
        <button class="icon-button card-menu-toggle" type="button"
          data-action="toggle-card-menu"
          aria-haspopup="menu" aria-expanded="false"
          aria-label="Действия">
          ⋯
        </button>
        <div class="card-menu" role="menu">
          <button class="card-menu-item" type="button" role="menuitem"
            data-action="${isModel ? "edit-model" : "edit-set"}"
            data-id="${escapeHTML(id)}">
            Изменить
          </button>
          ${isModel ? "" : `
            <button class="card-menu-item" type="button" role="menuitem"
              data-action="favorite-set" data-id="${escapeHTML(id)}">
              ${set?.favorite ? "Убрать из избранного" : "В избранное"}
            </button>`}
          <button class="card-menu-item is-danger" type="button" role="menuitem"
            data-action="${isModel ? "delete-model" : "delete-set"}"
            data-id="${escapeHTML(id)}">
            Удалить
          </button>
        </div>
      </div>
    `;
  }

  // Ссылки строятся по адресам (slug): #/model/nika и #/model/nika/tifa-lockhart.
  // Если записи нет в данных — откатываемся на id.
  function modelHref(id) {
    const model = getModel(id);
    return `#/model/${encodeURIComponent(model ? modelSlug(model) : id)}`;
  }

  function setHref(id) {
    const set = getSet(id);
    const model = set ? getModel(set.modelId) : null;

    if (set && model) {
      return `#/model/${encodeURIComponent(modelSlug(model))}`
        + `/${encodeURIComponent(setSlug(set))}`;
    }

    return `#/set/${encodeURIComponent(id)}`;
  }

  function renderModelCard(model) {
    const setsCount = countModelSets(model.id);
    const tags = model.tags || [];
    const cover = getModelCover(model.id);
    const coverURL = cover ? photoURL(cover, "cover") : "";

    return `
      <article class="archive-card model-card" data-model-id="${escapeHTML(model.id)}"
        data-action="open-model" data-id="${escapeHTML(model.id)}">
        <a class="card-cover" href="${modelHref(model.id)}"
          aria-label="Открыть модель ${escapeHTML(model.name)}">
          ${coverURL
            ? `<img src="${coverURL}" alt="${escapeHTML(model.name)}" loading="lazy" data-cover-photo-id="${cover?.id || ""}">`
            : `<div class="cover-placeholder">
                 ${escapeHTML(getModelInitial(model))}
               </div>`}
        </a>

        <div class="card-info">
          <h3 class="card-title">
            <a href="${modelHref(model.id)}">${escapeHTML(model.name)}</a>
          </h3>
          ${model.url
            ? `<p class="card-subtitle">
                 <a href="${escapeHTML(model.url)}" target="_blank"
                    rel="noopener noreferrer">Профиль модели ↗</a>
               </p>`
            : ""}
          ${renderCardTags(tags)}
          <div class="card-actions">
            <div class="card-meta">
              <span>${setsCount} ${pluralize(setsCount, "сет", "сета", "сетов")}</span>
            </div>
            ${renderCardMenu(model.id, "model")}
          </div>
        </div>
      </article>
    `;
  }

  function renderSetCard(set) {
    const model = getModel(set.modelId);
    const cover = getCover(set);
    const tags = set.tags || [];
    const rating = Number(set.rating || 0);
    const image = cover ? photoURL(cover, "cover") : "";
    const photoCount = getSetPhotos(set).length;

    return `
      <article class="archive-card set-card" data-set-id="${escapeHTML(set.id)}"
        data-action="view-set" data-id="${escapeHTML(set.id)}">
        <a class="card-cover" href="${setHref(set.id)}"
          aria-label="Открыть сет ${escapeHTML(set.character)}">
          ${image
            ? `<img src="${image}" alt="${escapeHTML(set.character)}" loading="lazy" data-cover-photo-id="${cover?.id || ""}">`
            : `<div class="cover-placeholder">✦</div>`}
          <span class="card-count">
            ${photoCount} ${pluralize(photoCount, "фото", "фото", "фото")}
          </span>
        </a>

        <button class="favorite-toggle ${set.favorite ? "is-favorite" : ""}"
          type="button" data-action="favorite-set"
          data-id="${escapeHTML(set.id)}"
          aria-label="${set.favorite ? "Убрать из избранного" : "Добавить в избранное"}"
          aria-pressed="${Boolean(set.favorite)}">
          ${set.favorite ? "♥" : "♡"}
        </button>

        <div class="card-info">
          <h3 class="card-title">
            <a href="${setHref(set.id)}">
              ${escapeHTML(set.title || set.character || "Без названия")}
            </a>
          </h3>
          <p class="card-subtitle">
            ${escapeHTML(set.character || "Персонаж не указан")}
          </p>
          ${model
            ? `<p class="card-subtitle">
                 <button class="text-button" type="button"
                   data-action="open-model" data-id="${escapeHTML(model.id)}">
                   ${escapeHTML(model.name)}
                 </button>
               </p>`
            : `<p class="card-subtitle">Модель не найдена</p>`}
          ${renderCardTags(tags)}
          <div class="card-actions">
            <div class="card-meta">
              <span>${escapeHTML(formatDate(set.date || set.createdAt?.slice(0, 10)))}</span>
              ${rating ? renderRatingStars(rating) : ""}
            </div>
            ${renderCardMenu(set.id, "set")}
          </div>
        </div>
      </article>
    `;
  }

  function pluralize(number, one, few, many) {
    const n = Math.abs(number) % 100;
    const last = n % 10;

    if (n > 10 && n < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;

    return many;
  }

  function renderEmpty(element, title, description, buttonText, action) {
    if (!element) return;

    element.innerHTML = `
      <div class="empty-icon">✦</div>
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(description)}</p>
      ${buttonText
        ? `<button class="button button-primary" type="button"
             data-action="${escapeHTML(action || "")}">
             ${escapeHTML(buttonText)}
           </button>`
        : ""}
    `;

    element.classList.remove("hidden");
  }

  function hideEmpty(element) {
    if (element) element.classList.add("hidden");
  }

  function renderModels() {
    const grid = $("#modelsGrid");
    const empty = $("#modelsEmpty");

    if (!grid) return;

    const query = normalize($("#modelSearch")?.value);
    const sort = $("#modelSort")?.value || "updated";

    let models = state.models.filter(model => {
      if (!query) return true;

      return [
        model.name,
        model.url,
        model.notes,
        ...(model.tags || [])
      ].some(value => normalize(value).includes(query));
    });

    models = sortModels(models, sort);

    grid.innerHTML = models.map(renderModelCard).join("");

    if (models.length === 0) {
      renderEmpty(
        empty,
        state.models.length ? "Ничего не найдено" : "Пока нет моделей",
        state.models.length
          ? "Попробуй изменить поисковый запрос."
          : "Добавь первую модель, чтобы начать собирать архив.",
        state.models.length ? "" : "Добавить модель",
        "add-model"
      );
    } else {
      hideEmpty(empty);
    }
    setTimeout(ensureHighResCovers, 100);
  }

  function renderModelFilter() {
    const select = $("#setModelFilter");
    if (!select) return;

    const current = select.value;

    select.innerHTML = `
      <option value="">Все модели</option>
      ${sortModels(state.models, "name").map(model => `
        <option value="${escapeHTML(model.id)}">
          ${escapeHTML(model.name)}
        </option>
      `).join("")}
    `;

    if (state.models.some(model => model.id === current)) {
      select.value = current;
    }
  }

  function allSetTags() {
    const tags = new Set();

    for (const set of state.sets) {
      for (const tag of set.tags || []) {
        const cleaned = String(tag || "").trim().replace(/^#+/, "").toLowerCase();
        if (cleaned) tags.add(cleaned);
      }
    }

    return [...tags].sort((a, b) =>
      normalize(a).localeCompare(normalize(b), "ru")
    );
  }

  function renderTagChips() {
    const container = $("#tagChips");
    if (!container) return;

    const tags = allSetTags();
    const activeClean = state.activeTag ? state.activeTag.trim().replace(/^#+/, "").toLowerCase() : "";

    if (!tags.length) {
      container.innerHTML = "";
      return;
    }

    const clearBtn = state.activeTag ? `
      <button class="tag-chip tag-clear-chip" type="button" data-action="clear-active-tag" title="Сбросить фильтр по тегу">
        ✕ Сбросить (#${escapeHTML(state.activeTag)})
      </button>
    ` : "";

    const chipsHtml = tags.map(tag => `
      <button class="tag-chip ${activeClean === tag ? "active" : ""}"
        type="button" data-action="filter-tag" data-tag="${escapeHTML(tag)}">
        #${escapeHTML(tag)}
      </button>
    `).join("");

    container.innerHTML = clearBtn + chipsHtml;
  }

  let updateModelTagSuggestions = null;
  let updateSetTagSuggestions = null;

  function setupTagSuggestions(inputId, wrapId, containerId) {
    const input = $(inputId);
    const wrap = $(wrapId);
    const container = $(containerId);
    if (!input || !container) return () => {};

    function update() {
      const allTags = allSetTags();
      if (!allTags.length) {
        if (wrap) wrap.hidden = true;
        container.innerHTML = "";
        return;
      }
      if (wrap) wrap.hidden = false;

      const currentTags = new Set(parseTags(input.value));
      const parts = input.value.split(/[,;\n]/);
      const query = (parts[parts.length - 1] || "").trim().toLowerCase().replace(/^#/, "");

      let tagsToShow = allTags;
      if (query && !currentTags.has(query)) {
        tagsToShow = [
          ...allTags.filter(t => t.toLowerCase().startsWith(query)),
          ...allTags.filter(t => !t.toLowerCase().startsWith(query) && t.toLowerCase().includes(query)),
          ...allTags.filter(t => !t.toLowerCase().includes(query))
        ];
      }

      container.innerHTML = tagsToShow.map(tag => {
        const isSelected = currentTags.has(tag);
        const icon = isSelected ? "✓" : "+";
        const tagEsc = escapeHTML(tag);
        return `<button type="button" class="tag-suggestion-chip${isSelected ? " is-selected" : ""}" data-tag="${tagEsc}" title="${isSelected ? "Убрать тег" : "Добавить тег"}">
          <span class="tag-suggestion-icon">${icon}</span> #${tagEsc}
        </button>`;
      }).join("");
    }

    container.addEventListener("click", event => {
      const btn = event.target.closest("[data-tag]");
      if (!btn) return;
      event.preventDefault();

      const tag = btn.dataset.tag;
      let tags = parseTags(input.value);
      const idx = tags.findIndex(t => t.toLowerCase() === tag.toLowerCase());

      if (idx >= 0) {
        tags.splice(idx, 1);
      } else {
        const parts = input.value.split(/[,;\n]/);
        const lastPart = (parts[parts.length - 1] || "").trim().toLowerCase().replace(/^#/, "");
        if (lastPart && tag.toLowerCase().startsWith(lastPart)) {
          const lastIdx = tags.findIndex(t => t.toLowerCase() === lastPart);
          if (lastIdx >= 0) {
            tags[lastIdx] = tag;
          } else {
            tags.push(tag);
          }
        } else {
          tags.push(tag);
        }
      }

      input.value = tags.join(", ");
      update();
      input.focus();
    });

    input.addEventListener("input", update);
    input.addEventListener("focus", update);

    return update;
  }

  function renderSets() {
    const grid = $("#setsGrid");
    const empty = $("#setsEmpty");

    if (!grid) return;

    const query = normalize($("#setSearch")?.value);
    const modelId = $("#setModelFilter")?.value || "";
    const sort = $("#setSort")?.value || "updated";
    const favoritesOnly = Boolean($("#favoritesOnly")?.checked);

    let sets = state.sets.filter(set => {
      const model = getModel(set.modelId);
      const setTags = (set.tags || []).map(t => String(t || "").trim().replace(/^#+/, "").toLowerCase());

      if (modelId && set.modelId !== modelId) return false;
      if (favoritesOnly && !set.favorite) return false;

      // Тег выбран: фильтруем ТОЛЬКО сеты, у которых этот тег действительно указан
      if (state.activeTag) {
        const activeClean = state.activeTag.trim().replace(/^#+/, "").toLowerCase();
        if (!setTags.includes(activeClean)) {
          return false;
        }
      }

      if (!query) return true;

      // Если в поиск введён тег с решёткой (например #tifa): ищем СТРОГО по тегам сета
      if (query.startsWith("#")) {
        const tagQuery = query.replace(/^#+/, "").trim().toLowerCase();
        return tagQuery ? setTags.some(t => t.includes(tagQuery)) : true;
      }

      return [
        set.character,
        set.title,
        set.description,
        model?.name,
        ...setTags
      ].some(value => normalize(value).includes(query));
    });

    sets = sortSets(sets, sort);

    grid.innerHTML = sets.map(renderSetCard).join("");

    if (sets.length === 0) {
      renderEmpty(
        empty,
        state.sets.length ? "Сеты не найдены" : "Пока нет сетов",
        state.sets.length
          ? "Измени запрос или фильтры."
          : "Создай первый сет у одной из моделей.",
        state.models.length && !state.sets.length
          ? "Добавить сет"
          : "",
        "add-set"
      );
    } else {
      hideEmpty(empty);
    }
    setTimeout(ensureHighResCovers, 100);
  }

  function renderModelDetail() {
    const model = getModel(state.selectedModelId);
    const header = $("#modelDetailHeader");
    const grid = $("#modelSetsGrid");
    const empty = $("#modelSetsEmpty");

    if (!model) {
      if (header) {
        header.innerHTML = renderNotFound(
          "Модель не найдена",
          "Возможно, она удалена или ещё не синхронизировалась на этом устройстве."
        );
      }
      if (grid) grid.innerHTML = "";
      hideEmpty(empty);
      return;
    }

    if (header) {
      const setsCount = countModelSets(model.id);
      const cover = getModelCover(model.id);
      const coverURL = cover ? photoURL(cover, "cover") : "";

      header.innerHTML = `
        <div class="model-detail-hero">
          <div class="model-avatar">${coverURL
            ? `<img src="${coverURL}" alt="${escapeHTML(model.name)}" data-cover-photo-id="${cover?.id || ""}">`
            : escapeHTML(getModelInitial(model))}</div>
          <div class="hero-content">
            <p class="eyebrow">Модель</p>
            <h1>${escapeHTML(model.name)}</h1>
            <p>${setsCount} ${pluralize(setsCount, "сет", "сета", "сетов")}</p>
            ${model.notes
              ? `<p>${escapeHTML(model.notes)}</p>`
              : ""}
            ${model.url
              ? `<p><a href="${escapeHTML(model.url)}"
                    target="_blank" rel="noopener noreferrer">
                    Открыть профиль ↗
                  </a></p>`
              : ""}
            ${renderCardTags(model.tags || [])}
          </div>
          <div class="hero-actions">
            <button class="button button-primary" type="button"
              data-action="add-set-model" data-id="${escapeHTML(model.id)}">
              + Добавить сет
            </button>
            <button class="button" type="button"
              data-action="edit-model" data-id="${escapeHTML(model.id)}">
              Изменить модель
            </button>
            <button class="button button-quiet" type="button"
              data-action="delete-model" data-id="${escapeHTML(model.id)}">
              Удалить
            </button>
          </div>
        </div>
      `;
    }

    if (!grid) return;

    const sets = sortSets(
      state.sets.filter(set => set.modelId === model.id),
      $("#setSort")?.value || "updated"
    );

    grid.innerHTML = sets.map(renderSetCard).join("");

    if (sets.length === 0) {
      renderEmpty(
        empty,
        "У этой модели пока нет сетов",
        "Добавь сет с персонажем и фотографиями.",
        "Добавить сет",
        "add-set-model"
      );
    } else {
      hideEmpty(empty);
    }
    setTimeout(ensureHighResCovers, 100);
  }

  async function renderStats() {
    const element = $("#footerStats");
    if (!element) return;

    const favorites = state.sets.filter(set => set.favorite).length;
    const photosCount = state.photos.length;

    let text =
      `${state.models.length} ${pluralize(state.models.length, "модель", "модели", "моделей")} · ` +
      `${state.sets.length} ${pluralize(state.sets.length, "сет", "сета", "сетов")} · ` +
      `${photosCount} ${pluralize(photosCount, "фотография", "фотографии", "фотографий")} · ` +
      `${favorites} в избранном`;

    if (navigator.storage && typeof navigator.storage.estimate === "function") {
      try {
        const est = await navigator.storage.estimate();
        if (est.usage) {
          const sizeText = est.usage > 1024 * 1024 * 1024
            ? `${(est.usage / (1024 * 1024 * 1024)).toFixed(2)} ГБ`
            : `${(est.usage / (1024 * 1024)).toFixed(0)} МБ`;
          text += ` · ${sizeText} в памяти`;
        }
      } catch {}
    }

    element.textContent = text;
  }

  function renderAll() {
    renderModels();
    renderModelFilter();
    renderTagChips();
    renderSets();

    // Ссылка могла быть открыта раньше, чем подтянулись данные (Google Drive).
    if (
      state.route
      && (
        (state.page === "model-detail" && !state.selectedModelId)
        || (state.page === "set-detail" && !state.viewedSetId)
      )
    ) {
      const { modelId, setId } = resolveRoute(state.route);

      if (state.page === "model-detail") state.selectedModelId = modelId;
      if (state.page === "set-detail") {
        state.viewedSetId = setId;
        state.selectedModelId = modelId;
      }
    }

    if (state.page === "model-detail") {
      renderModelDetail();
    } else if (state.page === "set-detail") {
      renderSetDetail();
    }

    syncHash();
    renderStats();
    updateNavigation();
    updateDocumentTitle();
    updateModelTagSuggestions?.();
    updateSetTagSuggestions?.();
  }

  /* -------------------- Безопасность, PIN-код и Камуфляж -------------------- */

  const DISGUISE_PRESETS = {
    docs: {
      title: "Документы — Google Диск",
      shortTitle: "Документы",
      brandMark: "📄",
      brandName: `Документы <strong>Диск</strong>`,
      navModels: "Разделы",
      navSets: "Все файлы",
      lockTitle: "Google Документы",
      lockSub: "Личное защищённое хранилище документов",
      pinPrompt: "Введите PIN-код для доступа к документам",
      faviconSvg: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><path fill='%232196F3' d='M37 45H11c-2.2 0-4-1.8-4-4V7c0-2.2 1.8-4 4-4h18l12 12v26c0 2.2-1.8 4-4 4z'/><path fill='%23BBDEFB' d='M29 3v12h12'/><path fill='%23fff' d='M15 23h18v2.5H15zm0 6h18v2.5H15zm0 6h12v2.5H15z'/></svg>`
    },
    notes: {
      title: "Личные заметки",
      shortTitle: "Заметки",
      brandMark: "📝",
      brandName: `Личные <strong>Заметки</strong>`,
      navModels: "Категории",
      navSets: "Все записи",
      lockTitle: "Личные заметки",
      lockSub: "Защищённый блокнот",
      pinPrompt: "Введите PIN-код для доступа к заметкам",
      faviconSvg: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' rx='10' fill='%23f9ab00'/><path fill='%23fff' d='M14 14h20v4H14zm0 8h20v4H14zm0 8h14v4H14z'/></svg>`
    },
    workspace: {
      title: "Cloud Workspace",
      shortTitle: "Workspace",
      brandMark: "💼",
      brandName: `Cloud <strong>Workspace</strong>`,
      navModels: "Проекты",
      navSets: "Материалы",
      lockTitle: "Cloud Workspace",
      lockSub: "Корпоративное рабочее пространство",
      pinPrompt: "Введите PIN-код для входа в рабочую область",
      faviconSvg: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' rx='10' fill='%235c6bc0'/><path fill='%23fff' d='M12 18h24v20H12zm6-8h12v4H18z'/></svg>`
    },
    custom: {
      title: "Мои документы",
      shortTitle: "Документы",
      brandMark: "📁",
      brandName: `Личные <strong>Файлы</strong>`,
      navModels: "Разделы",
      navSets: "Все файлы",
      lockTitle: "Личный архив",
      lockSub: "Защищённый доступ к файлам",
      pinPrompt: "Введите PIN-код для входа",
      faviconSvg: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><path fill='%231976D2' d='M10 8h12l4 4h12c2.2 0 4 1.8 4 4v20c0 2.2-1.8 4-4 4H10c-2.2 0-4-1.8-4-4V12c0-2.2 1.8-4 4-4z'/></svg>`
    }
  };

  const ORIGINAL_IDENTITY = {
    title: "Cosplay Archive",
    brandMark: "CA",
    brandName: `Cosplay <strong>Archive</strong>`,
    navModels: "Модели",
    navSets: "Все сеты",
    faviconHref: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23b69aff'/%3E%3Ctext x='32' y='43' font-size='30' font-family='Arial' font-weight='bold' text-anchor='middle' fill='%2317131f'%3ECA%3C/text%3E%3C/svg%3E"
  };

  async function hashPin(pin, salt = "") {
    try {
      if (crypto?.subtle?.digest) {
        const enc = new TextEncoder();
        const data = enc.encode(`${salt}:${pin}:ca_v30`);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
      }
    } catch {}
    let h = 0x811c9dc5;
    const str = `${salt}:${pin}:ca_fallback`;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  function initSecurityState() {
    state.hasPin = Boolean(localStorage.getItem("ca_pin_hash"));
    state.autolockBlur = localStorage.getItem("ca_autolock_blur") !== "false";
    state.disguiseActive = localStorage.getItem("ca_disguise_mode") !== "false";
    state.disguisePreset = localStorage.getItem("ca_disguise_preset") || "docs";
    state.customTitle = localStorage.getItem("ca_custom_title") || "";

    state.pinMode = state.hasPin ? "unlock" : "setup";
    state.pinBuffer = "";
    state.pinSetupStep = 1;
    state.pinSetupFirst = null;

    applyCamouflage();
    lockApp();
  }

  function applyCamouflage() {
    const isDisguised = state.disguiseActive;
    const presetKey = state.disguisePreset || "docs";
    const preset = DISGUISE_PRESETS[presetKey] || DISGUISE_PRESETS.docs;

    const brandMarkEl = $("#brandHome .brand-mark");
    const brandNameEl = $("#brandHome .brand-name");
    const brandHomeEl = $("#brandHome");
    const navModelsEl = document.querySelector('[data-page="models"]');
    const navSetsEl = document.querySelector('[data-page="sets"]');
    const faviconEl = document.querySelector('link[rel="icon"]') || document.querySelector('link[rel*="icon"]');

    if (isDisguised) {
      const finalTitle = (presetKey === "custom" && state.customTitle.trim())
        ? state.customTitle.trim()
        : preset.title;

      document.title = finalTitle;

      if (faviconEl) {
        faviconEl.href = `data:image/svg+xml,${encodeURIComponent(preset.faviconSvg)}`;
      }

      if (brandMarkEl) brandMarkEl.textContent = preset.brandMark;
      if (brandNameEl) brandNameEl.innerHTML = preset.brandName;
      if (brandHomeEl) brandHomeEl.setAttribute("aria-label", preset.shortTitle);

      if (navModelsEl) navModelsEl.textContent = preset.navModels;
      if (navSetsEl) navSetsEl.textContent = preset.navSets;

      const gateHead = $("#authGate h2");
      const gateDesc = $("#authGate p");
      if (gateHead) gateHead.textContent = "Хранилище заблокировано";
      if (gateDesc) gateDesc.textContent = "Подключите Google Диск для доступа к вашим файлам и папкам.";
    } else {
      document.title = ORIGINAL_IDENTITY.title;

      if (faviconEl) {
        faviconEl.href = ORIGINAL_IDENTITY.faviconHref;
      }

      if (brandMarkEl) brandMarkEl.textContent = ORIGINAL_IDENTITY.brandMark;
      if (brandNameEl) brandNameEl.innerHTML = ORIGINAL_IDENTITY.brandName;
      if (brandHomeEl) brandHomeEl.setAttribute("aria-label", "Cosplay Archive");

      if (navModelsEl) navModelsEl.textContent = ORIGINAL_IDENTITY.navModels;
      if (navSetsEl) navSetsEl.textContent = ORIGINAL_IDENTITY.navSets;

      const gateHead = $("#authGate h2");
      const gateDesc = $("#authGate p");
      if (gateHead) gateHead.textContent = "Архив заблокирован";
      if (gateDesc) gateDesc.textContent = "Фотографии скрыты. Подключите Google Диск, чтобы получить доступ к вашим фотосетам и моделям.";
    }
  }

  function renderPinDots() {
    const dots = document.querySelectorAll("#pinDots .pin-dot");
    const len = state.pinBuffer.length;
    dots.forEach((dot, idx) => {
      dot.classList.toggle("is-filled", idx < len);
      dot.classList.remove("is-error", "is-success");
    });
  }

  function updatePinScreenUI() {
    const titleEl = $("#pinLockTitle");
    const subEl = $("#pinLockSubtitle");
    const iconEl = $("#pinLockIcon");
    const setupLaterBtn = $("#pinSetupLaterBtn");
    const forgotBtn = $("#pinForgotBtn");
    const errorEl = $("#pinErrorMsg");
    if (errorEl) errorEl.classList.add("hidden");

    const preset = DISGUISE_PRESETS[state.disguisePreset || "docs"] || DISGUISE_PRESETS.docs;

    if (state.pinMode === "setup") {
      if (iconEl) iconEl.textContent = "🔐";
      if (titleEl) titleEl.textContent = state.disguiseActive ? "Защита хранилища" : "Установка PIN-кода";
      if (subEl) {
        subEl.textContent = state.pinSetupStep === 1
          ? "Шаг 1 из 2: придумайте 4-значный PIN-код"
          : "Шаг 2 из 2: повторите PIN-код для подтверждения";
        subEl.classList.toggle("is-highlight", state.pinSetupStep === 2);
      }
      if (setupLaterBtn) setupLaterBtn.classList.remove("hidden");
      if (forgotBtn) forgotBtn.classList.add("hidden");
    } else {
      if (iconEl) iconEl.textContent = state.disguiseActive ? (preset.brandMark || "🔒") : "🔒";
      if (titleEl) titleEl.textContent = state.disguiseActive ? (preset.lockTitle || "Документы — Защищённый доступ") : "Вход в архив";
      if (subEl) {
        subEl.textContent = state.disguiseActive ? (preset.pinPrompt || "Введите PIN-код для доступа") : "Введите 4-значный PIN-код для входа";
        subEl.classList.remove("is-highlight");
      }
      if (setupLaterBtn) setupLaterBtn.classList.add("hidden");
      if (forgotBtn) forgotBtn.classList.remove("hidden");
    }
  }

  function showPinError(msg = "Неверный PIN-код") {
    const dotsWrap = $("#pinDots");
    const errorEl = $("#pinErrorMsg");
    const dots = document.querySelectorAll("#pinDots .pin-dot");

    dots.forEach(d => d.classList.add("is-error"));
    if (dotsWrap) {
      dotsWrap.classList.remove("shake");
      void dotsWrap.offsetWidth;
      dotsWrap.classList.add("shake");
    }
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.classList.remove("hidden");
    }

    setTimeout(() => {
      state.pinBuffer = "";
      renderPinDots();
      if (dotsWrap) dotsWrap.classList.remove("shake");
      if (errorEl) errorEl.classList.add("hidden");
    }, 450);
  }

  function showPinSuccess() {
    const dots = document.querySelectorAll("#pinDots .pin-dot");
    dots.forEach(d => d.classList.add("is-success"));
  }

  async function handlePinInput(digit) {
    if (state.pinBuffer.length >= 4) return;
    state.pinBuffer += String(digit);
    renderPinDots();

    if (state.pinBuffer.length === 4) {
      if (state.pinMode === "unlock") {
        await processUnlockAttempt();
      } else if (state.pinMode === "setup") {
        await processSetupStep();
      }
    }
  }

  function handlePinBackspace() {
    if (state.pinBuffer.length > 0) {
      state.pinBuffer = state.pinBuffer.slice(0, -1);
      renderPinDots();
    }
  }

  function handlePinClear() {
    state.pinBuffer = "";
    renderPinDots();
  }

  async function processUnlockAttempt() {
    const savedHash = localStorage.getItem("ca_pin_hash");
    const savedSalt = localStorage.getItem("ca_pin_salt") || "";
    const inputHash = await hashPin(state.pinBuffer, savedSalt);

    if (inputHash === savedHash) {
      showPinSuccess();
      setTimeout(() => {
        unlockApp();
      }, 240);
    } else {
      showPinError("Неверный PIN-код");
    }
  }

  async function processSetupStep() {
    if (state.pinSetupStep === 1) {
      state.pinSetupFirst = state.pinBuffer;
      state.pinBuffer = "";
      state.pinSetupStep = 2;
      renderPinDots();
      updatePinScreenUI();
    } else if (state.pinSetupStep === 2) {
      if (state.pinBuffer === state.pinSetupFirst) {
        const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const hash = await hashPin(state.pinBuffer, salt);
        localStorage.setItem("ca_pin_hash", hash);
        localStorage.setItem("ca_pin_salt", salt);
        state.hasPin = true;
        state.pinMode = "unlock";

        showPinSuccess();
        showToast("PIN-код успешно установлен! 🔒", "success");
        setTimeout(() => {
          unlockApp();
        }, 280);
      } else {
        showPinError("PIN-коды не совпали. Попробуйте снова.");
        setTimeout(() => {
          state.pinSetupStep = 1;
          state.pinSetupFirst = null;
          state.pinBuffer = "";
          renderPinDots();
          updatePinScreenUI();
        }, 700);
      }
    }
  }

  function lockApp() {
    state.isLocked = true;
    state.privacyActive = true;
    document.body.classList.add("privacy-active");
    state.pinBuffer = "";
    state.pinMode = state.hasPin ? "unlock" : "setup";
    state.pinSetupStep = 1;
    state.pinSetupFirst = null;
    updatePinScreenUI();
    renderPinDots();
    applyCamouflage();
  }

  function unlockApp() {
    state.isLocked = false;
    state.privacyActive = false;
    document.body.classList.remove("privacy-active");
    state.pinBuffer = "";
    renderPinDots();
  }

  function setPrivacy(active) {
    if (active) {
      lockApp();
    } else {
      unlockApp();
    }
  }

  function togglePrivacy() {
    if (state.privacyActive) {
      if (state.hasPin) {
        showToast("Для разблокировки введите PIN-код.", "info");
      } else {
        unlockApp();
      }
    } else {
      lockApp();
    }
  }

  function resetPin() {
    if (confirm("Сбросить PIN-код? Это снимет защиту на этом устройстве. Ваши фото в облаке останутся в полной безопасности.")) {
      localStorage.removeItem("ca_pin_hash");
      localStorage.removeItem("ca_pin_salt");
      state.hasPin = false;
      state.pinMode = "setup";
      state.pinSetupStep = 1;
      state.pinSetupFirst = null;
      state.pinBuffer = "";
      renderPinDots();
      updatePinScreenUI();
      showToast("PIN-код сброшен.", "info");
    }
  }

  function openSecuritySettings() {
    const dialog = $("#securitySettingsDialog");
    if (!dialog) return;

    updateSecuritySettingsUI();
    openDialog(dialog);
  }

  function updateSecuritySettingsUI() {
    const badge = $("#settingsPinStatusBadge");
    const setBtn = $("#settingsSetPinBtn");
    const removeBtn = $("#settingsRemovePinBtn");
    const autolockChk = $("#settingsAutolockBlur");
    const disguiseToggle = $("#settingsDisguiseToggle");
    const presetSelect = $("#settingsDisguisePreset");
    const customWrap = $("#settingsCustomTitleWrap");
    const customInput = $("#settingsCustomTitle");

    if (badge) {
      if (state.hasPin) {
        badge.textContent = "Установлен (4 цифры)";
        badge.className = "pin-status-badge is-set";
        if (setBtn) setBtn.textContent = "Сменить PIN-код";
        if (removeBtn) removeBtn.classList.remove("hidden");
      } else {
        badge.textContent = "Не установлен";
        badge.className = "pin-status-badge is-unset";
        if (setBtn) setBtn.textContent = "Задать PIN-код";
        if (removeBtn) removeBtn.classList.add("hidden");
      }
    }

    if (autolockChk) autolockChk.checked = state.autolockBlur;
    if (disguiseToggle) disguiseToggle.checked = state.disguiseActive;
    if (presetSelect) presetSelect.value = state.disguisePreset || "docs";
    if (customWrap) customWrap.classList.toggle("hidden", state.disguisePreset !== "custom");
    if (customInput) customInput.value = state.customTitle || "";
  }

  function updateNavigation() {
    const auth = isUserAuthenticated();
    const gate = $("#authGate");
    if (gate) {
      gate.classList.toggle("hidden", auth);
    }

    // Скрываем навигацию и кнопки добавления, пока пользователь не вошёл в аккаунт
    const addBtn = $("#addMainBtn");
    const randBtn = $("#randomSetBtn");
    const lockBtn = $("#lockNowBtn");
    const secBtn = $("#securitySettingsBtn");
    const privBtn = $("#privacyToggleBtn");
    const mainNav = $(".main-nav");
    if (addBtn) addBtn.style.display = auth ? "" : "none";
    if (randBtn) randBtn.style.display = auth ? "" : "none";
    if (lockBtn) lockBtn.style.display = auth ? "" : "none";
    if (secBtn) secBtn.style.display = "";
    if (privBtn) privBtn.style.display = auth ? "" : "none";
    if (mainNav) mainNav.style.display = auth ? "" : "none";

    $$("[data-page]").forEach(button => {
      const active = button.dataset.page === state.page
        || (
          button.dataset.page === "models"
          && state.page === "model-detail"
        );

      button.classList.toggle("active", active);

      if (active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });

    $$(".page").forEach(page => page.classList.add("hidden"));

    if (auth) {
      $(`#page-${state.page}`)?.classList.remove("hidden");
    }
  }

  /* -------------------- Маршруты (адреса страниц) --------------------
     #/                 — модели
     #/sets             — все сеты
     #/model/<id>       — страница модели
     #/set/<id>         — страница сета
  ------------------------------------------------------------------- */

  function routeHash(page, id) {
    if (page === "sets") return "#/sets";
    if (page === "model-detail" && id) return modelHref(id);
    if (page === "set-detail" && id) return setHref(id);
    return "#/";
  }

  function parseRoute() {
    const parts = location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .map(part => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });

    const [name, first = "", second = ""] = parts;

    if (name === "sets") return { page: "sets" };
    if (name === "model" && first && second) {
      return { page: "set-detail", mref: first, sref: second };
    }
    if (name === "model" && first) {
      return { page: "model-detail", mref: first };
    }
    if (name === "set" && first) {
      return { page: "set-detail", legacyId: first };
    }

    return { page: "models" };
  }

  function resolveRoute(route) {
    let modelId = null;
    let setId = null;

    if (route.page === "model-detail") {
      modelId = findModelByRef(route.mref)?.id || null;
    } else if (route.page === "set-detail") {
      if (route.legacyId) {
        const set = getSet(route.legacyId);
        setId = set?.id || null;
        modelId = set?.modelId || null;
      } else {
        const model = findModelByRef(route.mref);
        modelId = model?.id || null;
        setId = model ? findSetByRef(model.id, route.sref)?.id || null : null;
      }
    }

    return { modelId, setId };
  }

  // Приводит адрес в строке браузера к актуальному виду
  // (старые ссылки с id и переименованные адреса).
  function syncHash() {
    let target = null;

    if (state.page === "model-detail" && getModel(state.selectedModelId)) {
      target = modelHref(state.selectedModelId);
    } else if (state.page === "set-detail" && getSet(state.viewedSetId)) {
      target = setHref(state.viewedSetId);
    }

    if (!target) return;

    const decode = value => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };

    if (decode(location.hash) !== decode(target)) {
      history.replaceState(
        null,
        "",
        location.pathname + location.search + target
      );
    }

    state.route = parseRoute();
  }

  function applyRoute(force = false) {
    const route = parseRoute();
    const { modelId, setId } = resolveRoute(route);

    const key = [
      route.page,
      modelId || route.mref || route.legacyId || "",
      setId || route.sref || ""
    ].join(":");

    state.route = route;

    if (!force && key === state.routeKey) {
      syncHash();
      return;
    }

    state.routeKey = key;

    // Открытая полноэкранная галерея не должна «переезжать» на другую страницу.
    closeDialog($("#photoDialog"));

    state.page = route.page;
    state.selectedModelId = null;
    state.viewedSetId = null;

    if (route.page === "model-detail") {
      state.selectedModelId = modelId;
    } else if (route.page === "set-detail") {
      state.viewedSetId = setId;
      state.selectedModelId = modelId;
    }

    updateNavigation();

    if (route.page === "model-detail") renderModelDetail();
    if (route.page === "set-detail") renderSetDetail();

    syncHash();
    updateDocumentTitle();
    window.scrollTo({ top: 0 });
  }

  function navigate(page, id) {
    const hash = routeHash(page, id);

    if (location.hash !== hash) {
      location.hash = hash;
    }

    applyRoute();
  }

  function updateDocumentTitle() {
    if (state.disguiseActive) {
      const presetKey = state.disguisePreset || "docs";
      const preset = DISGUISE_PRESETS[presetKey] || DISGUISE_PRESETS.docs;
      document.title = (presetKey === "custom" && state.customTitle.trim())
        ? state.customTitle.trim()
        : preset.title;
      return;
    }

    const base = CONFIG.appName || "Cosplay Archive";
    let title = base;

    if (state.page === "sets") {
      title = `Все сеты — ${base}`;
    } else if (state.page === "model-detail") {
      const model = getModel(state.selectedModelId);
      title = model ? `${model.name} — ${base}` : `Модель не найдена — ${base}`;
    } else if (state.page === "set-detail") {
      const set = getSet(state.viewedSetId);
      const model = set ? getModel(set.modelId) : null;

      title = set
        ? `${set.title || set.character || "Сет"}${model ? ` · ${model.name}` : ""} — ${base}`
        : `Сет не найден — ${base}`;
    }

    document.title = title;
  }

  function renderNotFound(title, text) {
    return `
      <div class="empty-state not-found">
        <div class="empty-icon" aria-hidden="true">✦</div>
        <h2>${escapeHTML(title)}</h2>
        <p>${escapeHTML(text)}</p>
        <a class="button button-primary" href="#/">К моделям</a>
      </div>
    `;
  }

  /* -------------------- Модели -------------------- */

  function updateSlugHints() {
    const base = `${location.origin}${location.pathname}#/`;

    const modelHint = $("#modelSlugHint");
    if (modelHint) {
      const value = slugify($("#modelSlug")?.value);
      modelHint.textContent = value
        ? `Ссылка: ${base}model/${value}`
        : "Короткое имя для ссылки. Если оставить пустым — возьмётся из ника.";
    }

    const setHint = $("#setSlugHint");
    if (setHint) {
      const value = slugify($("#setSlug")?.value);
      const model = getModel($("#setModelId")?.value);
      const modelPart = model ? modelSlug(model) : "модель";

      setHint.textContent = value
        ? `Ссылка: ${base}model/${modelPart}/${value}`
        : "Короткое имя для ссылки. Если оставить пустым — возьмётся из названия.";
    }
  }

  function updateModelCoverUI(model = null) {
    const previewEl = $("#modelCoverPreview");
    const statusEl = $("#modelCoverStatus");
    if (!previewEl || !statusEl) return;

    const draftPhotoId = state.draftModelCoverPhotoId;
    if (draftPhotoId) {
      const photo = getSavedPhoto(draftPhotoId);
      if (photo) {
        previewEl.innerHTML = `<img src="${photoURL(photo, "cover")}" alt="Обложка">`;
        statusEl.textContent = "Обложка выбрана вручную";
        return;
      }
    }

    const autoCover = model ? getModelCover(model.id) : null;
    if (autoCover) {
      previewEl.innerHTML = `<img src="${photoURL(autoCover, "cover")}" alt="Обложка">`;
      statusEl.textContent = "Автоматически из сета модели";
    } else {
      const name = $("#modelName")?.value || model?.name || "?";
      previewEl.innerHTML = `<span>${escapeHTML(name.trim().charAt(0).toUpperCase() || "?")}</span>`;
      statusEl.textContent = "Обложка пока не выбрана";
    }
  }

  function renderModelSetGallery(model) {
    const galleryEl = $("#modelCoverSetGallery");
    if (!galleryEl) return;

    if (!model) {
      galleryEl.innerHTML = '<p class="muted small" style="padding: 8px;">Сначала сохрани модель и добавь сеты с фото.</p>';
      return;
    }

    const modelSets = state.sets.filter(s => s.modelId === model.id);
    const photos = modelSets.flatMap(s => getSetPhotos(s));

    if (!photos.length) {
      galleryEl.innerHTML = '<p class="muted small" style="padding: 8px;">В сетах этой модели пока нет фото. Загрузи файл кнопкой «📁 Загрузить файл».</p>';
      return;
    }

    galleryEl.innerHTML = photos.map(p => {
      const isSelected = p.id === state.draftModelCoverPhotoId;
      return `
        <button type="button" class="model-cover-thumb-btn ${isSelected ? "is-active" : ""}"
          data-action="select-model-cover-photo" data-id="${escapeHTML(p.id)}"
          title="${isSelected ? "Текущая обложка модели" : "Сделать обложкой модели"}">
          <img src="${photoURL(p, "preview")}" alt="Фото">
          ${isSelected ? '<span class="model-thumb-badge">👑</span>' : ""}
        </button>
      `;
    }).join("");
  }

  async function handleModelCoverFile(file) {
    if (!file) return;
    try {
      showHUD({
        title: "Обработка обложки",
        subtitle: file.name,
        percent: 50,
        icon: "📷"
      });

      const prepared = await prepareImage(file);
      state.photos.push(prepared);
      await db.put(CONFIG.stores.photos, prepared);
      state.draftModelCoverPhotoId = prepared.id;

      const model = getModel($("#modelId")?.value);
      updateModelCoverUI(model);
      renderModelSetGallery(model);

      hideHUD(500);
      showToast("Обложка загружена!", "success");
    } catch (err) {
      console.error(err);
      hideHUD(0);
      showToast("Не удалось обработать файл обложки.", "error");
    }
  }

  function openModelForm(model = null) {
    const form = $("#modelForm");
    if (!form) return;

    form.reset();

    $("#modelId").value = model?.id || "";
    $("#modelName").value = model?.name || "";
    $("#modelUrl").value = model?.url || "";
    $("#modelTags").value = (model?.tags || []).join(", ");
    $("#modelNotes").value = model?.notes || "";
    updateModelTagSuggestions?.();

    state.draftModelCoverPhotoId = model?.coverPhotoId || null;
    updateModelCoverUI(model);
    renderModelSetGallery(model);

    const slugInput = $("#modelSlug");
    if (slugInput) {
      slugInput.value = model ? modelSlug(model) : "";
      // У существующей модели адрес не меняется сам при смене ника.
      slugInput.dataset.touched = model ? "1" : "";
    }
    updateSlugHints();

    const heading = $("#modelDialog .dialog-heading h2");
    if (heading) {
      heading.textContent = model ? "Редактировать модель" : "Новая модель";
    }

    openDialog($("#modelDialog"));
    $("#modelName")?.focus();
  }

  async function saveModel(event) {
    event.preventDefault();

    if (state.busy) return;

    const id = $("#modelId").value || uid();
    const name = $("#modelName").value.trim();
    const url = $("#modelUrl").value.trim();

    if (!name) {
      showToast("Укажи никнейм модели.", "error");
      return;
    }

    if (url) {
      try {
        const parsed = new URL(url);

        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("Недопустимая схема URL");
        }
      } catch {
        showToast("Ссылка должна начинаться с https:// или http://", "error");
        return;
      }
    }

    const slug = slugify($("#modelSlug")?.value) || slugify(name) || "model";

    if (state.models.some(item => item.id !== id && modelSlug(item) === slug)) {
      showToast(`Адрес «${slug}» уже занят другой моделью. Выбери другой.`, "error");
      $("#modelSlug")?.focus();
      return;
    }

    const previous = getModel(id);

    // Если меняется только обложка и/или теги (а имя, адрес, ссылка и заметки не менялись),
    // не обновляем дату изменения updatedAt, чтобы модель не вылетала в "недавно обновлённые"!
    const isMinorModelChange = previous && (
      previous.name === name &&
      (previous.slug || "") === slug &&
      (previous.url || "") === url &&
      (previous.notes || "").trim() === $("#modelNotes").value.trim()
    );

    const model = {
      id,
      name,
      slug,
      url,
      tags: parseTags($("#modelTags").value),
      notes: $("#modelNotes").value.trim(),
      coverPhotoId: state.draftModelCoverPhotoId || null,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: isMinorModelChange
        ? (previous.updatedAt || previous.createdAt || new Date().toISOString())
        : new Date().toISOString()
    };

    setBusy(true, "Сохранение модели…");

    try {
      await db.put(CONFIG.stores.models, model);
      await refreshData();

      closeDialog($("#modelDialog"));
      renderAll();
      showToast(previous ? "Модель обновлена." : "Модель добавлена.", "success");
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      showToast("Не удалось сохранить модель.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteModel(id) {
    const model = getModel(id);
    if (!model) return;

    const relatedSets = state.sets.filter(set => set.modelId === id);

    const message = relatedSets.length
      ? `Удалить модель «${model.name}» и все её сеты (${relatedSets.length}) вместе с фотографиями? Это действие нельзя отменить.`
      : `Удалить модель «${model.name}»?`;

    if (!confirm(message)) return;

    recordDeletion("models", id);
    recordDeletion("sets", relatedSets.map(set => set.id));
    recordDeletion("photos", relatedSets.flatMap(set => set.photoIds || []));

    try {
      await db.deleteModelAndSets(id, relatedSets);
      cleanupObjectURLs();
      await refreshData();

      if (state.selectedModelId === id) {
        state.selectedModelId = null;
        navigate("models");
      }

      renderAll();
      showToast("Модель удалена.", "success");
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      showToast("Не удалось удалить модель.", "error");
    }
  }

  /* -------------------- Сеты и фотографии -------------------- */

  function openSetForm(set = null, modelId = null) {
    if (!state.models.length) {
      showToast("Сначала добавь хотя бы одну модель.", "error");
      openModelForm();
      return;
    }

    const form = $("#setForm");
    if (!form) return;

    form.reset();

    $("#setUploadProgress")?.classList.add("hidden");

    state.draftNewPhotos = [];
    state.draftRemovedPhotoIds = new Set();
    state.draftSelectedPhotoIds = new Set();
    state.draftCoverPhotoId = set?.coverPhotoId || null;

    if (set) {
      const savedMap = new Map(state.photos.map(p => [p.id, p]));
      state.draftPhotoList = (set.photoIds || [])
        .map(id => savedMap.get(id))
        .filter(Boolean);
    } else {
      state.draftPhotoList = [];
    }

    $("#setId").value = set?.id || "";
    $("#setCharacter").value = set?.character || "";
    $("#setTitle").value = set?.title || "";
    $("#setRating").value = set?.rating || "";
    $("#setDate").value = set ? (set.date || "") : today();
    $("#setTags").value = (set?.tags || []).join(", ");
    $("#setDescription").value = set?.description || "";
    updateSetTagSuggestions?.();

    const setSlugInput = $("#setSlug");
    if (setSlugInput) {
      setSlugInput.value = set ? setSlug(set) : "";
      setSlugInput.dataset.touched = set ? "1" : "";
    }

    const modelSelect = $("#setModelId");

    if (modelSelect) {
      modelSelect.innerHTML = sortModels(state.models, "name")
        .map(model => `
          <option value="${escapeHTML(model.id)}">
            ${escapeHTML(model.name)}
          </option>
        `).join("");

      modelSelect.value =
        modelId || set?.modelId || state.models[0]?.id || "";
    }

    updateSlugHints();

    const heading = $("#setDialog .dialog-heading h2");
    if (heading) {
      heading.textContent = set ? "Редактировать сет" : "Новый сет";
    }

    const label = $("#newPhotosLabel");
    if (label) {
      label.textContent = set
        ? "Добавить фотографии"
        : "Выбери фотографии для нового сета";
    }

    renderDraftPhotos();
    openDialog($("#setDialog"));
    $("#setCharacter")?.focus();
  }

  async function makeImageVersion(file, { maxDimension, quality, type }) {
    if (!("createImageBitmap" in window)) return null;

    let bitmap;

    try {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        bitmap = await createImageBitmap(file);
      }

      const scale = Math.min(
        1,
        maxDimension / Math.max(bitmap.width, bitmap.height)
      );

      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) return null;

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";

      context.drawImage(bitmap, 0, 0, width, height);

      const blob = await new Promise(resolve => {
        canvas.toBlob(resolve, type || "image/webp", quality);
      });

      return blob || null;
    } catch (error) {
      console.warn("Не удалось построить изображение.", error);
      return null;
    } finally {
      bitmap?.close?.();
    }
  }

  async function prepareImage(file) {
    if (!file || !CONFIG.allowedImageTypes.includes(file.type)) {
      throw new Error(`Формат файла «${file?.name || "неизвестно"}» не поддерживается.`);
    }

    const processing = CONFIG.imageProcessing || {};
    const id = uid();
    const createdAt = new Date().toISOString();
    const canProcess = Boolean(processing.enabled)
      && ("createImageBitmap" in window);

    // Качественное превью для сеток (до 960px, 88% качество)
    const preview = canProcess
      ? await makeImageVersion(file, {
          maxDimension: processing.previewMaxDimension || 960,
          quality: processing.previewQuality || 0.88,
          type: processing.outputType || "image/webp"
        })
      : null;

    // Основная версия: оригинал как есть (макс. качество)…
    if (processing.storeOriginal !== false) {
      return {
        id,
        blob: file,
        preview,
        name: file.name,
        type: file.type,
        createdAt
      };
    }

    // …либо сжатая копия Ultra-HD WebP.
    const compressed = canProcess
      ? await makeImageVersion(file, {
          maxDimension: processing.maxDimension || 3200,
          quality: processing.quality || 0.90,
          type: processing.outputType || "image/webp"
        })
      : null;

    const blob = compressed && compressed.size < file.size
      ? compressed
      : file;

    return {
      id,
      blob,
      preview,
      name: blob === file
        ? file.name
        : file.name.replace(/\.[^.]+$/, "") + ".webp",
      type: blob.type,
      createdAt
    };
  }

  async function addSelectedPhotos(fileList) {
    const rawFiles = Array.from(fileList || []);
    if (!rawFiles.length) return;

    const files = await processFilesOrArchives(rawFiles, "set");
    if (!files.length) return;

    // Сортировка файлов по естественному порядку имён: 1, 2, ..., 10
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );

    const max = CONFIG.maxPhotosPerImport || 200;

    if (files.length > max) {
      showToast(`За раз можно выбрать не более ${max} фотографий.`, "error");
      return;
    }

    const existingCount = state.draftPhotoList.length;

    if (existingCount + files.length > max) {
      showToast(`В одном сете может быть не более ${max} фотографий.`, "error");
      return;
    }

    const input = $("#setPhotos");
    if (input) input.disabled = true;

    showHUD({
      title: "Обработка фотографий",
      subtitle: `Подготовка ${files.length} фото…`,
      current: 0,
      total: files.length,
      icon: "🖼️"
    });

    try {
      let count = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!CONFIG.allowedImageTypes.includes(file.type)) {
          showToast(`Пропущен неподдерживаемый файл: ${file.name}`, "error");
          continue;
        }

        updateHUD({
          subtitle: `Сжатие ${i + 1} из ${files.length} (${file.name})`,
          current: i + 1,
          total: files.length
        });

        const prepared = await prepareImage(file);
        state.draftNewPhotos.push(prepared);
        state.draftPhotoList.push(prepared);

        const temporaryUrl = URL.createObjectURL(prepared.blob);
        state.objectURLs.set(prepared.id, temporaryUrl);
        count++;

        if (count % 4 === 0) {
          renderDraftPhotos();
          await new Promise(r => setTimeout(r, 0));
        }
      }

      renderDraftPhotos();
      showHUD({
        title: "Обработка завершена",
        subtitle: `Успешно добавлено ${count} фото.`,
        percent: 100,
        icon: "✓"
      });
      hideHUD(1500);
      showToast(`Добавлено фотографий: ${state.draftNewPhotos.length}`, "success");
    } catch (error) {
      console.error(error);
      hideHUD(0);
      showToast("Не удалось обработать фотографии.", "error");
    } finally {
      if (input) {
        input.disabled = false;
        input.value = "";
      }
    }
  }

  function updateSetCoverPreviewUI(photos = []) {
    const previewEl = $("#setCoverThumbPreview");
    const statusEl = $("#setCoverStatusText");
    const badgeEl = $("#setCoverBadgeTag");
    if (!previewEl || !statusEl) return;

    if (!photos || !photos.length) {
      previewEl.innerHTML = '<div class="set-cover-placeholder"><span>📷</span><small>Нет фото</small></div>';
      statusEl.textContent = "Добавьте фотографии в сет ниже";
      if (badgeEl) badgeEl.textContent = "Обложка не выбрана";
      return;
    }

    let activeCover = null;
    let isManual = false;
    if (state.draftCoverPhotoId) {
      activeCover = photos.find(p => p.id === state.draftCoverPhotoId);
      if (activeCover) isManual = true;
    }

    if (!activeCover) {
      activeCover = photos[0];
      isManual = false;
    }

    const coverUrl = photoURL(activeCover, "cover");
    previewEl.innerHTML = `<img src="${coverUrl}" alt="Обложка сета">`;
    if (isManual) {
      statusEl.textContent = "Выбрано вручную из фотографий сета";
      if (badgeEl) badgeEl.textContent = "★ Выбранная обложка";
    } else {
      statusEl.textContent = "По умолчанию (первое фото сета)";
      if (badgeEl) badgeEl.textContent = "★ Авто-обложка";
    }
  }

  function updatePhotoManagerToolbar(photos) {
    const badge = $("#photoCountBadge");
    const selection = $("#selectionStatus");
    const selectAllBtn = $("#selectAllPhotosBtn");
    const deleteSelectedBtn = $("#deleteSelectedPhotosBtn");
    const sortBtn = $("#sortByNameBtn");

    if (badge) {
      badge.textContent = `${photos.length} ${pluralize(photos.length, "фото", "фото", "фото")}`;
    }

    const selectedCount = state.draftSelectedPhotoIds.size;

    if (selection) {
      selection.textContent = `Выбрано: ${selectedCount}`;
      selection.classList.toggle("hidden", selectedCount === 0);
    }

    if (deleteSelectedBtn) {
      deleteSelectedBtn.textContent = `🗑 Удалить (${selectedCount})`;
      deleteSelectedBtn.classList.toggle("hidden", selectedCount === 0);
    }

    if (selectAllBtn) {
      selectAllBtn.textContent = (photos.length > 0 && selectedCount === photos.length)
        ? "Снять всё"
        : "☑ Выбрать все";
      selectAllBtn.disabled = photos.length === 0;
    }

    if (sortBtn) {
      sortBtn.disabled = photos.length < 2;
    }
  }

  let draggedDraftPhotoId = null;

  function bindDraftPhotoDragDrop(thumb, photoId) {
    thumb.addEventListener("dragstart", event => {
      draggedDraftPhotoId = photoId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", photoId);
      thumb.classList.add("is-dragging");
    });

    thumb.addEventListener("dragend", () => {
      draggedDraftPhotoId = null;
      thumb.classList.remove("is-dragging");
      $$(".photo-thumb").forEach(t => t.classList.remove("drag-target"));
    });

    thumb.addEventListener("dragover", event => {
      if (!draggedDraftPhotoId || draggedDraftPhotoId === photoId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      thumb.classList.add("drag-target");
    });

    thumb.addEventListener("dragleave", () => {
      thumb.classList.remove("drag-target");
    });

    thumb.addEventListener("drop", event => {
      event.preventDefault();
      thumb.classList.remove("drag-target");
      if (!draggedDraftPhotoId || draggedDraftPhotoId === photoId) return;

      const fromIndex = state.draftPhotoList.findIndex(p => p.id === draggedDraftPhotoId);
      const toIndex = state.draftPhotoList.findIndex(p => p.id === photoId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

      const [moved] = state.draftPhotoList.splice(fromIndex, 1);
      state.draftPhotoList.splice(toIndex, 0, moved);
      renderDraftPhotos();
    });
  }

  function renderDraftPhotos() {
    const container = $("#existingPhotos");
    if (!container) return;

    const photos = state.draftPhotoList.filter(
      p => !state.draftRemovedPhotoIds.has(p.id)
    );

    updateSetCoverPreviewUI(photos);
    updatePhotoManagerToolbar(photos);

    if (!photos.length) {
      container.innerHTML = '<p class="muted small" style="padding: 14px; text-align: center; grid-column: 1 / -1;">В сете пока нет фотографий. Выберите фото или перетащите архив выше.</p>';
      return;
    }

    const effectiveCoverId = (state.draftCoverPhotoId && photos.some(p => p.id === state.draftCoverPhotoId))
      ? state.draftCoverPhotoId
      : photos[0]?.id;

    container.innerHTML = photos.map((photo, index) => {
      const url = photoURL(photo, "preview");
      const isCover = photo.id === effectiveCoverId;
      const isSelected = state.draftSelectedPhotoIds.has(photo.id);

      return `
        <div class="photo-thumb ${isCover ? "is-cover" : ""} ${isSelected ? "is-selected" : ""}"
             draggable="true"
             data-photo-id="${escapeHTML(photo.id)}"
             data-index="${index}">
          <img src="${url}" alt="Фото ${index + 1}" loading="lazy" draggable="false">

          <span class="thumb-order-badge" title="Порядковый номер в сете">#${index + 1}</span>

          <button type="button" class="thumb-select-btn ${isSelected ? "is-selected" : ""}"
            data-action="toggle-select-draft-photo" data-id="${escapeHTML(photo.id)}"
            title="${isSelected ? "Снять выделение" : "Выбрать для удаления"}">
            ${isSelected ? "✓" : ""}
          </button>

          <button type="button" class="thumb-remove-btn" data-action="remove-draft-photo"
            data-id="${escapeHTML(photo.id)}" aria-label="Убрать фото" title="Удалить это фото">×</button>

          <div class="thumb-move-controls">
            <button type="button" class="thumb-move-btn" data-action="move-draft-photo" data-dir="-1"
              data-id="${escapeHTML(photo.id)}" title="Переместить левее" ${index === 0 ? "disabled" : ""}>‹</button>
            <button type="button" class="thumb-move-btn" data-action="move-draft-photo" data-dir="1"
              data-id="${escapeHTML(photo.id)}" title="Переместить правее" ${index === photos.length - 1 ? "disabled" : ""}>›</button>
          </div>

          <button type="button" class="thumb-cover-btn ${isCover ? "is-active" : ""}"
            data-action="set-cover" data-id="${escapeHTML(photo.id)}"
            title="${isCover ? "Текущая обложка фотосета" : "Сделать обложкой фотосета"}">
            ${isCover ? "★ Обложка" : "☆ Обложка"}
          </button>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".photo-thumb").forEach(thumb => {
      const id = thumb.dataset.photoId;
      if (id) bindDraftPhotoDragDrop(thumb, id);
    });
  }

  function moveDraftPhoto(id, offset) {
    const currentIndex = state.draftPhotoList.findIndex(p => p.id === id);
    if (currentIndex === -1) return;
    const newIndex = currentIndex + offset;
    if (newIndex < 0 || newIndex >= state.draftPhotoList.length) return;
    const [moved] = state.draftPhotoList.splice(currentIndex, 1);
    state.draftPhotoList.splice(newIndex, 0, moved);
    renderDraftPhotos();
  }

  function removeDraftPhoto(id) {
    const listIndex = state.draftPhotoList.findIndex(p => p.id === id);
    if (listIndex !== -1) {
      state.draftPhotoList.splice(listIndex, 1);
    }
    state.draftSelectedPhotoIds.delete(id);

    const newPhotoIndex = state.draftNewPhotos.findIndex(photo => photo.id === id);

    if (newPhotoIndex !== -1) {
      const [photo] = state.draftNewPhotos.splice(newPhotoIndex, 1);
      const url = state.objectURLs.get(photo.id);

      if (url) {
        URL.revokeObjectURL(url);
        state.objectURLs.delete(photo.id);
      }
    } else {
      state.draftRemovedPhotoIds.add(id);
    }

    if (state.draftCoverPhotoId === id) {
      state.draftCoverPhotoId = null;
    }

    renderDraftPhotos();
  }

  function removeSelectedDraftPhotos() {
    if (!state.draftSelectedPhotoIds.size) return;
    const count = state.draftSelectedPhotoIds.size;
    const ids = [...state.draftSelectedPhotoIds];
    ids.forEach(id => removeDraftPhoto(id));
    state.draftSelectedPhotoIds.clear();
    renderDraftPhotos();
    showToast(`Удалено фотографий: ${count}`, "info");
  }

  function sortDraftPhotosByName() {
    state.draftPhotoList.sort((a, b) => {
      const nameA = a.name || a.id || "";
      const nameB = b.name || b.id || "";
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
    });
    renderDraftPhotos();
    showToast("Фотографии отсортированы по имени", "success");
  }

  function toggleSelectAllDraftPhotos() {
    const photos = state.draftPhotoList.filter(p => !state.draftRemovedPhotoIds.has(p.id));
    if (state.draftSelectedPhotoIds.size === photos.length) {
      state.draftSelectedPhotoIds.clear();
    } else {
      photos.forEach(p => state.draftSelectedPhotoIds.add(p.id));
    }
    renderDraftPhotos();
  }

  /* -------------------- Массовая загрузка фотографий -------------------- */

  function massUploadSetLabel(set) {
    const model = getModel(set.modelId);
    const name = set.title || set.character || "Без названия";
    return model ? `${model.name} — ${name}` : name;
  }

  function releaseMassUploadURLs() {
    for (const url of state.massUploadObjectURLs.values()) {
      URL.revokeObjectURL(url);
    }

    state.massUploadObjectURLs.clear();
  }

  function resetMassUploadState() {
    releaseMassUploadURLs();
    state.massUploadPhotos = [];
    state.massUploadTargetSetId = null;
    $("#massUploadProgress")?.classList.add("hidden");
    renderMassThumbs();
    updateMassUploadStatus();
  }

  function massUploadMatches(set, query) {
    if (!query) return true;

    const model = getModel(set.modelId);
    const haystack = [
      model?.name || "",
      set.character || "",
      set.title || "",
      set.description || "",
      (set.tags || []).join(" ")
    ].join(" ").toLocaleLowerCase("ru");

    return haystack.includes(query);
  }

  function renderMassTargets() {
    const select = $("#massUploadSet");
    if (!select) return;

    const query = ($("#massUploadSetFilter")?.value || "").trim().toLocaleLowerCase("ru");
    const previous = select.value;

    const groups = sortModels(state.models, "name")
      .map(model => ({
        model,
        sets: sortSets(
          state.sets.filter(set => set.modelId === model.id
            && massUploadMatches(set, query)),
          "newest"
        )
      }))
      .filter(group => group.sets.length);

    select.innerHTML = groups.map(group => `
      <optgroup label="${escapeHTML(group.model.name)}">
        ${group.sets.map(set => `
          <option value="${escapeHTML(set.id)}">
            ${escapeHTML(massUploadSetLabel(set))}
          </option>
        `).join("")}
      </optgroup>
    `).join("");

    const values = [...select.options].map(option => option.value);

    if (state.massUploadTargetSetId && values.includes(state.massUploadTargetSetId)) {
      select.value = state.massUploadTargetSetId;
    } else if (values.includes(previous)) {
      select.value = previous;
    }

    if (!values.length) {
      select.innerHTML = '<option value="">Нет подходящих сетов</option>';
    }
  }

  function openMassUploadDialog(preferredSetId = null) {
    if (!state.sets.length) {
      showToast("Сначала создай хотя бы один сет.", "error");
      return;
    }

    const filter = $("#massUploadSetFilter");
    if (filter) filter.value = "";

    resetMassUploadState();
    state.massUploadTargetSetId = preferredSetId || null;

    renderMassTargets();
    openDialog($("#massUploadDialog"));
  }

  function updateMassUploadStatus(extra = "") {
    const status = $("#massUploadStatus");
    if (!status) return;

    const count = state.massUploadPhotos.length;

    status.textContent = extra || (count
      ? `Выбрано фотографий: ${count}`
      : "Фотографии ещё не выбраны.");
  }

  function renderMassThumbs() {
    const container = $("#massUploadThumbs");
    if (!container) return;

    container.innerHTML = state.massUploadPhotos.map((photo, index) => `
      <div class="photo-thumb">
        <img src="${state.massUploadObjectURLs.get(photo.id) || ""}"
          alt="Фото ${index + 1}" loading="lazy">
        <button type="button" data-action="remove-mass-photo"
          data-id="${escapeHTML(photo.id)}" aria-label="Убрать фото">×</button>
      </div>
    `).join("");
  }

  function removeMassPhoto(id) {
    const index = state.massUploadPhotos.findIndex(photo => photo.id === id);
    if (index === -1) return;

    state.massUploadPhotos.splice(index, 1);

    const url = state.massUploadObjectURLs.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      state.massUploadObjectURLs.delete(id);
    }

    renderMassThumbs();
    updateMassUploadStatus();
  }

  async function addMassPhotos(fileList) {
    const rawFiles = Array.from(fileList || []);
    if (!rawFiles.length) return;

    const files = await processFilesOrArchives(rawFiles, "mass");
    if (!files.length) return;

    const max = CONFIG.maxPhotosPerImport || 200;

    if (state.massUploadPhotos.length + files.length > max) {
      showToast(`За раз можно обработать не более ${max} фотографий.`, "error");
      return;
    }

    const input = $("#massUploadInput");
    if (input) input.disabled = true;

    showHUD({
      title: "Обработка фотографий",
      subtitle: `Подготовка ${files.length} фото…`,
      current: 0,
      total: files.length,
      icon: "🖼️"
    });

    let added = 0;
    let skipped = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!CONFIG.allowedImageTypes.includes(file.type)) {
          skipped += 1;
          continue;
        }

        updateHUD({
          subtitle: `Сжатие ${i + 1} из ${files.length} (${file.name})`,
          current: i + 1,
          total: files.length
        });

        try {
          const prepared = await prepareImage(file);
          state.massUploadPhotos.push(prepared);
          state.massUploadObjectURLs.set(
            prepared.id,
            URL.createObjectURL(prepared.preview || prepared.blob)
          );
          added += 1;
        } catch (error) {
          console.warn(`Файл «${file.name}» пропущен.`, error);
          skipped += 1;
        }

        updateMassUploadStatus(
          `Обработка… ${added + skipped} из ${files.length}`
        );

        if ((added + skipped) % 4 === 0) {
          renderMassThumbs();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      showHUD({
        title: "Обработка завершена",
        subtitle: `Успешно подготовлено ${added} фото.`,
        percent: 100,
        icon: "✓"
      });
      hideHUD(1500);
    } catch (error) {
      console.error(error);
      hideHUD(0);
    } finally {
      if (input) {
        input.disabled = false;
        input.value = "";
      }
    }

    renderMassThumbs();
    updateMassUploadStatus();

    if (added) {
      showToast(`Добавлено фотографий: ${added}`, "success");
    }

    if (skipped) {
      showToast(`Пропущено файлов: ${skipped}`, "error");
    }
  }

  async function saveMassUpload(event) {
    event.preventDefault();

    if (state.busy) return;

    const set = getSet($("#massUploadSet")?.value);

    if (!set) {
      showToast("Выбери сет для загрузки.", "error");
      return;
    }

    if (!state.massUploadPhotos.length) {
      showToast("Добавь хотя бы одну фотографию.", "error");
      return;
    }

    const baseOrder = (set.photoIds || []).length;

    const newPhotos = state.massUploadPhotos.map((photo, index) => ({
      ...photo,
      setId: set.id,
      order: baseOrder + index
    }));

    const photoIds = [
      ...(set.photoIds || []),
      ...newPhotos.map(photo => photo.id)
    ];

    const setRecord = {
      ...set,
      photoIds,
      coverPhotoId: set.coverPhotoId || photoIds[0] || null,
      updatedAt: new Date().toISOString()
    };

    setBusy(true, "Загрузка фотографий…");
    showHUD({
      title: "Сохранение сета",
      subtitle: `Запись ${newPhotos.length} фото в базу данных…`,
      percent: 85,
      icon: "💾"
    });

    try {
      await db.saveSetWithPhotos(setRecord, newPhotos, []);
      await touchModel(set.modelId);

      resetMassUploadState();
      closeDialog($("#massUploadDialog"));

      await refreshData();
      renderAll();

      showHUD({
        title: "Готово",
        subtitle: `Успешно сохранено ${newPhotos.length} фото.`,
        percent: 100,
        icon: "✓"
      });
      hideHUD(1200);

      showToast(`Загружено фотографий: ${newPhotos.length}`, "success");
      scheduleAutoSync();

      navigate("set-detail", setRecord.id);
    } catch (error) {
      console.error(error);
      hideHUD(0);
      showToast("Не удалось загрузить фотографии.", "error");
    } finally {
      setBusy(false);
    }
  }

  function bindDropZone(panel, onFiles) {
    if (!panel) return;

    ["dragenter", "dragover"].forEach(type => {
      panel.addEventListener(type, event => {
        event.preventDefault();
        panel.classList.add("is-dragover");
      });
    });

    ["dragleave", "dragend"].forEach(type => {
      panel.addEventListener(type, () => {
        panel.classList.remove("is-dragover");
      });
    });

    panel.addEventListener("drop", event => {
      event.preventDefault();
      panel.classList.remove("is-dragover");

      const files = [...(event.dataTransfer?.files || [])]
        .filter(file => file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|avif|zip|rar)$/i.test(file.name));

      if (files.length) onFiles(files);
    });
  }

  async function saveSet(event) {
    event.preventDefault();

    if (state.busy) return;

    const id = $("#setId").value || uid();
    const modelId = $("#setModelId").value;
    const character = $("#setCharacter").value.trim();

    if (!modelId || !getModel(modelId)) {
      showToast("Выбери существующую модель.", "error");
      return;
    }

    if (!character) {
      showToast("Укажи имя персонажа.", "error");
      return;
    }

    const slug = slugify($("#setSlug")?.value)
      || slugify($("#setTitle").value || character)
      || "set";

    if (state.sets.some(
      item => item.id !== id && item.modelId === modelId && setSlug(item) === slug
    )) {
      showToast(`У этой модели уже есть сет с адресом «${slug}». Выбери другой.`, "error");
      $("#setSlug")?.focus();
      return;
    }

    const previous = getSet(id);

    // Сохраняем фотографии в порядке, установленном пользователем в draftPhotoList
    const orderedPhotos = state.draftPhotoList.filter(
      photo => !state.draftRemovedPhotoIds.has(photo.id)
    );
    const keptPhotoIds = orderedPhotos.map(photo => photo.id);

    const newPhotos = state.draftNewPhotos
      .filter(photo => !state.draftRemovedPhotoIds.has(photo.id))
      .map(photo => ({
        ...photo,
        setId: id,
        order: keptPhotoIds.indexOf(photo.id)
      }));

    const coverId = state.draftCoverPhotoId
      && keptPhotoIds.includes(state.draftCoverPhotoId)
      ? state.draftCoverPhotoId
      : keptPhotoIds[0] || null;

    const ratingValue = Number($("#setRating").value || 0);

    const isNewSet = !previous;

    // Была ли загружена ровно одна обложка через прямую загрузку обложки
    const isDirectCoverOnlyUpload = state.draftNewPhotos.length === 1 && state.draftNewPhotos[0].id === coverId;

    // Добавляются ли новые фотографии в сет (кроме одиночной загрузки прямой обложки)?
    const hasAddedNewPhotos = state.draftNewPhotos.length > 0 && !isDirectCoverOnlyUpload;

    // Проверяем, изменились ли только обложка и/или теги (а персонаж, название, описание, рейтинг, модель не менялись и новые фото не добавлялись)
    const isMinorSetChange = previous && !hasAddedNewPhotos && (
      previous.modelId === modelId &&
      previous.character === character &&
      (previous.title || "").trim() === $("#setTitle").value.trim() &&
      Number(previous.rating || 0) === Number(ratingValue || 0) &&
      (previous.description || "").trim() === $("#setDescription").value.trim()
    );

    // Если это незначительное изменение (только обложка или теги):
    // сохраняем оригинальную дату сета и дату изменения updatedAt,
    // чтобы сет не вылетал в "недавно обновлённые"!
    // Но если сет новый или в него добавлены новые фото — обновляем updatedAt на текущий момент!
    const setDateValue = $("#setDate").value.trim();
    const effectiveDate = isMinorSetChange
      ? (previous.date || "")
      : (previous ? setDateValue : (setDateValue || today()));

    const effectiveUpdatedAt = isMinorSetChange
      ? (previous.updatedAt || previous.createdAt || new Date().toISOString())
      : new Date().toISOString();

    const shouldTouchModel = isNewSet || hasAddedNewPhotos || !isMinorSetChange;

    const setRecord = {
      id,
      modelId,
      slug,
      character,
      title: $("#setTitle").value.trim(),
      rating: Number.isFinite(ratingValue)
        ? Math.max(0, Math.min(5, ratingValue))
        : 0,
      date: effectiveDate,
      tags: parseTags($("#setTags").value),
      description: $("#setDescription").value.trim(),
      photoIds: keptPhotoIds,
      coverPhotoId: coverId,
      favorite: Boolean(previous?.favorite),
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: effectiveUpdatedAt
    };

    setBusy(true, "Сохранение сета…");
    if (newPhotos.length > 0) {
      showHUD({
        title: "Сохранение сета",
        subtitle: `Запись ${newPhotos.length} фото в базу данных…`,
        percent: 85,
        icon: "💾"
      });
    }

    try {
      await db.saveSetWithPhotos(
        setRecord,
        newPhotos,
        [...state.draftRemovedPhotoIds]
      );

      if (shouldTouchModel) {
        await touchModel(modelId);
        if (previous && previous.modelId && previous.modelId !== modelId) {
          await touchModel(previous.modelId);
        }
      }

      recordDeletion("photos", [...state.draftRemovedPhotoIds]);

      cleanupObjectURLs();
      state.draftNewPhotos = [];
      state.draftRemovedPhotoIds.clear();
      state.draftCoverPhotoId = null;

      await refreshData();
      closeDialog($("#setDialog"));
      renderAll();

      if (newPhotos.length > 0) {
        showHUD({
          title: "Готово",
          subtitle: `Сет и ${newPhotos.length} фото сохранены.`,
          percent: 100,
          icon: "✓"
        });
        hideHUD(1200);
      }

      showToast(previous ? "Сет обновлён." : "Сет добавлен.", "success");
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      hideHUD(0);
      showToast(
        "Не удалось сохранить сет. Проверь свободное место и попробуй снова.",
        "error"
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteSet(id) {
    const set = getSet(id);
    if (!set) return;

    if (!confirm(
      `Удалить сет «${set.title || set.character}» и все его фотографии? Это действие нельзя отменить.`
    )) {
      return;
    }

    recordDeletion("sets", id);
    recordDeletion("photos", set.photoIds || []);

    try {
      await db.deleteSet(set);
      cleanupObjectURLs();
      await refreshData();

      if (state.page === "set-detail" && state.viewedSetId === id) {
        // Страницы удалённого сета больше нет — возвращаемся к модели.
        if (getModel(set.modelId)) {
          navigate("model-detail", set.modelId);
        } else {
          navigate("models");
        }
      }

      renderAll();

      showToast("Сет удалён.", "success");
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      showToast("Не удалось удалить сет.", "error");
    }
  }

  async function toggleFavorite(id) {
    const set = getSet(id);
    if (!set) return;

    const updated = {
      ...set,
      favorite: !set.favorite,
      updatedAt: new Date().toISOString()
    };

    try {
      await db.put(CONFIG.stores.sets, updated);
      await refreshData();
      renderAll();


      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      showToast("Не удалось обновить избранное.", "error");
    }
  }

  /* -------------------- Просмотр сета -------------------- */

  /* -------------------- Скачивание фотографий -------------------- */

  function photoExtension(blob, fallbackType = "") {
    const type = (blob && blob.type) || fallbackType || "";
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    if (type.includes("png")) return "png";
    if (type.includes("gif")) return "gif";
    if (type.includes("avif")) return "avif";
    return "webp";
  }

  function downloadBaseName(set) {
    const model = set ? getModel(set.modelId) : null;
    const parts = [
      slugify(model?.name || ""),
      slugify(set?.title || set?.character || "")
    ].filter(Boolean);

    return parts.join("-") || "cosplay";
  }

  function photoDownloadName(photo, base, index, { keepOriginal = true } = {}) {
    const extension = photoExtension(photo?.blob, photo?.type);

    if (keepOriginal) {
      const raw = String(photo?.name || "").replace(/\.[^.]+$/, "").trim();
      const safe = raw.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80);
      if (safe) return `${safe}.${extension}`;
    }

    const number = String(index + 1).padStart(2, "0");
    return `${base}-${number}.${extension}`;
  }

  async function downloadCurrentPhoto() {
    const photo = state.lightboxPhotos[state.lightboxIndex];
    if (!photo) return;

    let blob = photo.blob;
    if (!(blob instanceof Blob) && photo.driveFileId && drive) {
      showToast("Загрузка оригинала из облака…");
      try {
        blob = await drive.downloadFile(photo.driveFileId, photo.providerTargetId);
      } catch (err) {
        showToast("Не удалось скачать фото из облака.", "error");
        return;
      }
    }

    if (!blob) {
      showToast("Фотография недоступна для скачивания.", "error");
      return;
    }

    const base = downloadBaseName(getSet(state.viewedSetId));
    downloadBlob(
      blob,
      photoDownloadName({ ...photo, blob }, base, state.lightboxIndex)
    );
    showToast("Фото скачано.");
  }

  async function downloadSetPhotos(set) {
    if (!set) return;

    const photos = getSetPhotos(set);

    if (!photos.length) {
      showToast("В этом сете нет фотографий.");
      return;
    }

    const base = downloadBaseName(set);
    const nameOf = index =>
      photoDownloadName(photos[index], base, index, { keepOriginal: false });

    const fetchPhotoBlob = async (photo) => {
      if (photo.blob instanceof Blob) return photo.blob;
      if (photo.driveFileId && drive) {
        try {
          return await drive.downloadFile(photo.driveFileId, photo.providerTargetId);
        } catch {
          return null;
        }
      }
      return null;
    };

    // Chromium на ПК: пишем сразу в выбранную папку
    if (typeof window.showDirectoryPicker === "function") {
      try {
        const directory = await window.showDirectoryPicker({ mode: "readwrite" });
        showProgress(`Загрузка фото из облака (0/${photos.length})…`);

        for (let index = 0; index < photos.length; index += 1) {
          showProgress(`Загрузка фото (${index + 1}/${photos.length})…`);
          const blob = await fetchPhotoBlob(photos[index]);
          if (!blob) continue;
          const handle = await directory.getFileHandle(nameOf(index, blob), { create: true });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        }

        hideProgress();
        showToast(`Скачано фотографий: ${photos.length}.`);
        return;
      } catch (error) {
        hideProgress();
        if (error?.name === "AbortError") return;
      }
    }

    // Мобильные устройства, Safari, Firefox: скачиваем единым ZIP-архивом
    if (typeof window.JSZip === "function") {
      showProgress(`Подготовка архива (0/${photos.length})…`);
      try {
        const zip = new window.JSZip();
        for (let index = 0; index < photos.length; index += 1) {
          showProgress(`Загрузка в ZIP (${index + 1}/${photos.length})…`);
          const blob = await fetchPhotoBlob(photos[index]);
          if (blob) {
            zip.file(nameOf(index, blob), blob);
          }
        }
        showProgress("Сжатие ZIP-архива…");
        const zipBlob = await zip.generateAsync({ type: "blob" });
        downloadBlob(zipBlob, `${base}.zip`);
        showToast(`Архив «${base}.zip» скачан.`, "success");
        return;
      } catch (error) {
        console.warn("Ошибка генерации ZIP-архива:", error);
        showToast("Ошибка при сборке ZIP архива", "error");
      } finally {
        hideProgress();
      }
    }

    // Запасной путь для браузеров без JSZip
    for (let index = 0; index < photos.length; index += 1) {
      const blob = await fetchPhotoBlob(photos[index]);
      if (blob) {
        setTimeout(() => downloadBlob(blob, nameOf(index, blob)), index * 400);
      }
    }

    showToast(`Скачиваю фотографий: ${photos.length}…`);
  }

  function renderSetDetail() {
    const root = $("#setDetailBody");
    if (!root) return;

    const set = getSet(state.viewedSetId);

    if (!set) {
      root.innerHTML = renderNotFound(
        "Сет не найден",
        "Возможно, он удалён или ещё не синхронизировался на этом устройстве."
      );
      return;
    }

    state.selectedModelId = set.modelId;

    const model = getModel(set.modelId);
    const photos = getSetPhotos(set);
    const title = set.title || set.character || "Без названия";
    const modelName = model?.name || "Неизвестная модель";

    // Соседние сеты этой же модели для перехода «назад / вперёд».
    const siblings = sortSets(
      state.sets.filter(item => item.modelId === set.modelId),
      "newest"
    );
    const index = siblings.findIndex(item => item.id === set.id);
    const newer = index > 0 ? siblings[index - 1] : null;
    const older = index >= 0 && index < siblings.length - 1
      ? siblings[index + 1]
      : null;

    const pagerLink = (item, label, className) => item
      ? `<a class="button button-quiet ${className}" href="${setHref(item.id)}">
           ${label}
           <span class="pager-title">${escapeHTML(item.title || item.character || "Без названия")}</span>
         </a>`
      : "<span></span>";

    root.innerHTML = `
      <nav class="breadcrumbs" aria-label="Навигация по страницам">
        <a href="#/">Модели</a>
        <span aria-hidden="true">/</span>
        ${model
          ? `<a href="${modelHref(model.id)}">${escapeHTML(modelName)}</a>`
          : `<span>${escapeHTML(modelName)}</span>`}
        <span aria-hidden="true">/</span>
        <span aria-current="page">${escapeHTML(title)}</span>
      </nav>

      <div class="model-detail-hero set-detail-hero">
        <div class="hero-content">
          <p class="eyebrow">${model
            ? `<a href="${modelHref(model.id)}">${escapeHTML(modelName)}</a>`
            : escapeHTML(modelName)}</p>
          <h1>${escapeHTML(title)}</h1>
          <div class="set-meta">
            <span>Персонаж: ${escapeHTML(set.character || "не указан")}</span>
            <span>${escapeHTML(formatDate(set.date || set.createdAt?.slice(0, 10)))}</span>
            ${set.rating ? `<span>★ ${escapeHTML(set.rating)}/5</span>` : ""}
            <span>${photos.length} ${pluralize(photos.length, "фото", "фото", "фото")}</span>
          </div>
          ${set.tags?.length
            ? `<div class="tag-chips set-detail-tags">${renderTags(set.tags)}</div>`
            : ""}
        </div>

        <div class="hero-actions">
          <button class="button ${set.favorite ? "button-primary" : ""}" type="button"
            data-action="favorite-set" data-id="${escapeHTML(set.id)}"
            aria-pressed="${Boolean(set.favorite)}">
            ${set.favorite ? "♥ В избранном" : "♡ В избранное"}
          </button>
          <button class="button" type="button"
            data-action="edit-set" data-id="${escapeHTML(set.id)}">
            Редактировать
          </button>
          <button class="button button-quiet" type="button"
            data-action="upload-photos" data-id="${escapeHTML(set.id)}">
            Загрузить фото
          </button>
          ${photos.length
            ? `<button class="button button-quiet" type="button"
                 data-action="download-set" data-id="${escapeHTML(set.id)}">
                 Скачать фото
               </button>`
            : ""}
          <button class="button button-quiet" type="button"
            data-action="delete-set" data-id="${escapeHTML(set.id)}">
            Удалить
          </button>
        </div>
      </div>

      ${set.description
        ? `<p class="view-description set-detail-description">${escapeHTML(set.description)}</p>`
        : ""}

      ${photos.length
        ? `<div class="photo-gallery set-detail-gallery">
            ${photos.map((photo, photoIndex) => `
              <button type="button" data-action="lightbox"
                data-index="${photoIndex}" aria-label="Открыть фото ${photoIndex + 1}">
                 <img src="${photoURL(photo, "preview")}"
                   alt="${escapeHTML(set.character)} — фото ${photoIndex + 1}"
                   loading="lazy">
              </button>
            `).join("")}
          </div>`
        : `<div class="empty-state">
             <h2>В этом сете пока нет фотографий</h2>
             <p>Открой «Редактировать», чтобы добавить фото.</p>
           </div>`}

      ${newer || older
        ? `<nav class="set-pager" aria-label="Другие сеты модели">
             ${pagerLink(newer, "← Новее", "pager-prev")}
             ${pagerLink(older, "Старее →", "pager-next")}
           </nav>`
        : ""}
    `;
  }

  /* -------------------- Полноэкранная галерея -------------------- */

  const zoom = {
    scale: 1,
    x: 0,
    y: 0,
    min: 1,
    max: 8,
    pointers: new Map(),
    pinch: null,
    drag: null,
    lastTap: { time: 0, x: 0, y: 0 }
  };

  const canFullscreen = () =>
    Boolean(document.documentElement.requestFullscreen);

  function openLightbox(setId, startIndex = 0) {
    const set = getSet(setId);
    if (!set) return;

    state.lightboxPhotos = getSetPhotos(set);
    state.lightboxIndex = Math.max(
      0,
      Math.min(startIndex, state.lightboxPhotos.length - 1)
    );

    if (!state.lightboxPhotos.length) {
      showToast("В этом сете пока нет фотографий.");
      return;
    }

    let dialog = $("#photoDialog");

    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "photoDialog";
      document.body.appendChild(dialog);
    }

    dialog.className = "photo-lightbox";
    dialog.innerHTML = `
      <div class="lightbox-stage" id="lightboxStage">
        <img id="lightboxImage" alt="" draggable="false">
      </div>
      <button class="lightbox-close" type="button"
        data-action="close-lightbox" aria-label="Закрыть">×</button>
      <button class="lightbox-arrow previous" type="button"
        data-action="previous-photo" aria-label="Предыдущее фото">‹</button>
      <button class="lightbox-arrow next" type="button"
        data-action="next-photo" aria-label="Следующее фото">›</button>
      <span class="lightbox-counter" id="lightboxCounter"></span>
      <div class="lightbox-toolbar" role="toolbar" aria-label="Масштаб">
        <button type="button" data-action="zoom-out"
          aria-label="Уменьшить" title="Уменьшить (−)">−</button>
        <button type="button" data-action="zoom-reset" id="lightboxZoomLabel"
          aria-label="Сбросить масштаб" title="Сбросить (0)">100%</button>
        <button type="button" data-action="zoom-in"
          aria-label="Увеличить" title="Увеличить (+)">+</button>
        ${canFullscreen()
          ? `<button type="button" data-action="fullscreen-toggle"
               aria-label="На весь экран" title="На весь экран (F)">⛶</button>`
          : ""}
        <button type="button" data-action="download-photo"
          aria-label="Скачать фото" title="Скачать (D)">↓</button>
      </div>
    `;

    bindLightboxStage($("#lightboxStage"));
    resetZoom();
    renderLightboxPhoto();
    openDialog(dialog);
    window.addEventListener("resize", handleLightboxWindowResize);
    window.addEventListener("orientationchange", handleLightboxWindowResize);
  }

  function handleLightboxWindowResize() {
    const dialog = $("#photoDialog");
    if (dialog && dialog.open) {
      fitLightboxImage();
    }
  }

  function fitLightboxImage() {
    const image = $("#lightboxImage");
    const stage = $("#lightboxStage");
    if (!image || !stage) return;
    if (!image.naturalWidth || !image.naturalHeight) return;

    const style = window.getComputedStyle(stage);
    const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const availW = Math.max(100, stage.clientWidth - padX);
    const availH = Math.max(100, stage.clientHeight - padY);

    const naturalAspect = image.naturalWidth / image.naturalHeight;
    let targetW, targetH;

    if (availW / availH > naturalAspect) {
      targetH = availH;
      targetW = availH * naturalAspect;
    } else {
      targetW = availW;
      targetH = availW / naturalAspect;
    }

    image.style.width = `${Math.round(targetW)}px`;
    image.style.height = `${Math.round(targetH)}px`;

    clampZoom();
    applyZoom();
  }

  async function renderLightboxPhoto() {
    const photo = state.lightboxPhotos[state.lightboxIndex];
    if (!photo) return;

    const image = $("#lightboxImage");
    const counter = $("#lightboxCounter");

    if (counter) {
      counter.textContent =
        `${state.lightboxIndex + 1} / ${state.lightboxPhotos.length}`;
    }

    if (!image) return;

    image.alt = photo.name || "Фотография сета";
    const currentId = photo.id;

    image.onload = () => {
      fitLightboxImage();
    };

    // 1. Если локальный Ultra-HD оригинал уже в памяти или IndexedDB:
    if (photo.blob instanceof Blob) {
      const fullUrl = photoURL(photo, "full");
      image.src = fullUrl;
      if (image.complete && image.naturalWidth > 0) {
        fitLightboxImage();
      }
    } else {
      // 2. Фото в облаке: сразу показываем превью, но fitLightboxImage мгновенно
      // рассчитывает и подгоняет его размер под пропорции экрана,
      // чтобы фото сразу отображалось во весь экран, а не маленькой миниатюрой!
      const previewUrl = photoURL(photo, "preview");
      if (previewUrl) {
        image.src = previewUrl;
        if (image.complete && image.naturalWidth > 0) {
          fitLightboxImage();
        }
      }

      // Фоново подтягиваем и предварительно декодируем оригинал
      loadFullPhotoURL(photo).then(async fullUrl => {
        if (!fullUrl) return;
        if (state.lightboxPhotos[state.lightboxIndex]?.id !== currentId) return;

        try {
          const preloader = new Image();
          preloader.src = fullUrl;
          if (preloader.decode) {
            await preloader.decode();
          }
        } catch {}

        if (state.lightboxPhotos[state.lightboxIndex]?.id === currentId) {
          image.src = fullUrl;
          fitLightboxImage();
        }
      });
    }

    // Фоновая предзагрузка соседних оригиналов
    const count = state.lightboxPhotos.length;
    if (count > 1) {
      for (const shift of [-1, 1]) {
        const neighbour =
          state.lightboxPhotos[(state.lightboxIndex + shift + count) % count];
        if (neighbour) {
          loadFullPhotoURL(neighbour).catch(() => {});
        }
      }
    }
  }

  function moveLightbox(direction) {
    const count = state.lightboxPhotos.length;
    if (!count) return;

    state.lightboxIndex =
      (state.lightboxIndex + direction + count) % count;

    resetZoom();
    renderLightboxPhoto();
  }

  /* ----- Масштабирование и перемещение фото ----- */

  function applyZoom() {
    const image = $("#lightboxImage");
    const stage = $("#lightboxStage");
    const label = $("#lightboxZoomLabel");

    if (image) {
      image.style.transform =
        `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`;
    }

    stage?.classList.toggle("is-zoomed", zoom.scale > 1.001);
    if (label) label.textContent = `${Math.round(zoom.scale * 100)}%`;
  }

  function clampZoom() {
    const stage = $("#lightboxStage");
    const image = $("#lightboxImage");
    if (!stage || !image) return;

    zoom.scale = Math.min(zoom.max, Math.max(zoom.min, zoom.scale));

    // Размеры без учёта transform: так считается реальный размер на экране.
    const width = image.offsetWidth * zoom.scale;
    const height = image.offsetHeight * zoom.scale;
    const maxX = Math.max(0, (width - stage.clientWidth) / 2);
    const maxY = Math.max(0, (height - stage.clientHeight) / 2);

    zoom.x = maxX ? Math.min(maxX, Math.max(-maxX, zoom.x)) : 0;
    zoom.y = maxY ? Math.min(maxY, Math.max(-maxY, zoom.y)) : 0;
  }

  function resetZoom() {
    zoom.scale = 1;
    zoom.x = 0;
    zoom.y = 0;
    zoom.pointers.clear();
    zoom.pinch = null;
    zoom.drag = null;
    applyZoom();
  }

  // Приближение с сохранением точки под курсором/пальцами на месте.
  // px, py — координаты относительно центра области просмотра.
  function zoomAt(nextScale, px = 0, py = 0) {
    const next = Math.min(zoom.max, Math.max(zoom.min, nextScale));
    const ratio = next / zoom.scale;

    zoom.x = px - (px - zoom.x) * ratio;
    zoom.y = py - (py - zoom.y) * ratio;
    zoom.scale = next;

    if (next <= 1.001) {
      zoom.x = 0;
      zoom.y = 0;
    }

    clampZoom();
    applyZoom();
  }

  function zoomBy(factor) {
    zoomAt(zoom.scale * factor);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }

    // Модальный <dialog> нельзя развернуть сам (браузер отказывает),
    // поэтому разворачиваем страницу целиком.
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      showToast("Браузер не разрешил полноэкранный режим.");
      return;
    }

    // Страница в полноэкранном режиме попадает в top layer выше окна просмотра —
    // открываем окно заново, чтобы оно снова оказалось сверху.
    const dialog = $("#photoDialog");

    if (dialog?.open) {
      state.reopeningLightbox = true;
      dialog.close();
      dialog.showModal();
    }
  }

  function bindLightboxStage(stage) {
    if (!stage) return;

    const centerOf = (clientX, clientY) => {
      const rect = stage.getBoundingClientRect();

      return {
        x: clientX - (rect.left + rect.width / 2),
        y: clientY - (rect.top + rect.height / 2)
      };
    };

    // Колесо мыши и жест «щипок» на тачпаде.
    stage.addEventListener("wheel", event => {
      event.preventDefault();

      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      if (event.deltaMode === 2) delta *= 400;

      const speed = event.ctrlKey ? 0.01 : 0.0022;
      const point = centerOf(event.clientX, event.clientY);

      zoomAt(zoom.scale * Math.exp(-delta * speed), point.x, point.y);
    }, { passive: false });

    stage.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;

      stage.setPointerCapture?.(event.pointerId);
      zoom.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
      });

      if (zoom.pointers.size === 2) {
        const [a, b] = [...zoom.pointers.values()];

        zoom.pinch = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          scale: zoom.scale,
          cx: (a.x + b.x) / 2,
          cy: (a.y + b.y) / 2
        };
        zoom.drag = null;
      } else if (zoom.pointers.size === 1) {
        zoom.drag = {
          startX: event.clientX,
          startY: event.clientY,
          originX: zoom.x,
          originY: zoom.y,
          moved: false,
          time: Date.now(),
          onImage: event.target.id === "lightboxImage"
        };
      }
    });

    stage.addEventListener("pointermove", event => {
      if (!zoom.pointers.has(event.pointerId)) return;

      zoom.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
      });

      if (zoom.pinch && zoom.pointers.size >= 2) {
        const [a, b] = [...zoom.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;

        // Сначала сдвигаем вместе с пальцами, потом масштабируем.
        zoom.x += cx - zoom.pinch.cx;
        zoom.y += cy - zoom.pinch.cy;
        zoom.pinch.cx = cx;
        zoom.pinch.cy = cy;

        const point = centerOf(cx, cy);

        zoomAt(
          zoom.pinch.scale * (distance / zoom.pinch.distance),
          point.x,
          point.y
        );
        return;
      }

      if (!zoom.drag) return;

      const dx = event.clientX - zoom.drag.startX;
      const dy = event.clientY - zoom.drag.startY;

      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) zoom.drag.moved = true;

      if (zoom.scale > 1.001) {
        zoom.x = zoom.drag.originX + dx;
        zoom.y = zoom.drag.originY + dy;
        clampZoom();
        applyZoom();
        stage.classList.add("is-dragging");
      }
    });

    const finish = event => {
      if (!zoom.pointers.has(event.pointerId)) return;

      const drag = zoom.drag;
      zoom.pointers.delete(event.pointerId);
      stage.classList.remove("is-dragging");

      if (zoom.pinch) {
        if (zoom.pointers.size < 2) zoom.pinch = null;

        // Остался один палец — продолжаем перемещение от него.
        if (zoom.pointers.size === 1) {
          const [rest] = [...zoom.pointers.values()];

          zoom.drag = {
            startX: rest.x,
            startY: rest.y,
            originX: zoom.x,
            originY: zoom.y,
            moved: true,
            time: 0,
            onImage: true
          };
        }
        return;
      }

      if (!drag || zoom.pointers.size > 0) return;
      zoom.drag = null;

      if (event.type === "pointercancel") return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      // Свайп влево/вправо листает фото, пока оно не приближено.
      if (
        zoom.scale <= 1.001
        && Math.abs(dx) > 60
        && Math.abs(dx) > Math.abs(dy) * 1.5
      ) {
        moveLightbox(dx < 0 ? 1 : -1);
        return;
      }

      if (drag.moved) return;

      // Двойной тап / двойной клик: приближение и возврат.
      const now = Date.now();
      const last = zoom.lastTap;
      const isDouble =
        now - last.time < 320
        && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30;

      if (isDouble) {
        zoom.lastTap = { time: 0, x: 0, y: 0 };

        if (zoom.scale > 1.05) {
          zoomAt(1);
        } else {
          const point = centerOf(event.clientX, event.clientY);
          zoomAt(2.5, point.x, point.y);
        }
        return;
      }

      zoom.lastTap = { time: now, x: event.clientX, y: event.clientY };

      // Клик по пустому фону (не по фото) закрывает просмотр.
      if (!drag.onImage && zoom.scale <= 1.001) {
        closeDialog($("#photoDialog"));
      }
    };

    stage.addEventListener("pointerup", finish);
    stage.addEventListener("pointercancel", finish);
  }

  /* -------------------- Резервные копии -------------------- */

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);

      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataURL) {
    const parts = String(dataURL).split(",");
    const match = parts[0].match(/data:([^;]+);base64/);

    if (!match) {
      throw new Error("Некорректные данные изображения в резервной копии.");
    }

    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Blob([bytes], { type: match[1] });
  }

  async function exportBackup() {
    if (state.busy) return;

    setBusy(true, "Экспорт архива…");

    try {
      const photos = [];

      for (const photo of state.photos) {
        photos.push({
          ...photo,
          blob: undefined,
          preview: undefined,
          dataURL: await blobToDataURL(photo.blob),
          previewDataURL: photo.preview instanceof Blob
            ? await blobToDataURL(photo.preview)
            : undefined
        });
      }

      const backup = {
        format: CONFIG.backup.format,
        version: CONFIG.backup.version,
        exportedAt: new Date().toISOString(),
        models: state.models,
        sets: state.sets,
        photos
      };

      const blob = new Blob(
        [JSON.stringify(backup)],
        { type: "application/json;charset=utf-8" }
      );

      const date = today();
      downloadBlob(blob, `cosplay-archive-backup-${date}.json`);

      showToast("Резервная копия создана.", "success");
    } catch (error) {
      console.error(error);
      showToast("Не удалось создать резервную копию.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(file) {
    if (!file) return;

    if (state.busy) return;

    if (!confirm(
      "Импорт заменит текущие данные архива данными из резервной копии. Перед продолжением рекомендуется экспортировать текущий архив. Продолжить?"
    )) {
      return;
    }

    setBusy(true, "Импорт архива…");

    try {
      const text = await file.text();
      const backup = JSON.parse(text);

      if (
        backup.format !== CONFIG.backup.format
        || !Array.isArray(backup.models)
        || !Array.isArray(backup.sets)
        || !Array.isArray(backup.photos)
      ) {
        throw new Error("Файл не похож на резервную копию Cosplay Archive.");
      }

      if (backup.models.some(model => !model.id || !model.name)) {
        throw new Error("В резервной копии есть некорректные записи моделей.");
      }

      if (backup.sets.some(set =>
        !set.id || !set.modelId || !set.character
      )) {
        throw new Error("В резервной копии есть некорректные записи сетов.");
      }

      const models = backup.models.map(model => {
        const clean = { ...model };

        if (typeof clean.url === "string" && clean.url) {
          try {
            const parsed = new URL(clean.url);
            if (!["http:", "https:"].includes(parsed.protocol)) {
              clean.url = "";
            }
          } catch {
            clean.url = "";
          }
        }

        return clean;
      });

      const modelIds = new Set(models.map(model => model.id));

      if (backup.sets.some(set => !modelIds.has(set.modelId))) {
        throw new Error("Некоторые сеты ссылаются на отсутствующие модели.");
      }

      const sets = backup.sets.map(set => ({ ...set }));

      const photos = backup.photos.map(photo => {
        if (!photo.id || !photo.dataURL) {
          throw new Error("В резервной копии найдена фотография без данных.");
        }

        const { dataURL, previewDataURL, ...metadata } = photo;
        const blob = dataURLToBlob(dataURL);
        const preview = typeof previewDataURL === "string" && previewDataURL
          ? dataURLToBlob(previewDataURL)
          : null;

        return {
          ...metadata,
          blob,
          preview
        };
      });

      const photoIds = new Set(photos.map(photo => photo.id));

      for (const set of sets) {
        set.photoIds = (set.photoIds || []).filter(id => photoIds.has(id));

        if (set.coverPhotoId && !photoIds.has(set.coverPhotoId)) {
          set.coverPhotoId = set.photoIds[0] || null;
        }
      }

      cleanupObjectURLs();

      await db.replaceAll({
        [CONFIG.stores.models]: models,
        [CONFIG.stores.sets]: sets,
        [CONFIG.stores.photos]: photos
      });

      await refreshData();

      state.selectedModelId = null;
      state.viewedSetId = null;
      state.activeTag = "";

      navigate("models");
      renderAll();

      showToast("Резервная копия успешно импортирована.", "success");

      writeTombstones({ models: [], sets: [], photos: [] });
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      showToast(
        `Импорт не выполнен: ${error.message || "ошибка файла"}`,
        "error"
      );
    } finally {
      setBusy(false);

      const input = $("#importInput");
      if (input) input.value = "";
    }
  }

  /* -------------------- Синхронизация с Google Drive -------------------- */

  const TOMBSTONE_KEY = "cosplay-archive:deleted";
  let autoSyncTimer = null;

  function readTombstones() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TOMBSTONE_KEY));
      return {
        models: Array.isArray(parsed?.models) ? parsed.models : [],
        sets: Array.isArray(parsed?.sets) ? parsed.sets : [],
        photos: Array.isArray(parsed?.photos) ? parsed.photos : []
      };
    } catch {
      return { models: [], sets: [], photos: [] };
    }
  }

  function writeTombstones(data) {
    try {
      localStorage.setItem(TOMBSTONE_KEY, JSON.stringify({
        models: data.models || [],
        sets: data.sets || [],
        photos: data.photos || []
      }));
    } catch {
      /* localStorage может быть недоступен — игнорируем */
    }
  }

  function clearTombstones() {
    try {
      localStorage.removeItem(TOMBSTONE_KEY);
      sessionStorage.removeItem(TOMBSTONE_KEY);
    } catch {}
  }

  function recordDeletion(type, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const data = readTombstones();
    const set = new Set(data[type]);

    for (const id of list) {
      if (id) set.add(id);
    }

    data[type] = [...set];
    writeTombstones(data);
  }

  function emptyManifest() {
    return {
      models: [],
      sets: [],
      photos: [],
      deletions: { models: [], sets: [], photos: [] }
    };
  }

  function mergeDeletions(remoteDeletions = {}, tombstones = {}) {
    const pick = (a, b) => new Set([...(a || []), ...(b || [])]);

    return {
      models: pick(remoteDeletions.models, tombstones.models),
      sets: pick(remoteDeletions.sets, tombstones.sets),
      photos: pick(remoteDeletions.photos, tombstones.photos)
    };
  }

  function mergeRecords(localList, remoteList, timeField) {
    const byId = new Map();

    for (const item of remoteList) {
      if (item?.id) byId.set(item.id, item);
    }

    for (const item of localList) {
      if (!item?.id) continue;

      const existing = byId.get(item.id);

      if (!existing) {
        byId.set(item.id, item);
        continue;
      }

      const localTime =
        Date.parse(item[timeField] || item.createdAt || 0) || 0;
      const remoteTime =
        Date.parse(existing[timeField] || existing.createdAt || 0) || 0;

      if (localTime >= remoteTime) byId.set(item.id, item);
    }

    return [...byId.values()];
  }

  /* -------------------- Мульти-аккаунт (таргеты) -------------------- */

  function providerSupportsTargets(provider) {
    return Boolean(provider && typeof provider.listTargets === "function");
  }

  // Список аккаунтов-назначений провайдера. Если провайдер не умеет
  // несколько аккаунтов — отдаём единственный «виртуальный» таргет.
  function getProviderTargets(provider) {
    if (!provider) return [];
    if (providerSupportsTargets(provider)) {
      try {
        const list = provider.listTargets() || [];
        if (list.length) {
          const activeTarget = typeof provider.getActiveTarget === "function"
            ? provider.getActiveTarget()
            : null;
          if (activeTarget && activeTarget.id) {
            return [
              activeTarget,
              ...list.filter(t => t.id !== activeTarget.id)
            ];
          }
          return list;
        }
      } catch (error) {
        console.warn("Не удалось получить список аккаунтов:", error);
      }
    }
    return [{ id: null, label: provider.label || "Облако" }];
  }

  async function getTargetQuota(provider, targetId) {
    if (!provider || typeof provider.getQuota !== "function") return null;
    const cacheMs = CONFIG.multiAccount?.quotaCacheMs ?? 60000;
    const key = `${provider.id || "p"}::${targetId ?? "a"}`;
    const cached = quotaCache.get(key);
    if (cached && Date.now() - cached.ts < cacheMs) return cached.quota;
    try {
      const quota = await provider.getQuota(targetId);
      quotaCache.set(key, { ts: Date.now(), quota });
      return quota;
    } catch (error) {
      console.warn("Не удалось получить квоту:", provider.id, targetId, error);
      return null;
    }
  }

  // Готовим план по каждому аккаунту: сколько свободно (с учётом лимита).
  async function buildTargetPlans(provider) {
    const reserve = CONFIG.multiAccount?.reserveFreeBytes ?? 250 * 1024 * 1024;
    const targets = getProviderTargets(provider);
    const plans = [];
    for (const target of targets) {
      const quota = await getTargetQuota(provider, target.id);
      let free = null;
      if (quota) {
        const limit = Number(quota.limit || 0);
        const usage = Number(quota.usage || 0);
        if (limit > 0) free = Math.max(0, limit - usage);
      }
      plans.push({ target, free, reserve });
    }
    return plans;
  }

  // Fill-first: заполняем аккаунты по порядку до конца. Возвращаем первый
  // аккаунт, где помещается фото и остаётся резерв 200 МБ.
  function pickTargetForSize(plans, size) {
    if (!plans.length) return null;
    const need = Number(size || 0);
    const fits = plans.filter(
      plan => plan.free === null || plan.free - need >= plan.reserve
    );
    if (!fits.length) return null;
    const strategy = CONFIG.multiAccount?.strategy || "fill";
    if (strategy === "roundrobin") {
      pickTargetForSize._idx = pickTargetForSize._idx || 0;
      const idx = pickTargetForSize._idx % fits.length;
      pickTargetForSize._idx += 1;
      return fits[idx];
    }
    return fits[0];
  }

  function targetLabel(provider, targetId) {
    if (targetId == null) return provider?.label || "Облако";
    const target = getProviderTargets(provider).find(t => t.id === targetId);
    return target?.label || target?.email || provider?.label || "Аккаунт";
  }

  function updateDriveUI() {
    const bar = $("#driveBar");
    if (!bar) return;

    const connectBtn = $("#driveConnectBtn");
    const syncBtn = $("#driveSyncBtn");
    const signOutBtn = $("#driveSignOutBtn");
    const status = $("#driveStatus");
    const providerSelect = $("#driveProviderSelect");

    refreshActiveProvider();

    const configured = Boolean(drive && drive.isConfigured());
    const signedIn = Boolean(drive && drive.hasToken());
    const label = drive?.label || "Облако";

    state.drive.configured = configured;
    state.drive.signedIn = signedIn;

    // Заполняем селектор провайдерами.
    if (providerSelect && providers) {
      const configuredIds = providers.list().filter(id => {
        const p = providers.get(id);
        return p && p.isConfigured();
      });

      if (configuredIds.length > 1) {
        providerSelect.classList.remove("hidden");
        providerSelect.innerHTML = configuredIds.map(id => {
          const p = providers.get(id);
          const selected = id === providers.activeId() ? "selected" : "";
          return `<option value="${escapeHTML(id)}" ${selected}>${escapeHTML(p.label || id)}</option>`;
        }).join("");
      } else {
        providerSelect.classList.add("hidden");
      }
    }

    // Список аккаунтов (мульти-аккаунт) и кнопка добавления.
    const accountsEl = $("#driveAccounts");
    const addAccountBtn = $("#driveAddAccountBtn");
    const multi = Boolean(drive && providerSupportsTargets(drive));

    if (accountsEl) {
      if (multi && drive) {
        const targets = getProviderTargets(drive);
        const activeTarget = typeof drive.getActiveTarget === "function"
          ? drive.getActiveTarget()
          : null;
        const activeTid = activeTarget ? activeTarget.id : null;

        accountsEl.classList.toggle("hidden", !targets.length);
        accountsEl.innerHTML = targets.map(target => {
          const active = target.id === activeTid ? " is-active" : "";
          const tidAttr = escapeHTML(String(target.id));
          const name = escapeHTML(target.email || target.label || "Аккаунт");
          return `<span class="drive-account${active}">
            <button type="button" class="drive-account-pick" data-pick="${tidAttr}" title="Сделать активным">${name}</button>
            <button type="button" class="drive-account-remove" data-remove="${tidAttr}" title="Удалить аккаунт">×</button>
          </span>`;
        }).join("");
      } else {
        accountsEl.classList.add("hidden");
        accountsEl.innerHTML = "";
      }
    }

    if (addAccountBtn) {
      addAccountBtn.classList.toggle("hidden", !(multi && configured && signedIn));
    }

    bar.classList.toggle("hidden", !drive);

    connectBtn?.classList.toggle("hidden", !configured || signedIn);
    syncBtn?.classList.toggle("hidden", !signedIn);
    signOutBtn?.classList.toggle("hidden", !signedIn);

    if (syncBtn) syncBtn.disabled = state.drive.syncing;

    if (!status) return;

    status.classList.remove("is-error");
    let text = "";

    if (!configured) {
      text = `${label}: укажите ключи в js/config.js.`;
    } else if (state.drive.syncing) {
      text = "Синхронизация…";
    } else if (state.drive.error) {
      text = `${label}: ${state.drive.error}`;
      status.classList.add("is-error");
    } else if (signedIn) {
      const time = state.drive.lastSyncAt
        ? new Date(state.drive.lastSyncAt).toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit"
          })
        : "";
      text = time
        ? `${label} подключён · синхронизировано в ${time}`
        : `${label} подключён`;
    } else {
      text = `${label} не подключён.`;
    }

    status.textContent = text;
  }

  function scheduleAutoSync() {
    if (!drive || !drive.isConfigured() || !drive.hasToken()) return;
    const providerCfg = CONFIG.providers?.[providers?.activeId() || "gdrive"];
    if (!providerCfg?.enabled || !providerCfg?.autoSync) return;

    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      syncNow({ silent: true });
    }, providerCfg.autoSyncDelayMs || 4000);
  }

  async function driveConnect(addNew = false) {
    if (!drive || !drive.isConfigured()) {
      showToast("Сначала укажите ключи провайдера в js/config.js.", "error");
      return;
    }

    const label = drive.label || "Облако";

    try {
      if (addNew) {
        await drive.connect(undefined, true);
      } else {
        await drive.connect();
      }
      quotaCache.clear();
      state.drive.error = "";
      updateDriveUI();
      await refreshData();
      renderAll();
      showToast(`${label} подключён.`, "success");
      await syncNow({ silent: true });
    } catch (error) {
      console.error(error);
      state.drive.error = error.message || "ошибка авторизации";
      updateDriveUI();
      renderAll();
      showToast(`Не удалось подключить ${label}: ${error.message}`, "error");
    }
  }

  async function driveSignOut() {
    drive?.signOut();
    quotaCache.clear();
    state.drive.lastSyncAt = null;
    state.drive.error = "";

    // При выходе из аккаунта очищаем локальную базу и память, чтобы фото не оставались на устройстве
    try {
      await db.clearAll();
      clearTombstones();
    } catch (e) {
      console.warn("Ошибка очистки базы данных:", e);
    }

    state.models = [];
    state.sets = [];
    state.photos = [];
    cleanupObjectURLs();

    updateDriveUI();
    renderAll();
    showToast(`${drive?.label || "Облако"} отключён. Фотографии скрыты.`);
  }

  async function syncNow(options = {}) {
    const { silent = false } = options;

    refreshActiveProvider();

    if (!drive || !drive.isConfigured()) {
      if (!silent) {
        showToast("Сначала укажите ключи провайдера в js/config.js.", "error");
      }
      return;
    }

    if (state.drive.syncing) return;

    if (!drive.hasToken()) {
      const ok = await drive.trySilentConnect();
      updateDriveUI();

      if (!ok) {
        if (!silent) showToast(`Подключите ${drive.label || "облако"}.`, "error");
        return;
      }
    }

    const providerLabel = drive.label || "облако";
    state.drive.syncing = true;
    state.drive.error = "";
    updateDriveUI();
    if (!silent) {
      showProgress(`Синхронизация с ${providerLabel}…`);
    }

    try {
      await drive.ensureFolders();

      const remoteManifest = (await drive.getManifest()) || emptyManifest();

      const targetList = getProviderTargets(drive);
      const remotePhotoMap = new Map();
      for (const target of targetList) {
        try {
          const map = await drive.listPhotos(target.id);
          for (const [name, file] of map) {
            if (!remotePhotoMap.has(name)) {
              remotePhotoMap.set(name, { file, targetId: target.id });
            }
          }
        } catch (error) {
          console.warn("Не удалось получить список фото для аккаунта:", target.id, error);
        }
      }

      const tombstones = readTombstones();
      const deleted = mergeDeletions(remoteManifest.deletions, tombstones);

      // Физически удаляем файлы удалённых фото из облака, освобождая квоту хранилища
      if (typeof drive.deleteFile === "function") {
        for (const deletedPhotoId of deleted.photos) {
          const entry = remotePhotoMap.get(deletedPhotoId);
          if (entry?.file?.id) {
            try {
              await drive.deleteFile(entry.file.id, entry.targetId);
              remotePhotoMap.delete(deletedPhotoId);
            } catch (delError) {
              console.warn("Не удалось удалить файл из облака:", deletedPhotoId, delError);
            }
          }
        }
      }

      const localModels = state.models.filter(m => !deleted.models.has(m.id));
      const localSets = state.sets.filter(s => !deleted.sets.has(s.id));
      const localPhotos = state.photos.filter(p => !deleted.photos.has(p.id));

      const remoteModels = (remoteManifest.models || [])
        .filter(m => !deleted.models.has(m.id));
      const remoteSets = (remoteManifest.sets || [])
        .filter(s => !deleted.sets.has(s.id));
      const remotePhotos = (remoteManifest.photos || [])
        .filter(p => !deleted.photos.has(p.id));

      const models = mergeRecords(localModels, remoteModels, "updatedAt");
      const sets = mergeRecords(localSets, remoteSets, "updatedAt");

      const localPhotoById = new Map(localPhotos.map(p => [p.id, p]));
      const remotePhotoById = new Map(remotePhotos.map(p => [p.id, p]));
      const photoIds = new Set([
        ...localPhotoById.keys(),
        ...remotePhotoById.keys()
      ]);

      const photos = [];
      const manifestPhotos = [];
      const uploadErrors = [];
      let plans = [];
      try {
        plans = await buildTargetPlans(drive);
      } catch (error) {
        console.warn("Не удалось построить план таргетов:", error);
      }

      // Подсчитываем, сколько новых фото реально предстоит выгрузить в облако
      const photosToUpload = [];
      for (const id of photoIds) {
        const local = localPhotoById.get(id);
        const existingEntry = remotePhotoMap.get(id);
        const hasBlob = (local?.blob instanceof Blob) || (typeof local?.dataURL === "string" && local.dataURL);
        if (hasBlob && !existingEntry?.file) {
          photosToUpload.push(id);
        }
      }

      if (photosToUpload.length > 0) {
        showHUD({
          title: `Выгрузка в ${providerLabel}`,
          subtitle: `Подготовка 0 из ${photosToUpload.length} фото…`,
          current: 0,
          total: photosToUpload.length,
          icon: "☁️"
        });
      }

      let uploadedCounter = 0;

      // Определяем все ID фотографий, которые являются обложками моделей или сетов
      const coverPhotoIds = new Set();
      for (const m of models) {
        if (m.coverPhotoId) coverPhotoIds.add(m.coverPhotoId);
      }
      for (const s of sets) {
        if (s.coverPhotoId) {
          coverPhotoIds.add(s.coverPhotoId);
        } else if (Array.isArray(s.photoIds) && s.photoIds.length > 0) {
          coverPhotoIds.add(s.photoIds[0]);
        }
      }

      for (const id of photoIds) {
        const local = localPhotoById.get(id);
        const remote = remotePhotoById.get(id);
        const meta = { ...(remote || {}), ...(local || {}) };

        delete meta.blob;
        delete meta.dataURL;
        delete meta.preview;

        // Восстанавливаем картинку по цепочке: локальный blob →
        // сохранённый dataURL → скачивание с Google Drive.
        let blob = local?.blob instanceof Blob ? local.blob : null;
        let previewBlob = local?.preview instanceof Blob
          ? local.preview
          : null;

        // Если локально нет превью, но в облачном манифесте сохранена DataURL-копия превью — восстанавливаем её!
        if (!previewBlob && remote?.previewDataURL) {
          try {
            previewBlob = dataURLToBlob(remote.previewDataURL);
          } catch {}
        }

        if (!blob && typeof local?.dataURL === "string" && local.dataURL) {
          try {
            blob = dataURLToBlob(local.dataURL);
          } catch (error) {
            console.warn("Не удалось восстановить фото из dataURL:", id, error);
          }
        }

        const existingEntry = remotePhotoMap.get(id) || null;
        const existingFile = existingEntry?.file || null;

        let driveFileId =
          remote?.driveFileId || local?.driveFileId || existingFile?.id || null;
        let providerTargetId =
          existingEntry?.targetId ??
          remote?.providerTargetId ??
          local?.providerTargetId ??
          null;

        const isCover = coverPhotoIds.has(id);

        // В Cloud-First режиме: если фото уже в облаке, не скачиваем его оригинал в память устройства,
        // НО ДЛЯ ОБЛОЖЕК ОБЯЗАТЕЛЬНО СКАЧИВАЕМ ОРИГИНАЛ (Ultra-HD), ЧТОБЫ КАТАЛОГ БЫЛ МАКСИМАЛЬНО ЧЕТКИМ!
        const downloadOriginals = CONFIG.cloudFirst?.downloadOriginalsOnSync ?? false;

        if (!blob && driveFileId && (isCover || downloadOriginals)) {
          try {
            blob = await drive.downloadFile(driveFileId, providerTargetId);
          } catch (error) {
            console.warn("Не удалось скачать фото с Drive:", id, error);
          }
        }

        if (blob) {
          const mimeType = meta.type || blob.type || "image/webp";

          try {
            if (existingFile) {
              driveFileId = existingFile.id;
              providerTargetId = providerTargetId ?? existingEntry?.targetId ?? null;
            } else {
              let uploaded = false;
              while (!uploaded) {
                const plan = pickTargetForSize(plans, blob.size || 0);
                if (!plan) {
                  const reserveMb = Math.round((CONFIG.multiAccount?.reserveFreeBytes ?? 250 * 1024 * 1024) / (1024 * 1024));
                  throw new Error(`не хватает места на подключённых аккаунтах (резерв ${reserveMb} МБ)`);
                }
                const tid = plan.target.id ?? null;
                try {
                  driveFileId = await drive.uploadPhoto(id, blob, mimeType, null, tid);
                  providerTargetId = tid;
                  if (plan.free !== null) {
                    plan.free = Math.max(0, plan.free - (blob.size || 0));
                  }
                  uploaded = true;
                  uploadedCounter++;
                  updateHUD({
                    subtitle: `Выгружено ${uploadedCounter} из ${photosToUpload.length} фото…`,
                    current: uploadedCounter,
                    total: photosToUpload.length
                  });
                } catch (uploadErr) {
                  const msg = String(uploadErr.message || "");
                  if (msg.includes("storageQuotaExceeded") || msg.includes("quota") || msg.includes("insufficientFileStorageQuota")) {
                    console.warn(`Аккаунт ${targetLabel(drive, tid)} переполнен при загрузке, переключаемся на следующий.`, uploadErr);
                    plan.free = 0;
                    continue;
                  }
                  throw uploadErr;
                }
              }
            }
          } catch (error) {
            uploadErrors.push(id);
            console.warn("Не удалось выгрузить фото в облако:", id, error);
          }
        }

        // В Cloud-First режиме: если фото загружено в Google Drive,
        // освобождаем тяжелый локальный оригинал из памяти устройства,
        // НО ДЛЯ ОБЛОЖЕК МОДЕЛЕЙ И СЕТОВ СОХРАНЯЕМ ОРИГИНАЛЬНЫЙ BLOB ВСЕГДА!
        const purgeOriginals = CONFIG.cloudFirst?.purgeOriginalsAfterUpload ?? true;
        const keepLocalBlob = (driveFileId && purgeOriginals && !isCover) ? null : blob;

        const record = { ...meta };

        if (keepLocalBlob) record.blob = keepLocalBlob;
        if (previewBlob) record.preview = previewBlob;
        if (driveFileId) record.driveFileId = driveFileId;
        // provider: сохраняем активный провайдер фото.
        record.provider = drive.id || record.provider;
        if (providerTargetId != null) record.providerTargetId = providerTargetId;

        photos.push(record);

        const manifestMeta = { ...meta, provider: drive.id || meta.provider };
        if (driveFileId) manifestMeta.driveFileId = driveFileId;
        if (providerTargetId != null) manifestMeta.providerTargetId = providerTargetId;
        if (previewBlob && !manifestMeta.previewDataURL) {
          try {
            manifestMeta.previewDataURL = await blobToDataURL(previewBlob);
          } catch {}
        }
        manifestPhotos.push(manifestMeta);
      }

      const modelIds = new Set(models.map(m => m.id));
      const validPhotoIds = new Set(manifestPhotos.map(p => p.id));

      const cleanSets = sets
        .filter(s => modelIds.has(s.modelId))
        .map(s => {
          const photoIds = (s.photoIds || [])
            .filter(id => validPhotoIds.has(id));

          const cover = s.coverPhotoId && photoIds.includes(s.coverPhotoId)
            ? s.coverPhotoId
            : photoIds[0] || null;

          return { ...s, photoIds, coverPhotoId: cover };
        });

      const manifest = {
        format: "cosplay-archive-drive",
        version: 1,
        exportedAt: new Date().toISOString(),
        provider: drive.id,
        models,
        sets: cleanSets,
        photos: manifestPhotos,
        deletions: {
          models: [...deleted.models],
          sets: [...deleted.sets],
          photos: [...deleted.photos]
        }
      };

      cleanupObjectURLs();

      await db.replaceAll({
        [CONFIG.stores.models]: models,
        [CONFIG.stores.sets]: cleanSets,
        [CONFIG.stores.photos]: photos
      });

      writeTombstones({ models: [], sets: [], photos: [] });

      const targetListForSave = getProviderTargets(drive);
      if (targetListForSave.length > 0) {
        for (const target of targetListForSave) {
          try {
            await drive.saveManifest(manifest, target.id);
          } catch (error) {
            console.warn("Не удалось сохранить манифест для аккаунта:", target.id, error);
          }
        }
      } else {
        await drive.saveManifest(manifest);
      }

      await refreshData();
      renderAll();
      setTimeout(ensureHighResCovers, 50);

      state.drive.lastSyncAt = new Date().toISOString();

      if (uploadErrors.length) {
        state.drive.error = `не выгружено фото: ${uploadErrors.length}`;
        if (!silent) {
          showToast(
            `Синхронизация прошла, но ${uploadErrors.length} фото не загрузились — повторите позже.`,
            "error"
          );
        }
      } else if (!silent) {
        showToast("Синхронизация завершена.", "success");
      }

      if (photosToUpload.length > 0) {
        showHUD({
          title: "Синхронизация завершена",
          subtitle: `Все ${photosToUpload.length} фото выгружены в ${providerLabel}!`,
          percent: 100,
          icon: "✓"
        });
        hideHUD(2200);
      }
    } catch (error) {
      console.error(error);
      state.drive.error = error.message || "ошибка синхронизации";
      hideHUD(0);

      if (!silent) {
        showToast(`Синхронизация не удалась: ${error.message}`, "error");
      }
    } finally {
      quotaCache.clear();
      state.drive.syncing = false;
      hideProgress();
      hideHUD(800);
      updateDriveUI();
    }
  }

   function initDrive() {
    refreshActiveProvider();

    if (providers) {
      for (const id of providers.list()) {
        const p = providers.get(id);
        const cfg = CONFIG.providers?.[id];
        if (cfg && p && typeof p.configure === "function") {
          p.configure(cfg);
        }
      }
    }

    if (!drive || (drive.id === "gdrive" && !CONFIG.providers?.gdrive?.enabled && CONFIG.providers?.dropbox?.enabled)) {
      // Попробуем переключиться, если gdrive выключен, а dropbox включен.
      if (CONFIG.providers?.dropbox?.enabled) {
        providers?.setActive("dropbox");
        refreshActiveProvider();
      }
    }

    if (!drive) {
      $("#driveBar")?.classList.add("hidden");
      return;
    }

    const cfg = CONFIG.providers?.[drive.id];
    if (cfg && typeof drive.configure === "function") {
      drive.configure(cfg);
    }
    updateDriveUI();

    if (drive.isConfigured()) {
      drive.trySilentConnect().then(async ok => {
        updateDriveUI();
        if (ok) {
          await refreshData();
          renderAll();
          syncNow({ silent: true });
        } else {
          if (!isUserAuthenticated()) {
            state.models = [];
            state.sets = [];
            state.photos = [];
          }
          renderAll();
        }
      });
    }
  }

  // Освободить память устройства: удалить локальные копии оригиналов, которые уже есть на Google Диске
  async function purgeLocalOriginals() {
    let freedBytes = 0;
    let purgedCount = 0;

    for (const photo of state.photos) {
      if (photo.driveFileId && (photo.blob instanceof Blob)) {
        freedBytes += photo.blob.size || 0;
        delete photo.blob;
        await db.put(CONFIG.stores.photos, photo);
        purgedCount += 1;
      }
    }

    cleanupObjectURLs();
    renderAll();

    const freedMb = (freedBytes / (1024 * 1024)).toFixed(1);
    if (purgedCount > 0) {
      showToast(`Освобождено ${freedMb} МБ (${purgedCount} фото сохранены в Google Drive).`, "success");
    } else {
      showToast("Все загруженные оригиналы уже находятся в Google Drive, память чиста.");
    }
  }

  /* -------------------- Случайный сет -------------------- */

  function openRandomSet() {
    if (!state.sets.length) {
      showToast("Сначала добавь хотя бы один сет.");
      return;
    }

    const set = state.sets[Math.floor(Math.random() * state.sets.length)];

    navigate("set-detail", set.id);
  }

  /* -------------------- Обработчики интерфейса -------------------- */

  function handleAction(action, element) {
    const id = element.dataset.id;
    const tag = element.dataset.tag;

    if (action === "toggle-card-menu") {
      const wrap = element.closest(".card-menu-wrap");
      const willOpen = !wrap?.classList.contains("is-open");

      closeCardMenus();

      if (wrap && willOpen) {
        wrap.classList.add("is-open");
        element.setAttribute("aria-expanded", "true");
      }

      return;
    }

    closeCardMenus();

    switch (action) {
      case "add-model":
        openModelForm();
        break;

      case "edit-model":
        openModelForm(getModel(id));
        break;

      case "delete-model":
        deleteModel(id);
        break;

      case "open-model":
        navigate("model-detail", id);
        break;

      case "add-set":
        openSetForm();
        break;

      case "add-set-model":
        openSetForm(null, id || state.selectedModelId);
        break;

      case "edit-set":
        openSetForm(getSet(id));
        break;

      case "view-set":
        navigate("set-detail", id);
        break;

      case "delete-set":
        deleteSet(id);
        break;

      case "favorite-set":
        toggleFavorite(id);
        break;

      case "upload-photos":
        openMassUploadDialog(id);
        break;

      case "remove-mass-photo":
        removeMassPhoto(id);
        break;

      case "filter-tag": {
        const clickedTag = (element.dataset.tag || "").trim().replace(/^#+/, "");
        if (state.activeTag && state.activeTag.toLowerCase() === clickedTag.toLowerCase()) {
          state.activeTag = "";
        } else {
          state.activeTag = clickedTag;
        }

        if (state.page !== "sets") {
          navigate("sets");
        } else {
          renderTagChips();
          renderSets();
        }
        break;
      }

      case "clear-active-tag":
        state.activeTag = "";
        renderTagChips();
        renderSets();
        break;

      case "remove-draft-photo":
        removeDraftPhoto(id);
        break;

      case "toggle-select-draft-photo":
        if (state.draftSelectedPhotoIds.has(id)) {
          state.draftSelectedPhotoIds.delete(id);
        } else {
          state.draftSelectedPhotoIds.add(id);
        }
        renderDraftPhotos();
        break;

      case "move-draft-photo": {
        const dir = Number(element.dataset.dir || 0);
        moveDraftPhoto(id, dir);
        break;
      }

      case "set-cover":
        state.draftCoverPhotoId = id;
        renderDraftPhotos();
        break;

      case "select-model-cover-photo": {
        state.draftModelCoverPhotoId = id;
        const model = getModel($("#modelId")?.value);
        updateModelCoverUI(model);
        renderModelSetGallery(model);
        break;
      }

      case "lightbox": {
        const setId = state.viewedSetId;
        const index = Number(element.dataset.index || 0);
        openLightbox(setId, index);
        break;
      }

      case "close-lightbox":
        closeDialog($("#photoDialog"));
        break;

      case "previous-photo":
        moveLightbox(-1);
        break;

      case "next-photo":
        moveLightbox(1);
        break;

      case "zoom-in":
        zoomBy(1.5);
        break;

      case "zoom-out":
        zoomBy(1 / 1.5);
        break;

      case "zoom-reset":
        zoomAt(1);
        break;

      case "fullscreen-toggle":
        toggleFullscreen();
        break;

      case "download-photo":
        downloadCurrentPhoto();
        break;

      case "download-set":
        downloadSetPhotos(getSet(id));
        break;
    }
  }

  function bindEvents() {
    // Навигация между основными разделами.
    $$("[data-page]").forEach(button => {
      button.addEventListener("click", () => {
        navigate(button.dataset.page);
      });
    });

    // Кнопки добавления: поддерживаем несколько распространённых ID.
    const addModelButton =
      $("#addModelBtn") || $("#addModelButton");

    const addSetButton =
      $("#addSetBtn") || $("#addSetButton");

    addModelButton?.addEventListener("click", () => openModelForm());
    addSetButton?.addEventListener("click", () => openSetForm());

    $("#addSetForModelBtn")?.addEventListener("click", () => {
      openSetForm(null, state.selectedModelId);
    });

    // Верхняя кнопка «+ Добавить»: открывает форму по текущему контексту.
    $("#addMainBtn")?.addEventListener("click", () => {
      if (state.page === "sets") {
        openSetForm();
      } else if (
        (state.page === "model-detail" || state.page === "set-detail")
        && state.selectedModelId
      ) {
        openSetForm(null, state.selectedModelId);
      } else {
        openModelForm();
      }
    });

    $("#backToModels")?.addEventListener("click", () => {
      navigate("models");
    });

    // Поиск и сортировка.
    $("#modelSearch")?.addEventListener("input", renderModels);
    $("#modelSort")?.addEventListener("change", renderModels);

    $("#setSearch")?.addEventListener("input", renderSets);
    $("#setModelFilter")?.addEventListener("change", renderSets);
    $("#setSort")?.addEventListener("change", () => {
      renderSets();

      if (state.page === "model-detail") {
        renderModelDetail();
      }
    });

    $("#favoritesOnly")?.addEventListener("change", renderSets);

    // Кнопки закрытия диалогов (крестик и «Отмена»).
    $$('[data-close]').forEach(button => {
      button.addEventListener("click", () => {
        requestCloseDialog(button.dataset.close);
      });
    });

    // Формы.
    // Автозаполнение адресов, пока пользователь не правил их вручную.
    $("#modelName")?.addEventListener("input", () => {
      const input = $("#modelSlug");
      if (input && !input.dataset.touched) {
        input.value = slugify($("#modelName").value);
      }
      updateSlugHints();
      const model = getModel($("#modelId")?.value);
      updateModelCoverUI(model);
    });

    $("#modelSlug")?.addEventListener("input", () => {
      $("#modelSlug").dataset.touched = "1";
      updateSlugHints();
    });

    const syncSetSlug = () => {
      const input = $("#setSlug");
      if (input && !input.dataset.touched) {
        input.value = slugify($("#setTitle").value || $("#setCharacter").value);
      }
      updateSlugHints();
    };

    $("#setTitle")?.addEventListener("input", syncSetSlug);
    $("#setCharacter")?.addEventListener("input", syncSetSlug);
    $("#setModelId")?.addEventListener("change", updateSlugHints);
    $("#setSlug")?.addEventListener("input", () => {
      $("#setSlug").dataset.touched = "1";
      updateSlugHints();
    });

    $("#modelForm")?.addEventListener("submit", saveModel);
    $("#setForm")?.addEventListener("submit", saveSet);

    // Выбор и загрузка обложки модели в форме
    $("#modelCoverFileInput")?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (file) handleModelCoverFile(file);
      event.target.value = "";
    });

    $("#modelCoverResetBtn")?.addEventListener("click", () => {
      state.draftModelCoverPhotoId = null;
      const model = getModel($("#modelId")?.value);
      updateModelCoverUI(model);
      renderModelSetGallery(model);
    });

    // Выбор и загрузка обложки сета в форме
    $("#setDirectCoverUpload")?.addEventListener("change", async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        showHUD({
          title: "Загрузка обложки",
          subtitle: file.name,
          percent: 50,
          icon: "📷"
        });
        const prepared = await prepareImage(file);
        state.draftNewPhotos.unshift(prepared);
        state.draftPhotoList.unshift(prepared);
        const temporaryUrl = URL.createObjectURL(prepared.blob);
        state.objectURLs.set(prepared.id, temporaryUrl);
        state.draftCoverPhotoId = prepared.id;
        renderDraftPhotos();
        hideHUD(500);
        showToast("Обложка фотосета установлена!", "success");
      } catch (err) {
        console.error(err);
        hideHUD(0);
        showToast("Не удалось обработать файл обложки.", "error");
      } finally {
        event.target.value = "";
      }
    });

    $("#setResetCoverBtn")?.addEventListener("click", () => {
      state.draftCoverPhotoId = null;
      renderDraftPhotos();
      showToast("Обложка сброшена на 1-е фото", "info");
    });

    // Управление фотографиями в редакторе: сортировка и массовые действия
    $("#sortByNameBtn")?.addEventListener("click", sortDraftPhotosByName);
    $("#selectAllPhotosBtn")?.addEventListener("click", toggleSelectAllDraftPhotos);
    $("#deleteSelectedPhotosBtn")?.addEventListener("click", removeSelectedDraftPhotos);

    // Блокировка сайта и экран PIN-кода
    $("#lockNowBtn")?.addEventListener("click", lockApp);
    $("#privacyToggleBtn")?.addEventListener("click", lockApp);
    $("#securitySettingsBtn")?.addEventListener("click", openSecuritySettings);
    $("#footerSecurityBtn")?.addEventListener("click", openSecuritySettings);
    $("#securitySettingsCloseBtn")?.addEventListener("click", () => {
      closeDialog($("#securitySettingsDialog"));
    });

    // Нажатия на клавиши PIN клавиатуры
    $$(".pin-key[data-digit]").forEach(btn => {
      btn.addEventListener("click", () => {
        handlePinInput(btn.dataset.digit);
      });
    });

    $("#pinBackspaceBtn")?.addEventListener("click", handlePinBackspace);
    $("#pinClearBtn")?.addEventListener("click", handlePinClear);

    // Действия на экране блокировки
    $("#pinSetupLaterBtn")?.addEventListener("click", () => {
      unlockApp();
      showToast("Вход выполнен. Задать PIN-код можно в «🛡️ Защита».", "info");
    });

    $("#pinForgotBtn")?.addEventListener("click", resetPin);

    // Управление в диалоге настроек
    $("#settingsSetPinBtn")?.addEventListener("click", () => {
      closeDialog($("#securitySettingsDialog"));
      state.pinMode = "setup";
      state.pinSetupStep = 1;
      state.pinSetupFirst = null;
      lockApp();
      state.pinMode = "setup";
      updatePinScreenUI();
    });

    $("#settingsRemovePinBtn")?.addEventListener("click", () => {
      if (confirm("Удалить PIN-код? Доступ к сайту на этом устройстве больше не будет требовать PIN.")) {
        localStorage.removeItem("ca_pin_hash");
        localStorage.removeItem("ca_pin_salt");
        state.hasPin = false;
        showToast("PIN-код удалён.", "info");
        updateSecuritySettingsUI();
      }
    });

    $("#settingsAutolockBlur")?.addEventListener("change", event => {
      state.autolockBlur = event.target.checked;
      localStorage.setItem("ca_autolock_blur", state.autolockBlur ? "true" : "false");
    });

    $("#settingsDisguiseToggle")?.addEventListener("change", event => {
      state.disguiseActive = event.target.checked;
      localStorage.setItem("ca_disguise_mode", state.disguiseActive ? "true" : "false");
      applyCamouflage();
      updatePinScreenUI();
    });

    $("#settingsDisguisePreset")?.addEventListener("change", event => {
      state.disguisePreset = event.target.value;
      localStorage.setItem("ca_disguise_preset", state.disguisePreset);
      $("#settingsCustomTitleWrap")?.classList.toggle("hidden", state.disguisePreset !== "custom");
      applyCamouflage();
      updatePinScreenUI();
    });

    $("#settingsCustomTitle")?.addEventListener("input", event => {
      state.customTitle = event.target.value;
      localStorage.setItem("ca_custom_title", state.customTitle);
      applyCamouflage();
    });

    updateModelTagSuggestions = setupTagSuggestions(
      "#modelTags",
      "#modelTagSuggestionsWrap",
      "#modelTagSuggestions"
    );
    updateSetTagSuggestions = setupTagSuggestions(
      "#setTags",
      "#setTagSuggestionsWrap",
      "#setTagSuggestions"
    );

    $("#setPhotos")?.addEventListener("change", event => {
      addSelectedPhotos(event.target.files);
    });

    // Массовая загрузка фотографий.
    $("#massUploadOpenBtn")?.addEventListener("click", () => {
      openMassUploadDialog(
        state.page === "set-detail" ? state.viewedSetId : null
      );
    });

    $("#massUploadForm")?.addEventListener("submit", saveMassUpload);

    $("#massUploadInput")?.addEventListener("change", event => {
      addMassPhotos(event.target.files);
    });

    $("#massUploadSetFilter")?.addEventListener("input", renderMassTargets);

    $("#massUploadSet")?.addEventListener("change", event => {
      state.massUploadTargetSetId = event.target.value || null;
    });

    $("#massUploadDialog")?.addEventListener("close", resetMassUploadState);

    // Вставка изображений из буфера обмена (Ctrl+V) в открытой форме.
    document.addEventListener("paste", event => {
      const setDialogOpen = $("#setDialog")?.open;
      const massDialogOpen = $("#massUploadDialog")?.open;

      if (!setDialogOpen && !massDialogOpen) return;

      const items = [...(event.clipboardData?.items || [])];
      const files = items
        .filter(item => item.kind === "file" && item.type.startsWith("image/"))
        .map(item => item.getAsFile())
        .filter(Boolean);

      if (!files.length) return;

      event.preventDefault();

      if (setDialogOpen) {
        addSelectedPhotos(files);
      } else {
        addMassPhotos(files);
      }
    });

    // Перетаскивание файлов в панели фотографий.
    bindDropZone(document.querySelector("#setDialog .upload-panel"), addSelectedPhotos);
    bindDropZone($("#massUploadDrop"), addMassPhotos);

    // Переключение видимости пароля от архива
    $("#archivePasswordToggle")?.addEventListener("click", () => {
      const input = $("#archivePasswordInput");
      if (!input) return;
      const isText = input.type === "text";
      input.type = isText ? "password" : "text";
      const btn = $("#archivePasswordToggle");
      if (btn) btn.textContent = isText ? "👁" : "👁‍🗨";
    });

    // Перетаскивание архивов (.zip / .rar) и фото на всё окно сайта
    window.addEventListener("dragover", event => {
      if (event.dataTransfer?.types?.includes("Files")) {
        event.preventDefault();
      }
    });

    window.addEventListener("drop", event => {
      if (event.target.closest(".upload-panel") || event.target.closest("#archivePasswordDialog")) return;

      const files = [...(event.dataTransfer?.files || [])]
        .filter(file => file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|avif|zip|rar)$/i.test(file.name));

      if (!files.length) return;
      event.preventDefault();

      const setDialogOpen = $("#setDialog")?.open;
      const massDialogOpen = $("#massUploadDialog")?.open;

      if (setDialogOpen) {
        addSelectedPhotos(files);
      } else if (massDialogOpen) {
        addMassPhotos(files);
      } else {
        if (!state.models.length) {
          showToast("Сначала добавь хотя бы одну модель.", "error");
          openModelForm();
          return;
        }
        openSetForm(null, state.selectedModelId);
        setTimeout(() => addSelectedPhotos(files), 150);
      }
    });

    // Очистка памяти устройства от оригиналов (они хранятся в Google Drive)
    $("#purgeStorageBtn")?.addEventListener("click", purgeLocalOriginals);

    // Резервные копии.
    $("#backupBtn")?.addEventListener("click", exportBackup);

    $("#importInput")?.addEventListener("change", event => {
      importBackup(event.target.files?.[0]);
    });

    // Синхронизация с облаком и экран блокировки.
    $("#gateLoginBtn")?.addEventListener("click", () => driveConnect(false));
    $("#driveConnectBtn")?.addEventListener("click", () => driveConnect(false));
    $("#driveAddAccountBtn")?.addEventListener("click", () => driveConnect(true));
    $("#driveSyncBtn")?.addEventListener("click", () => syncNow());
    $("#driveSignOutBtn")?.addEventListener("click", driveSignOut);
    $("#driveAccounts")?.addEventListener("click", event => {
      const pick = event.target.closest("[data-pick]");
      const remove = event.target.closest("[data-remove]");

      if (remove) {
        const tid = remove.getAttribute("data-remove");
        drive?.signOut?.(tid === "null" ? null : tid);
        quotaCache.clear();
        state.drive.lastSyncAt = null;
        if (!isUserAuthenticated()) {
          driveSignOut();
        } else {
          updateDriveUI();
          renderAll();
        }
        return;
      }

      if (pick && drive?.setActiveTarget) {
        const tid = pick.getAttribute("data-pick");
        drive.setActiveTarget(tid === "null" ? null : tid);
        updateDriveUI();
      }
    });
    $("#driveProviderSelect")?.addEventListener("change", event => {
      const id = event.target.value;
      if (providers && id && providers.list().includes(id)) {
        providers.setActive(id);
        refreshActiveProvider();
        quotaCache.clear();
        state.drive.lastSyncAt = null;
        state.drive.error = "";
        updateDriveUI();
      }
    });

    // Случайный сет: используем ID, если он существует,
    // иначе ищем кнопку по тексту.
    const randomButton =
      $("#randomSetBtn")
      || $("#randomBtn")
      || $$("button").find(button =>
        normalize(button.textContent).includes("случайный сет")
      );

    randomButton?.addEventListener("click", openRandomSet);

    // Делегирование кликов по динамическим карточкам и галереям.
    document.addEventListener("click", event => {
      // Ctrl/Cmd/Shift-клик и средняя кнопка по ссылкам — открытие в новой вкладке.
      if (
        event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
      ) {
        if (event.target.closest("a[href]")) return;
      }

      const element = event.target.closest("[data-action]");

      if (!element) {
        closeCardMenus();
        return;
      }

      // Ссылки на внешние профили не должны перехватываться.
      if (element.tagName === "A") return;

      // Клик по вложенной ссылке или полю внутри карточки не должен
      // открывать саму карточку.
      const nestedControl = event.target.closest(
        "a, input, select, textarea, label"
      );

      if (nestedControl && element.contains(nestedControl)) return;

      handleAction(element.dataset.action, element);
    });

    // Закрытие диалогов кликом по фону.
    $$(".dialog").forEach(dialog => {
      dialog.addEventListener("click", event => {
        if (event.target === dialog) {
          closeDialog(dialog);
        }
      });
    });

    // Полноэкранный просмотр фото: закрытие кликом по фону.
    const photoDialog = $("#photoDialog");
    if (photoDialog) {
      // Закрыли просмотр — выходим и из полноэкранного режима.
      photoDialog.addEventListener("close", () => {
        if (state.reopeningLightbox) {
          state.reopeningLightbox = false;
          return;
        }

        if (document.fullscreenElement) document.exitFullscreen?.();
        resetZoom();
      });

      photoDialog.addEventListener("click", event => {
        if (event.target === photoDialog) {
          closeDialog(photoDialog);
        }
      });
    }

    // Смена размера окна / входа-выхода из полноэкранного режима.
    const refit = () => {
      if ($("#photoDialog")?.open) {
        clampZoom();
        applyZoom();
      }
    };

    window.addEventListener("resize", refit);
    document.addEventListener("fullscreenchange", () => {
      refit();

      const button = $('[data-action="fullscreen-toggle"]');
      if (button) {
        button.textContent = document.fullscreenElement ? "🗗" : "⛶";
        button.title = document.fullscreenElement
          ? "Выйти из полного экрана (F)"
          : "На весь экран (F)";
      }
    });

    // Клик по логотипу возвращает на главную.
    $("#brandHome")?.addEventListener("click", event => {
      event.preventDefault();
      navigate("models");
    });

    // Управление просмотром фото с клавиатуры.
    document.addEventListener("keydown", event => {
      const dialog = $("#photoDialog");

      if (event.key === "Escape") {
        closeCardMenus();
      }

      if (dialog?.open) {
        if (event.key === "Escape") {
          closeDialog(dialog);
        } else if (event.key === "ArrowLeft") {
          moveLightbox(-1);
        } else if (event.key === "ArrowRight") {
          moveLightbox(1);
        } else if (["+", "=", "NumpadAdd"].includes(event.key)
          || event.code === "NumpadAdd") {
          zoomBy(1.5);
        } else if (["-", "_"].includes(event.key)
          || event.code === "NumpadSubtract") {
          zoomBy(1 / 1.5);
        } else if (event.key === "0") {
          zoomAt(1);
        } else if (event.code === "KeyD") {
          downloadCurrentPhoto();
        } else if (event.code === "KeyF" && canFullscreen()) {
          toggleFullscreen();
        }

        return;
      }

      if (state.isLocked) {
        if (event.key >= "0" && event.key <= "9") {
          event.preventDefault();
          handlePinInput(event.key);
        } else if (event.key === "Backspace") {
          event.preventDefault();
          handlePinBackspace();
        } else if (event.key === "Escape") {
          event.preventDefault();
          handlePinClear();
        }
        return;
      }

      if (event.key === "Escape") {
        const setDialog = $("#setDialog");
        const massDialog = $("#massUploadDialog");
        const modelDialog = $("#modelDialog");
        const pwdDialog = $("#archivePasswordDialog");
        const secDialog = $("#securitySettingsDialog");

        if (secDialog?.open) {
          closeDialog(secDialog);
          return;
        }

        if (setDialog?.open) {
          event.preventDefault();
          requestCloseDialog("setDialog");
          return;
        }

        if (massDialog?.open) {
          event.preventDefault();
          requestCloseDialog("massUploadDialog");
          return;
        }

        if (modelDialog?.open) {
          closeDialog(modelDialog);
          return;
        }

        if (pwdDialog?.open) {
          closeDialog(pwdDialog);
          return;
        }

        // Если ни один диалог не открыт — нажатие Escape блокирует сайт (паник-кнопка)
        event.preventDefault();
        lockApp();
      } else if (!state.isLocked && event.code === "KeyP" && !event.target.matches("input, textarea, select")) {
        event.preventDefault();
        lockApp();
      }
    });
  }

  // Фоновая генерация превью для старых фото, загруженных без превью
  async function generateMissingPreviews() {
    const processing = CONFIG.imageProcessing || {};
    if (!processing.enabled || !("createImageBitmap" in window)) return;

    const missing = state.photos.filter(p => !p.preview && (p.blob instanceof Blob));
    if (!missing.length) return;

    console.info(`Cosplay Archive: генерация превью для ${missing.length} старых фото в фоне…`);
    let updated = 0;

    for (const photo of missing) {
      try {
        const preview = await makeImageVersion(photo.blob, {
          maxDimension: processing.previewMaxDimension || 960,
          quality: processing.previewQuality || 0.88,
          type: processing.outputType || "image/webp"
        });

        if (preview) {
          photo.preview = preview;
          await db.put(CONFIG.stores.photos, photo);
          updated += 1;
        }
      } catch (err) {
        console.warn("Ошибка генерации превью для фото:", photo.id, err);
      }
      await new Promise(r => setTimeout(r, 60));
    }

    if (updated > 0) {
      console.info(`Cosplay Archive: успешно создано превью для ${updated} фото.`);
      renderAll();
    }
  }

  /* -------------------- Запуск -------------------- */

  async function init() {
    try {
      initSecurityState();

      await db.open();

      initDrive();

      if (!isUserAuthenticated()) {
        state.models = [];
        state.sets = [];
        state.photos = [];
        cleanupObjectURLs();
      } else {
        await refreshData();
      }

      bindEvents();

      // Начальные значения интерфейса.
      if ($("#setDate") && !$("#setDate").value) {
        $("#setDate").value = today();
      }

      window.addEventListener("hashchange", () => applyRoute());

      renderAll();
      applyRoute(true);

      if (isUserAuthenticated()) {
        setTimeout(ensureHighResCovers, 200);
      }

      // Защита от случайной очистки IndexedDB браузером (iOS Safari, Android Chrome)
      if (navigator.storage && typeof navigator.storage.persist === "function") {
        navigator.storage.persist().catch(() => {});
      }

      // Запуск в режиме блокировки: при открытии сайта контент защищён
      lockApp();

      // Если пользователь авторизован — фоновая бесшумная синхронизация без зависаний UI
      if (isUserAuthenticated()) {
        setTimeout(() => {
          syncNow({ silent: true }).catch(() => {});
        }, 1200);
      }

      // Авто-синхронизация при возвращении на вкладку / авто-блокировка при сворачивании
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          if (state.autolockBlur) {
            lockApp();
          }
        } else if (document.visibilityState === "visible") {
          const last = state.drive.lastSyncAt ? Date.parse(state.drive.lastSyncAt) : 0;
          if (Date.now() - last > 90000) {
            syncNow({ silent: true });
          }
        }
      });

      // При закрытии страницы освобождаем объектные ссылки в памяти
      window.addEventListener("pagehide", () => {
        cleanupObjectURLs();
      });

      // PWA: регистрация Service Worker
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("service-worker.js").then(reg => {
          reg.update().catch(() => {});
        }).catch(err => {
          console.warn("ServiceWorker registration failed:", err);
        });
      }

      // Фоновое создание превью для старых фото без блокировки интерфейса
      setTimeout(() => {
        generateMissingPreviews();
      }, 2500);

      console.info(`${CONFIG.appName}: приложение запущено.`);
    } catch (error) {
      console.error("Cosplay Archive init error:", error);

      showToast(
        "Не удалось открыть базу данных. Попробуй запустить сайт через локальный сервер (например, Live Server).",
        "error"
      );
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
