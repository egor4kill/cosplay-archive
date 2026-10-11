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
      maxDimension: 2200,
      quality: 0.88,
      outputType: "image/webp"
    },
    backup: {
      format: "cosplay-archive-backup",
      version: 1
    },
    drive: {
      enabled: false,
      clientId: "",
      scope: "https://www.googleapis.com/auth/drive.file",
      rootFolderName: "Cosplay Archive",
      manifestName: "archive.json",
      photosFolderName: "photos",
      autoSync: true,
      autoSyncDelayMs: 4000
    }
  };

  const drive = window.CosplayDrive || null;

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
    activeTag: "",
    lightboxPhotos: [],
    lightboxIndex: 0,
    objectURLs: new Map(),
    draftNewPhotos: [],
    draftRemovedPhotoIds: new Set(),
    draftCoverPhotoId: null,
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

    closeDialog(document.getElementById(id));
  }

  function getModel(id) {
    return state.models.find(model => model.id === id);
  }

  function getSet(id) {
    return state.sets.find(set => set.id === id);
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

  function photoURL(photo) {
    if (!photo) return "";

    if (photo.blob instanceof Blob) {
      if (!state.objectURLs.has(photo.id)) {
        state.objectURLs.set(
          photo.id,
          URL.createObjectURL(photo.blob)
        );
      }

      return state.objectURLs.get(photo.id);
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

  function modelHref(id) {
    return `#/model/${encodeURIComponent(id)}`;
  }

  function setHref(id) {
    return `#/set/${encodeURIComponent(id)}`;
  }

  function renderModelCard(model) {
    const setsCount = countModelSets(model.id);
    const tags = model.tags || [];
    const cover = getModelCover(model.id);
    const coverURL = cover ? photoURL(cover) : "";

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
    const image = cover ? photoURL(cover) : "";
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
            ? `<img src="${photoURL(cover)}" alt="${escapeHTML(model.name)}">`
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

    if (state.page === "model-detail") {
      renderModelDetail();
    } else if (state.page === "set-detail") {
      renderSetDetail();
    }

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
    const raw = location.hash.replace(/^#\/?/, "");
    const [name, ...rest] = raw.split("/");

    let id = "";
    try {
      id = decodeURIComponent(rest.join("/"));
    } catch {
      id = rest.join("/");
    }

    if (name === "sets") return { page: "sets", id: "" };
    if (name === "model" && id) return { page: "model-detail", id };
    if (name === "set" && id) return { page: "set-detail", id };

    return { page: "models", id: "" };
  }

  function applyRoute(force = false) {
    const route = parseRoute();
    const key = `${route.page}:${route.id}`;

    if (!force && key === state.routeKey) return;
    state.routeKey = key;

    // Открытая полноэкранная галерея не должна «переезжать» на другую страницу.
    closeDialog($("#photoDialog"));

    state.page = route.page;
    state.selectedModelId = null;
    state.viewedSetId = null;

    if (route.page === "model-detail") {
      state.selectedModelId = route.id;
    } else if (route.page === "set-detail") {
      state.viewedSetId = route.id;
      state.selectedModelId = getSet(route.id)?.modelId || null;
    }

    updateNavigation();

    if (route.page === "model-detail") renderModelDetail();
    if (route.page === "set-detail") renderSetDetail();

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

  function openModelForm(model = null) {
    const form = $("#modelForm");
    if (!form) return;

    form.reset();

    $("#modelId").value = model?.id || "";
    $("#modelName").value = model?.name || "";
    $("#modelUrl").value = model?.url || "";
    $("#modelTags").value = (model?.tags || []).join(", ");
    $("#modelNotes").value = model?.notes || "";

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

    const previous = getModel(id);

    const model = {
      id,
      name,
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
      const url = photoURL(photo);
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

  async function prepareImage(file) {
    if (!file || !CONFIG.allowedImageTypes.includes(file.type)) {
      throw new Error(`Формат файла «${file?.name || "неизвестно"}» не поддерживается.`);
    }

    if (!CONFIG.imageProcessing?.enabled || !("createImageBitmap" in window)) {
      return {
        id: uid(),
        blob: file,
        name: file.name,
        type: file.type,
        createdAt: new Date().toISOString()
      };
    }

    let bitmap;

    try {
      bitmap = await createImageBitmap(file);

      const maxDimension = CONFIG.imageProcessing.maxDimension || 2200;
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

      if (!context) {
        bitmap.close?.();
        return {
          id: uid(),
          blob: file,
          name: file.name,
          type: file.type,
          createdAt: new Date().toISOString()
        };
      }

      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();

      const blob = await new Promise(resolve => {
        canvas.toBlob(
          resolve,
          CONFIG.imageProcessing.outputType || "image/webp",
          CONFIG.imageProcessing.quality || 0.88
        );
      });

      // Если WebP не поддерживается, сохраняем исходник.
      if (!blob || blob.size >= file.size) {
        return {
          id: uid(),
          blob: file,
          name: file.name,
          type: file.type,
          createdAt: new Date().toISOString()
        };
      }

      return {
        id: uid(),
        blob,
        name: file.name.replace(/\.[^.]+$/, "") + ".webp",
        type: blob.type,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      bitmap?.close?.();
      console.warn("Не удалось обработать фото; будет сохранён оригинал.", error);

      return {
        id: uid(),
        blob: file,
        name: file.name,
        type: file.type,
        createdAt: new Date().toISOString()
      };
    }
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
      const url = photoURL(photo);
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
                <img src="${photoURL(photo)}"
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
      <button class="lightbox-close" type="button"
        data-action="close-lightbox" aria-label="Закрыть">×</button>
      <button class="lightbox-arrow previous" type="button"
        data-action="previous-photo" aria-label="Предыдущее фото">‹</button>
      <img id="lightboxImage" alt="">
      <button class="lightbox-arrow next" type="button"
        data-action="next-photo" aria-label="Следующее фото">›</button>
      <span class="lightbox-counter" id="lightboxCounter"></span>
    `;

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
  }

  function moveLightbox(direction) {
    const count = state.lightboxPhotos.length;
    if (!count) return;

    state.lightboxIndex =
      (state.lightboxIndex + direction + count) % count;

    renderLightboxPhoto();
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
          dataURL: await blobToDataURL(photo.blob)
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

        const { dataURL, ...metadata } = photo;

        return {
          ...metadata,
          blob: dataURLToBlob(dataURL)
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

  function updateDriveUI() {
    const bar = $("#driveBar");
    if (!bar) return;

    const connectBtn = $("#driveConnectBtn");
    const syncBtn = $("#driveSyncBtn");
    const signOutBtn = $("#driveSignOutBtn");
    const status = $("#driveStatus");

    const configured = Boolean(drive && drive.isConfigured());
    const signedIn = Boolean(drive && drive.hasToken());

    state.drive.configured = configured;
    state.drive.signedIn = signedIn;

    bar.classList.toggle("hidden", !drive || !CONFIG.drive?.enabled);

    connectBtn?.classList.toggle("hidden", !configured || signedIn);
    syncBtn?.classList.toggle("hidden", !signedIn);
    signOutBtn?.classList.toggle("hidden", !signedIn);

    if (syncBtn) syncBtn.disabled = state.drive.syncing;

    if (!status) return;

    status.classList.remove("is-error");
    let text = "";

    if (!configured) {
      text = "Google Drive: укажите OAuth Client ID в js/config.js.";
    } else if (state.drive.syncing) {
      text = "Синхронизация…";
    } else if (state.drive.error) {
      text = `Google Drive: ${state.drive.error}`;
      status.classList.add("is-error");
    } else if (signedIn) {
      const time = state.drive.lastSyncAt
        ? new Date(state.drive.lastSyncAt).toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit"
          })
        : "";
      text = time
        ? `Google Drive подключён · синхронизировано в ${time}`
        : "Google Drive подключён";
    } else {
      text = "Google Drive не подключён.";
    }

    status.textContent = text;
  }

  function scheduleAutoSync() {
    if (!CONFIG.drive?.enabled || !CONFIG.drive?.autoSync) return;
    if (!drive || !drive.isConfigured() || !drive.hasToken()) return;

    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      syncNow({ silent: true });
    }, CONFIG.drive.autoSyncDelayMs || 4000);
  }

  async function driveConnect() {
    if (!drive || !drive.isConfigured()) {
      showToast("Сначала укажите Google OAuth Client ID в js/config.js.", "error");
      return;
    }

    try {
      await drive.connect();
      state.drive.error = "";
      updateDriveUI();
      showToast("Google Drive подключён.", "success");
      await syncNow({ silent: true });
    } catch (error) {
      console.error(error);
      state.drive.error = error.message || "ошибка авторизации";
      updateDriveUI();
      showToast(`Не удалось подключить Google Drive: ${error.message}`, "error");
    }
  }

  function driveSignOut() {
    drive?.signOut();
    state.drive.lastSyncAt = null;
    state.drive.error = "";
    updateDriveUI();
    showToast("Google Drive отключён.");
  }

  async function syncNow(options = {}) {
    const { silent = false } = options;

    if (!drive || !drive.isConfigured()) {
      if (!silent) {
        showToast("Сначала укажите Google OAuth Client ID в js/config.js.", "error");
      }
      return;
    }

    if (state.drive.syncing) return;

    if (!drive.hasToken()) {
      const ok = await drive.trySilentConnect();
      updateDriveUI();

      if (!ok) {
        if (!silent) showToast("Подключите Google Drive.", "error");
        return;
      }
    }

    state.drive.syncing = true;
    state.drive.error = "";
    updateDriveUI();
    showProgress("Синхронизация с Google Drive…");

    try {
      await drive.ensureFolders();

      const remoteManifest = (await drive.getManifest()) || emptyManifest();
      const remotePhotoMap = await drive.listPhotos();

      const tombstones = readTombstones();
      const deleted = mergeDeletions(remoteManifest.deletions, tombstones);

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

      for (const id of photoIds) {
        const local = localPhotoById.get(id);
        const remote = remotePhotoById.get(id);
        const meta = { ...(remote || {}), ...(local || {}) };

        delete meta.blob;
        delete meta.dataURL;

        // Восстанавливаем картинку по цепочке: локальный blob →
        // сохранённый dataURL → скачивание с Google Drive.
        let blob = local?.blob instanceof Blob ? local.blob : null;

        if (!blob && typeof local?.dataURL === "string" && local.dataURL) {
          try {
            blob = dataURLToBlob(local.dataURL);
          } catch (error) {
            console.warn("Не удалось восстановить фото из dataURL:", id, error);
          }
        }

        const existingFile = remotePhotoMap.get(id) || null;
        let driveFileId =
          remote?.driveFileId || local?.driveFileId || existingFile?.id || null;

        if (!blob && driveFileId) {
          try {
            blob = await drive.downloadFile(driveFileId);
          } catch (error) {
            console.warn("Не удалось скачать фото с Drive:", id, error);
          }
        }

        if (blob) {
          const mimeType = meta.type || blob.type || "image/webp";

          try {
            if (existingFile) {
              driveFileId = existingFile.id;
            } else {
              driveFileId = await drive.uploadPhoto(id, blob, mimeType, null);
            }
          } catch (error) {
            uploadErrors.push(id);
            console.warn("Не удалось выгрузить фото на Drive:", id, error);
          }
        }

        // Локальную запись сохраняем всегда — даже если blob не удалось
        // получить, чтобы не потерять данные каталога.
        const record = { ...meta };

        if (blob) record.blob = blob;
        if (driveFileId) record.driveFileId = driveFileId;
        photos.push(record);

        manifestPhotos.push(
          driveFileId ? { ...meta, driveFileId } : { ...meta }
        );
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

      await drive.saveManifest(manifest);

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
      state.drive.syncing = false;
      hideProgress();
      updateDriveUI();
    }
  }

  function initDrive() {
    if (!drive || !CONFIG.drive?.enabled) {
      $("#driveBar")?.classList.add("hidden");
      return;
    }

    drive.configure(CONFIG.drive);
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
    $("#modelForm")?.addEventListener("submit", saveModel);
    $("#setForm")?.addEventListener("submit", saveSet);

    $("#setPhotos")?.addEventListener("change", event => {
      addSelectedPhotos(event.target.files);
    });

    // Вставка изображений из буфера обмена (Ctrl+V) в открытой форме сета.
    document.addEventListener("paste", event => {
      const dialog = $("#setDialog");
      if (!dialog?.open) return;

      const items = [...(event.clipboardData?.items || [])];
      const files = items
        .filter(item => item.kind === "file" && item.type.startsWith("image/"))
        .map(item => item.getAsFile())
        .filter(Boolean);

      if (!files.length) return;

      event.preventDefault();
      addSelectedPhotos(files);
    });

    // Перетаскивание файлов в панель фотографий.
    const uploadPanel = document.querySelector(".upload-panel");

    if (uploadPanel) {
      ["dragenter", "dragover"].forEach(type => {
        uploadPanel.addEventListener(type, event => {
          event.preventDefault();
          uploadPanel.classList.add("is-dragover");
        });
      });

      ["dragleave", "dragend"].forEach(type => {
        uploadPanel.addEventListener(type, () => {
          uploadPanel.classList.remove("is-dragover");
        });
      });

      uploadPanel.addEventListener("drop", event => {
        event.preventDefault();
        uploadPanel.classList.remove("is-dragover");

        const files = [...(event.dataTransfer?.files || [])]
          .filter(file => file.type.startsWith("image/"));

        if (files.length) addSelectedPhotos(files);
      });
    }

    // Резервные копии.
    $("#backupBtn")?.addEventListener("click", exportBackup);

    $("#importInput")?.addEventListener("change", event => {
      importBackup(event.target.files?.[0]);
    });

    // Синхронизация с Google Drive.
    $("#driveConnectBtn")?.addEventListener("click", driveConnect);
    $("#driveSyncBtn")?.addEventListener("click", () => syncNow());
    $("#driveSignOutBtn")?.addEventListener("click", driveSignOut);

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
      photoDialog.addEventListener("click", event => {
        if (event.target === photoDialog) {
          closeDialog(photoDialog);
        }
      });
    }

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
        }

        return;
      }

      if (event.key === "Escape") {
        const setDialog = $("#setDialog");

        if (setDialog?.open) {
          // Не даём браузеру закрыть диалог самому — иначе пропустим подтверждение.
          event.preventDefault();
          requestCloseDialog("setDialog");
          return;
        }

        closeDialog($("#modelDialog"));
      }
    });
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
