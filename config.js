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
    maxDimension: 2200,
    quality: 0.88,
    outputType: "image/webp"
  },

  backup: {
    format: "cosplay-archive-backup",
    version: 1
  },

  // Синхронизация с Google Drive.
  // Чтобы она заработала, вставь свой OAuth Client ID (см. README.md).
  drive: {
    enabled: true,
    clientId: "482187558997-r79ijrr1fus8f9sggmlc0d7rgimde73u.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.file",
    rootFolderName: "Cosplay Archive",
    manifestName: "archive.json",
    photosFolderName: "photos",
    autoSync: true,
    autoSyncDelayMs: 4000
  }
};
