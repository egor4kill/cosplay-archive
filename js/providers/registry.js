/* =========================================================
   Cosplay Archive — реестр облачных провайдеров
   Файл: js/providers/registry.js

   Реестр — единая точка доступа к провайдерам хранения
   (Google Drive, Dropbox, …). Каждый провайдер реализует
   общий интерфейс:

     configure(config)
     isConfigured() → bool
     hasToken() → bool
     connect() → Promise
     trySilentConnect() → Promise<bool>
     signOut()
     ensureFolders()
     getManifest() → Promise<object|null>
     saveManifest(manifest) → Promise
     listPhotos() → Promise<Map<name, {id, name, size}>>
     uploadPhoto(name, blob, mimeType, existingId) → Promise<fileId>
     downloadFile(fileId) → Promise<Blob>
     deleteFile(fileId) → Promise

   Активный провайдер хранится в localStorage.
   ========================================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "cosplay-active-provider";

  const providers = new Map();
  let activeId = localStorage.getItem(STORAGE_KEY) || "";

  function register(id, provider) {
    providers.set(id, provider);
  }

  function get(id) {
    return providers.get(id) || null;
  }

  function list() {
    return Array.from(providers.keys());
  }

  function activeIdGetter() {
    return activeId;
  }

  function getActive() {
    if (activeId && providers.has(activeId)) {
      return providers.get(activeId);
    }

    // Fallback: первый зарегистрированный провайдер.
    const first = providers.keys().next();
    if (!first.done) {
      activeId = first.value;
      return providers.get(activeId);
    }

    return null;
  }

  function setActive(id) {
    if (!providers.has(id)) return;
    activeId = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* приватный режим — игнорируем */
    }
  }

  window.CosplayProviders = {
    register,
    get,
    list,
    getActive,
    setActive,
    activeId: activeIdGetter
  };
})();
