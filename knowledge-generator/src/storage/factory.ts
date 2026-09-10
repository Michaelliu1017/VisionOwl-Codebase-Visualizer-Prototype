import type { AppConfig } from "../config.js";
import { FileEvidenceStore } from "./fileStore.js";
import { MemoryEvidenceStore } from "./memoryStore.js";
import { PostgresEvidenceStore } from "./postgresStore.js";
import type { EvidenceStore } from "./store.js";

export function createStore(config: AppConfig): EvidenceStore {
  switch (config.storageDriver) {
    case "file":
      return new FileEvidenceStore(config.dataDir);
    case "memory":
      return new MemoryEvidenceStore();
    case "postgres":
      return new PostgresEvidenceStore(config.databaseUrl!);
  }
}
