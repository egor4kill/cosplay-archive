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
    // true — храним оригинал как есть (макс. качество), а рядом — маленькое превью для сеток.
    // false — старое поведение: сжимаем основную версию по maxDimension/quality.
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

  // Облачные провайдеры хранения.
  // Каждый провайдер: enabled, …credentials, autoSync, autoSyncDelayMs.
  // GDrive: clientId (см. README.md). Dropbox: appKey (см. README.md).
  providers: {
    gdrive: {
      enabled: true,
      clientId: "482187558997-r79ijrr1fus8f9sggmlc0d7rgimde73u.apps.googleusercontent.com",
      scope: "https://www.googleapis.com/auth/drive.file",
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
  }
};
