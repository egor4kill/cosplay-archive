window.COSPLAY_CONFIG = {
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
    // true — хранить огромный сырой оригинал как есть.
    // false — сжимать в Ultra-HD WebP (до 3200px, 90% качество): визуально не отличимо от оригинала даже при зуме, но весит в 15 раз меньше.
    storeOriginal: false,
    maxDimension: 3200,
    quality: 0.90,
    previewMaxDimension: 480,
    previewQuality: 0.82,
    outputType: "image/webp"
  },

  backup: {
    format: "cosplay-archive-backup",
    version: 1
  },

  // Облачные провайдеры хранения.
  // Каждый провайдер: enabled, …credentials, autoSync, autoSyncDelayMs.
  // GDrive: clientId (см. README.md). Dropbox: appKey (см. README.md).
  providers: {
    gdrive: {
      enabled: true,
      clientId: "482187558997-r79ijrr1fus8f9sggmlc0d7rgimde73u.apps.googleusercontent.com",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
      rootFolderName: "Cosplay Archive",
      manifestName: "archive.json",
      photosFolderName: "photos",
      autoSync: true,
      autoSyncDelayMs: 4000
    },
    dropbox: {
      enabled: false,
      appKey: "",
      rootFolderName: "Cosplay Archive",
      manifestName: "archive.json",
      photosFolderName: "photos",
      autoSync: false,
      autoSyncDelayMs: 4000
    }
  },

  // Мульти-аккаунт: как раскладывать оригиналы по подключённым
  // Google Drive аккаунтам и сколько места оставлять свободным.
  multiAccount: {
    reserveFreeBytes: 250 * 1024 * 1024, // 250 МБ резерва на каждом аккаунте (200-300 МБ)
    strategy: "fill",                    // fill | roundrobin
    quotaCacheMs: 60000                  // кэш квоты, мс
  },

  // Режим чисто облачного хранения (Cloud-First):
  // Фотографии хранятся в Google Drive и НЕ расходуют память телефона/ПК.
  cloudFirst: {
    enabled: true,
    purgeOriginalsAfterUpload: true, // Освобождать локальный оригинал после заливки в облако
    downloadOriginalsOnSync: false   // Не скачивать тяжелые оригиналы в память устройства при синхронизации
  }
};
