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
      storeOriginal: true,
      maxDimension: 2200,
      quality: 0.88,
      previewMaxDimension: 480,
      previewQuality: 0.8,
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
    }, 300);
  }

  function hideProgress() {
    clearTimeout(showProgress.timer);
    $("#progressBar")?.classList.add("hidden");
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

  function photoURL(photo, variant = "full") {
    if (!photo) return "";

    const previewBlob = variant === "preview" && photo.preview instanceof Blob
      ? photo.preview
      : null;

    const blob = previewBlob
      || (photo.blob instanceof Blob ? photo.blob : null);

    if (blob) {
      const key = previewBlob ? `${photo.id}:preview` : photo.id;

      if (!state.objectURLs.has(key)) {
        state.objectURLs.set(key, URL.createObjectURL(blob));
      }

      return state.objectURLs.get(key);
    }

    if (typeof photo.dataURL === "string" && photo.dataURL) {
      return photo.dataURL;
    }

    return "";
  }

  function cleanupObjectURLs() {
    for (const url of state.objectURLs.values()) {
      URL.revokeObjectURL(url);
    }

    state.objectURLs.clear();
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

  function sortModels(models, sort) {
    const result = [...models];

    if (sort === "oldest") {
      return result.sort((a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      );
    }

    if (sort === "updated") {
      return result.sort((a, b) =>
        String(b.updatedAt || b.createdAt || "").localeCompare(
          String(a.updatedAt || a.createdAt || "")
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
      default:
        return result.sort((a, b) =>
          String(b.date || b.createdAt || "").localeCompare(
            String(a.date || a.createdAt || "")
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

    return tags.map(tag =>
      `<span class="${className}">#${escapeHTML(tag)}</span>`
    ).join("");
  }

  function renderCardTags(tags, limit = 3) {
    if (!tags?.length) return "";

    const visible = tags.slice(0, limit);
    const remainder = tags.length - visible.length;

    return `
      <div class="card-tags">
        ${renderTags(visible)}
        ${remainder > 0
          ? `<span class="mini-tag">+${remainder}</span>`
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
    const coverURL = cover ? photoURL(cover, "preview") : "";

    return `
      <article class="archive-card model-card" data-model-id="${escapeHTML(model.id)}"
        data-action="open-model" data-id="${escapeHTML(model.id)}">
        <a class="card-cover" href="${modelHref(model.id)}"
          aria-label="Открыть модель ${escapeHTML(model.name)}">
          ${coverURL
            ? `<img src="${coverURL}" alt="${escapeHTML(model.name)}" loading="lazy">`
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
    const image = cover ? photoURL(cover, "preview") : "";
    const photoCount = getSetPhotos(set).length;

    return `
      <article class="archive-card set-card" data-set-id="${escapeHTML(set.id)}"
        data-action="view-set" data-id="${escapeHTML(set.id)}">
        <a class="card-cover" href="${setHref(set.id)}"
          aria-label="Открыть сет ${escapeHTML(set.character)}">
          ${image
            ? `<img src="${image}" alt="${escapeHTML(set.character)}" loading="lazy">`
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
    const sort = $("#modelSort")?.value || "name";

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
        tags.add(tag);
      }
    }

    for (const model of state.models) {
      for (const tag of model.tags || []) {
        tags.add(tag);
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

    container.innerHTML = tags.map(tag => `
      <button class="tag-chip ${state.activeTag === tag ? "active" : ""}"
        type="button" data-action="filter-tag" data-tag="${escapeHTML(tag)}">
        #${escapeHTML(tag)}
      </button>
    `).join("");
  }

  function renderSets() {
    const grid = $("#setsGrid");
    const empty = $("#setsEmpty");

    if (!grid) return;

    const query = normalize($("#setSearch")?.value);
    const modelId = $("#setModelFilter")?.value || "";
    const sort = $("#setSort")?.value || "newest";
    const favoritesOnly = Boolean($("#favoritesOnly")?.checked);

    let sets = state.sets.filter(set => {
      const model = getModel(set.modelId);
      const tags = set.tags || [];

      if (modelId && set.modelId !== modelId) return false;
      if (favoritesOnly && !set.favorite) return false;

      if (
        state.activeTag
        && !tags.includes(state.activeTag)
        && !(model?.tags || []).includes(state.activeTag)
      ) {
        return false;
      }

      if (!query) return true;

      return [
        set.character,
        set.title,
        set.description,
        model?.name,
        ...(tags)
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

      header.innerHTML = `
        <div class="model-detail-hero">
          <div class="model-avatar">${cover
            ? `<img src="${photoURL(cover, "preview")}" alt="${escapeHTML(model.name)}">`
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
      $("#setSort")?.value || "newest"
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
  }

  function renderStats() {
    const element = $("#footerStats");
    if (!element) return;

    const favorites = state.sets.filter(set => set.favorite).length;
    const photosCount = state.photos.length;

    element.textContent =
      `${state.models.length} ${pluralize(state.models.length, "модель", "модели", "моделей")} · ` +
      `${state.sets.length} ${pluralize(state.sets.length, "сет", "сета", "сетов")} · ` +
      `${photosCount} ${pluralize(photosCount, "фотография", "фотографии", "фотографий")} · ` +
      `${favorites} в избранном`;
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
  }

  function updateNavigation() {
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

    $(`#page-${state.page}`)?.classList.remove("hidden");
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

  function openModelForm(model = null) {
    const form = $("#modelForm");
    if (!form) return;

    form.reset();

    $("#modelId").value = model?.id || "";
    $("#modelName").value = model?.name || "";
    $("#modelUrl").value = model?.url || "";
    $("#modelTags").value = (model?.tags || []).join(", ");
    $("#modelNotes").value = model?.notes || "";

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

    const model = {
      id,
      name,
      slug,
      url,
      tags: parseTags($("#modelTags").value),
      notes: $("#modelNotes").value.trim(),
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
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

    state.draftNewPhotos = [];
    state.draftRemovedPhotoIds = new Set();
    state.draftCoverPhotoId = set?.coverPhotoId || null;

    $("#setId").value = set?.id || "";
    $("#setCharacter").value = set?.character || "";
    $("#setTitle").value = set?.title || "";
    $("#setRating").value = set?.rating || "";
    $("#setDate").value = set?.date || today();
    $("#setTags").value = (set?.tags || []).join(", ");
    $("#setDescription").value = set?.description || "";

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

    renderExistingPhotos(set);
    openDialog($("#setDialog"));
    $("#setCharacter")?.focus();
  }

  function renderExistingPhotos(set) {
    const container = $("#existingPhotos");
    if (!container) return;

    if (!set) {
      container.innerHTML = "";
      return;
    }

    const photos = getSetPhotos(set);

    container.innerHTML = photos.map((photo, index) => {
      const url = photoURL(photo, "preview");
      const isCover = photo.id === state.draftCoverPhotoId;

      return `
        <div class="photo-thumb ${isCover ? "is-cover" : ""}">
          <img src="${url}" alt="Фото ${index + 1}" loading="lazy">
          <button type="button" data-action="remove-draft-photo"
            data-id="${escapeHTML(photo.id)}" aria-label="Убрать фото">×</button>
          <button type="button" data-action="set-cover"
            data-id="${escapeHTML(photo.id)}" aria-label="Сделать обложкой"
            style="top:auto;left:5px;right:auto;bottom:5px;width:auto;padding:0 7px">
            ${isCover ? "★" : "☆"}
          </button>
          ${isCover ? '<span class="cover-label">Обложка</span>' : ""}
        </div>
      `;
    }).join("");
  }

  async function makeImageVersion(file, { maxDimension, quality, type }) {
    if (!("createImageBitmap" in window)) return null;

    let bitmap;

    try {
      bitmap = await createImageBitmap(file);

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

    // Маленькое превью для сеток — всегда (кэш, не синхронизируется).
    const preview = canProcess
      ? await makeImageVersion(file, {
          maxDimension: processing.previewMaxDimension || 480,
          quality: processing.previewQuality || 0.8,
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

    // …либо сжатая копия (прежнее поведение).
    const compressed = canProcess
      ? await makeImageVersion(file, {
          maxDimension: processing.maxDimension || 2200,
          quality: processing.quality || 0.88,
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
    const files = Array.from(fileList || []);

    if (!files.length) return;

    const max = CONFIG.maxPhotosPerImport || 200;

    if (files.length > max) {
      showToast(`За раз можно выбрать не более ${max} фотографий.`, "error");
      return;
    }

    const existingCount = state.draftNewPhotos.length;

    if (existingCount + files.length > max) {
      showToast(`В одном действии можно обработать не более ${max} фотографий.`, "error");
      return;
    }

    const input = $("#setPhotos");
    if (input) input.disabled = true;

    try {
      for (const file of files) {
        if (!CONFIG.allowedImageTypes.includes(file.type)) {
          showToast(`Пропущен неподдерживаемый файл: ${file.name}`, "error");
          continue;
        }

        const prepared = await prepareImage(file);
        state.draftNewPhotos.push(prepared);

        const temporaryUrl = URL.createObjectURL(prepared.blob);
        state.objectURLs.set(prepared.id, temporaryUrl);
      }

      renderDraftPhotos();
      showToast(`Добавлено фотографий: ${state.draftNewPhotos.length}`, "success");
    } catch (error) {
      console.error(error);
      showToast("Не удалось обработать фотографии.", "error");
    } finally {
      if (input) {
        input.disabled = false;
        input.value = "";
      }
    }
  }

  function renderDraftPhotos() {
    const container = $("#existingPhotos");
    if (!container) return;

    const setId = $("#setId")?.value;
    const existingSet = setId ? getSet(setId) : null;
    const photos = getSetPhotos(existingSet);

    container.innerHTML = photos.map((photo, index) => {
      const url = photoURL(photo, "preview");
      const isCover = photo.id === state.draftCoverPhotoId;

      return `
        <div class="photo-thumb ${isCover ? "is-cover" : ""}">
          <img src="${url}" alt="Фото ${index + 1}" loading="lazy">
          <button type="button" data-action="remove-draft-photo"
            data-id="${escapeHTML(photo.id)}" aria-label="Убрать фото">×</button>
          <button type="button" data-action="set-cover"
            data-id="${escapeHTML(photo.id)}"
            style="top:auto;left:5px;right:auto;bottom:5px;width:auto;padding:0 7px"
            aria-label="Сделать обложкой">${isCover ? "★" : "☆"}</button>
          ${isCover ? '<span class="cover-label">Обложка</span>' : ""}
        </div>
      `;
    }).join("");
  }

  function removeDraftPhoto(id) {
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
    const files = Array.from(fileList || [])
      .filter(file => file.type.startsWith("image/"));

    if (!files.length) return;

    const max = CONFIG.maxPhotosPerImport || 200;

    if (state.massUploadPhotos.length + files.length > max) {
      showToast(`За раз можно обработать не более ${max} фотографий.`, "error");
      return;
    }

    const input = $("#massUploadInput");
    if (input) input.disabled = true;

    let added = 0;
    let skipped = 0;

    try {
      for (const file of files) {
        if (!CONFIG.allowedImageTypes.includes(file.type)) {
          skipped += 1;
          continue;
        }

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

    try {
      await db.saveSetWithPhotos(setRecord, newPhotos, []);

      resetMassUploadState();
      closeDialog($("#massUploadDialog"));

      await refreshData();
      renderAll();

      showToast(`Загружено фотографий: ${newPhotos.length}`, "success");
      scheduleAutoSync();

      navigate("set-detail", setRecord.id);
    } catch (error) {
      console.error(error);
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
        .filter(file => file.type.startsWith("image/"));

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
    const oldPhotoIds = new Set(previous?.photoIds || []);

    const newPhotos = state.draftNewPhotos.map(photo => ({
      ...photo,
      setId: id,
      order: oldPhotoIds.size + state.draftNewPhotos.indexOf(photo)
    }));

    const keptPhotoIds = [
      ...(previous?.photoIds || []).filter(
        photoId => !state.draftRemovedPhotoIds.has(photoId)
      ),
      ...newPhotos.map(photo => photo.id)
    ];

    const coverId = state.draftCoverPhotoId
      && keptPhotoIds.includes(state.draftCoverPhotoId)
      ? state.draftCoverPhotoId
      : keptPhotoIds[0] || null;

    const ratingValue = Number($("#setRating").value || 0);

    const setRecord = {
      id,
      modelId,
      slug,
      character,
      title: $("#setTitle").value.trim(),
      rating: Number.isFinite(ratingValue)
        ? Math.max(0, Math.min(5, ratingValue))
        : 0,
      date: $("#setDate").value || today(),
      tags: parseTags($("#setTags").value),
      description: $("#setDescription").value.trim(),
      photoIds: keptPhotoIds,
      coverPhotoId: coverId,
      favorite: Boolean(previous?.favorite),
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    setBusy(true, "Сохранение сета…");

    try {
      await db.saveSetWithPhotos(
        setRecord,
        newPhotos,
        [...state.draftRemovedPhotoIds]
      );

      recordDeletion("photos", [...state.draftRemovedPhotoIds]);

      cleanupObjectURLs();
      state.draftNewPhotos = [];
      state.draftRemovedPhotoIds.clear();
      state.draftCoverPhotoId = null;

      await refreshData();
      closeDialog($("#setDialog"));
      renderAll();

      showToast(previous ? "Сет обновлён." : "Сет добавлен.", "success");
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
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

  function photoExtension(blob) {
    const type = (blob && blob.type) || "";
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
    const extension = photoExtension(photo?.blob);

    if (keepOriginal) {
      const raw = String(photo?.name || "").replace(/\.[^.]+$/, "").trim();
      const safe = raw.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80);
      if (safe) return `${safe}.${extension}`;
    }

    const number = String(index + 1).padStart(2, "0");
    return `${base}-${number}.${extension}`;
  }

  function downloadCurrentPhoto() {
    const photo = state.lightboxPhotos[state.lightboxIndex];
    if (!photo) return;

    const base = downloadBaseName(getSet(state.viewedSetId));
    downloadBlob(
      photo.blob,
      photoDownloadName(photo, base, state.lightboxIndex)
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

    // Chromium на ПК: пишем сразу в выбранную папку
    if (typeof window.showDirectoryPicker === "function") {
      try {
        const directory = await window.showDirectoryPicker({ mode: "readwrite" });

        for (let index = 0; index < photos.length; index += 1) {
          const handle = await directory.getFileHandle(nameOf(index), { create: true });
          const writable = await handle.createWritable();
          await writable.write(photos[index].blob);
          await writable.close();
        }

        showToast(`Скачано фотографий: ${photos.length}.`);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return; // выбор папки отменён пользователем
      }
    }

    // Мобильные устройства, Safari, Firefox: скачиваем единым ZIP-архивом
    if (typeof window.JSZip === "function") {
      showProgress("Создание ZIP-архива…");
      try {
        const zip = new window.JSZip();
        for (let index = 0; index < photos.length; index += 1) {
          zip.file(nameOf(index), photos[index].blob);
        }
        const zipBlob = await zip.generateAsync({ type: "blob" });
        downloadBlob(zipBlob, `${base}.zip`);
        showToast(`Архив «${base}.zip» скачан.`, "success");
        return;
      } catch (error) {
        console.warn("Ошибка генерации ZIP-архива:", error);
      } finally {
        hideProgress();
      }
    }

    // Запасной путь для браузеров без JSZip
    photos.forEach((photo, index) => {
      setTimeout(() => downloadBlob(photo.blob, nameOf(index)), index * 400);
    });

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
  }

  function renderLightboxPhoto() {
    const photo = state.lightboxPhotos[state.lightboxIndex];
    if (!photo) return;

    const image = $("#lightboxImage");
    const counter = $("#lightboxCounter");

    if (image) {
      image.src = photoURL(photo);
      image.alt = photo.name || "Фотография сета";
    }

    if (counter) {
      counter.textContent =
        `${state.lightboxIndex + 1} / ${state.lightboxPhotos.length}`;
    }

    // Подгружаем соседние кадры, чтобы листание было мгновенным.
    const count = state.lightboxPhotos.length;
    if (count > 1) {
      for (const shift of [-1, 1]) {
        const neighbour =
          state.lightboxPhotos[(state.lightboxIndex + shift + count) % count];
        if (neighbour) new Image().src = photoURL(neighbour);
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
      showToast(`${label} подключён.`, "success");
      await syncNow({ silent: true });
    } catch (error) {
      console.error(error);
      state.drive.error = error.message || "ошибка авторизации";
      updateDriveUI();
      showToast(`Не удалось подключить ${label}: ${error.message}`, "error");
    }
  }

  function driveSignOut() {
    drive?.signOut();
    quotaCache.clear();
    state.drive.lastSyncAt = null;
    state.drive.error = "";
    updateDriveUI();
    showToast(`${drive?.label || "Облако"} отключён.`);
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
    showProgress(`Синхронизация с ${providerLabel}…`);

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
        const previewBlob = local?.preview instanceof Blob
          ? local.preview
          : null;

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

        if (!blob && driveFileId) {
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

        // Локальную запись сохраняем всегда — даже если blob не удалось
        // получить, чтобы не потерять данные каталога.
        const record = { ...meta };

        if (blob) record.blob = blob;
        if (previewBlob) record.preview = previewBlob;
        if (driveFileId) record.driveFileId = driveFileId;
        // provider: сохраняем активный провайдер фото.
        record.provider = drive.id || record.provider;
        if (providerTargetId != null) record.providerTargetId = providerTargetId;

        photos.push(record);

        const manifestMeta = { ...meta, provider: drive.id || meta.provider };
        if (driveFileId) manifestMeta.driveFileId = driveFileId;
        if (providerTargetId != null) manifestMeta.providerTargetId = providerTargetId;
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
    } catch (error) {
      console.error(error);
      state.drive.error = error.message || "ошибка синхронизации";

      if (!silent) {
        showToast(`Синхронизация не удалась: ${error.message}`, "error");
      }
    } finally {
      quotaCache.clear();
      state.drive.syncing = false;
      hideProgress();
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
      drive.trySilentConnect().then(ok => {
        updateDriveUI();
        if (ok) syncNow({ silent: true });
      });
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

      case "filter-tag":
        state.activeTag = state.activeTag === tag ? "" : tag;
        renderTagChips();
        renderSets();
        break;

      case "remove-draft-photo":
        removeDraftPhoto(id);
        break;

      case "set-cover":
        state.draftCoverPhotoId = id;
        renderDraftPhotos();
        break;

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

    // Резервные копии.
    $("#backupBtn")?.addEventListener("click", exportBackup);

    $("#importInput")?.addEventListener("change", event => {
      importBackup(event.target.files?.[0]);
    });

    // Синхронизация с облаком.
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
        updateDriveUI();
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

      if (event.key === "Escape") {
        const setDialog = $("#setDialog");
        const massDialog = $("#massUploadDialog");

        if (setDialog?.open) {
          // Не даём браузеру закрыть диалог самому — иначе пропустим подтверждение.
          event.preventDefault();
          requestCloseDialog("setDialog");
          return;
        }

        if (massDialog?.open) {
          event.preventDefault();
          requestCloseDialog("massUploadDialog");
          return;
        }

        closeDialog($("#modelDialog"));
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
          maxDimension: processing.previewMaxDimension || 480,
          quality: processing.previewQuality || 0.8,
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
      await db.open();
      await refreshData();

      bindEvents();

      // Начальные значения интерфейса.
      if ($("#setDate") && !$("#setDate").value) {
        $("#setDate").value = today();
      }

      window.addEventListener("hashchange", () => applyRoute());

      renderAll();
      applyRoute(true);

      initDrive();

      // PWA: регистрация Service Worker
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("service-worker.js").catch(err => {
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
