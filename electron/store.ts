import Store from 'electron-store'

/** Incremental sync state persisted per SavedVariables file (key = file path). */
export interface FileSyncState {
  /** entryId → entryHash already acknowledged by the server. */
  ackedHashes: Record<string, string>;
  /** epoch ms of the last successful manifest reconciliation. */
  lastReconcile: number;
}

export interface AppSettings {
  wowPath: string;
  apiUrl: string;
  autoStart: boolean;
  apiKey: string;
  lastSync: string;
  /** Survives restarts → avoids re-uploading the whole history. */
  syncState: Record<string, FileSyncState>;
}

const schema = {
  wowPath: {
    type: 'string',
    default: '',
  },
  apiUrl: {
    type: 'string',
    default: 'https://guildmastery.io',
  },
  autoStart: {
    type: 'boolean',
    default: false,
  },
  apiKey: {
    type: 'string',
    default: '',
  },
  lastSync: {
    type: 'string',
    default: '',
  },
  syncState: {
    type: 'object',
    default: {},
    additionalProperties: true,
  }
} as const;

export const store = new Store<AppSettings>({ schema })

export const getStoreValue = <K extends keyof AppSettings>(key: K): AppSettings[K] => {
  return store.get(key);
}

export const setStoreValue = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
  store.set(key, value);
}
