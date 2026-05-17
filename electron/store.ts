import Store from 'electron-store'

export interface AppSettings {
  wowPath: string;
  apiUrl: string;
  autoStart: boolean;
  apiKey: string;
  lastSync: string;
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
  }
} as const;

export const store = new Store<AppSettings>({ schema })

export const getStoreValue = <K extends keyof AppSettings>(key: K): AppSettings[K] => {
  return store.get(key);
}

export const setStoreValue = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
  store.set(key, value);
}
