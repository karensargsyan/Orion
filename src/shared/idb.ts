import { DB_NAME, DB_VERSION, STORE } from './constants'

let _db: IDBDatabase | null = null

export function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      const tx = (e.target as IDBOpenDBRequest).transaction!
      setupSchema(db, tx, e.oldVersion)
    }

    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result
      _db.onclose = () => { _db = null }
      resolve(_db)
    }

    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IDB blocked by older version'))
  })
}

function setupSchema(db: IDBDatabase, tx: IDBTransaction, oldVersion: number): void {
  // v0 -> v1: initial stores
  if (oldVersion < 1) {
    const chat = db.createObjectStore(STORE.CHAT_HISTORY, { keyPath: 'id', autoIncrement: true })
    chat.createIndex('by_session', 'sessionId', { unique: false })
    chat.createIndex('by_timestamp', 'timestamp', { unique: false })
    chat.createIndex('by_session_timestamp', ['sessionId', 'timestamp'], { unique: false })

    const session = db.createObjectStore(STORE.SESSION_MEMORY, { keyPath: 'id', autoIncrement: true })
    session.createIndex('by_url', 'url', { unique: false })
    session.createIndex('by_timestamp', 'timestamp', { unique: false })
    session.createIndex('by_type', 'type', { unique: false })
    session.createIndex('by_domain', 'domain', { unique: false })
    session.createIndex('by_session', 'sessionId', { unique: false })

    const global = db.createObjectStore(STORE.GLOBAL_MEMORY, { keyPath: 'id', autoIncrement: true })
    global.createIndex('by_domain', 'domain', { unique: false })
    global.createIndex('by_tag', 'tags', { unique: false, multiEntry: true })
    global.createIndex('by_timestamp', 'timestamp', { unique: false })

    const vault = db.createObjectStore(STORE.VAULT, { keyPath: 'id' })
    vault.createIndex('by_category', 'category', { unique: false })

    db.createObjectStore(STORE.SETTINGS, { keyPath: 'key' })
  }

  // v1 -> v2: add new stores and indexes
  if (oldVersion < 2) {
    // Add by_tabId index to session_memory if store exists
    if (db.objectStoreNames.contains(STORE.SESSION_MEMORY)) {
      const sessionStore = tx.objectStore(STORE.SESSION_MEMORY)
      if (!sessionStore.indexNames.contains('by_tabId')) {
        sessionStore.createIndex('by_tabId', 'tabId', { unique: false })
      }
    }

    if (!db.objectStoreNames.contains(STORE.CALENDAR_EVENTS)) {
      const cal = db.createObjectStore(STORE.CALENDAR_EVENTS, { keyPath: 'id', autoIncrement: true })
      cal.createIndex('by_date', 'date', { unique: false })
      cal.createIndex('by_timestamp', 'detectedAt', { unique: false })
    }

    if (!db.objectStoreNames.contains(STORE.HABIT_PATTERNS)) {
      const hab = db.createObjectStore(STORE.HABIT_PATTERNS, { keyPath: 'id', autoIncrement: true })
      hab.createIndex('by_domain', 'domain', { unique: false })
      hab.createIndex('by_timestamp', 'timestamp', { unique: false })
    }
  }

  // v2 -> v3: domain skills store
  if (oldVersion < 3) {
    if (!db.objectStoreNames.contains(STORE.DOMAIN_SKILLS)) {
      const skills = db.createObjectStore(STORE.DOMAIN_SKILLS, { keyPath: 'id', autoIncrement: true })
      skills.createIndex('by_domain', 'domain', { unique: false })
      skills.createIndex('by_task', 'taskPattern', { unique: false })
      skills.createIndex('by_last_used', 'lastUsed', { unique: false })
    }
  }

  // v3 -> v4: user behaviors store
  if (oldVersion < 4) {
    if (!db.objectStoreNames.contains(STORE.USER_BEHAVIORS)) {
      const behaviors = db.createObjectStore(STORE.USER_BEHAVIORS, { keyPath: 'id', autoIncrement: true })
      behaviors.createIndex('by_domain', 'domain', { unique: false })
      behaviors.createIndex('by_category', 'category', { unique: false })
      behaviors.createIndex('by_confidence', 'confidence', { unique: false })
      behaviors.createIndex('by_last_seen', 'lastSeen', { unique: false })
    }
  }

  // v4 -> v5: learning sessions store
  if (oldVersion < 5) {
    if (!db.objectStoreNames.contains(STORE.LEARNING_SESSIONS)) {
      const ls = db.createObjectStore(STORE.LEARNING_SESSIONS, { keyPath: 'id' })
      ls.createIndex('by_domain', 'domain', { unique: false })
      ls.createIndex('by_started', 'startedAt', { unique: false })
    }
  }

  // v5 -> v6: supervised playbooks + sessions
  if (oldVersion < 6) {
    if (!db.objectStoreNames.contains(STORE.SUPERVISED_PLAYBOOKS)) {
      const pb = db.createObjectStore(STORE.SUPERVISED_PLAYBOOKS, { keyPath: 'id' })
      pb.createIndex('by_domain', 'domain', { unique: false })
      pb.createIndex('by_confidence', 'confidence', { unique: false })
      pb.createIndex('by_updated', 'updatedAt', { unique: false })
    }
    if (!db.objectStoreNames.contains(STORE.SUPERVISED_SESSIONS)) {
      const ss = db.createObjectStore(STORE.SUPERVISED_SESSIONS, { keyPath: 'id' })
      ss.createIndex('by_domain', 'domain', { unique: false })
      ss.createIndex('by_started', 'startedAt', { unique: false })
    }
  }

  // v6 -> v7: visual sitemap store
  if (oldVersion < 7) {
    if (!db.objectStoreNames.contains(STORE.VISUAL_SITEMAP)) {
      const sm = db.createObjectStore(STORE.VISUAL_SITEMAP, { keyPath: 'domain' })
      sm.createIndex('by_updated', 'lastUpdated', { unique: false })
    }
  }

  // v7 -> v8: local memory store (MemPalace replacement — no external server)
  if (oldVersion < 8) {
    if (!db.objectStoreNames.contains(STORE.LOCAL_MEMORY)) {
      const lm = db.createObjectStore(STORE.LOCAL_MEMORY, { keyPath: 'id', autoIncrement: true })
      lm.createIndex('by_category', 'category', { unique: false })
      lm.createIndex('by_domain', 'domain', { unique: false })
      lm.createIndex('by_timestamp', 'timestamp', { unique: false })
    }
  }

  // v8 -> v9: input journal — Total Recall (capture all form inputs)
  if (oldVersion < 9) {
    if (!db.objectStoreNames.contains(STORE.INPUT_JOURNAL)) {
      const ij = db.createObjectStore(STORE.INPUT_JOURNAL, { keyPath: 'id', autoIncrement: true })
      ij.createIndex('by_fieldType', 'fieldType', { unique: false })
      ij.createIndex('by_domain', 'domain', { unique: false })
      ij.createIndex('by_timestamp', 'timestamp', { unique: false })
      ij.createIndex('by_fieldType_domain', ['fieldType', 'domain'], { unique: false })
    }
  }

  // v9 -> v10: pinned facts store
  if (oldVersion < 10) {
    if (!db.objectStoreNames.contains(STORE.PINNED_FACTS)) {
      const pf = db.createObjectStore(STORE.PINNED_FACTS, { keyPath: 'id' })
      pf.createIndex('by_session', 'sessionId', { unique: false })
      pf.createIndex('by_pinned', 'pinnedAt', { unique: false })
    }
  }

  // v10 -> v11: saved workflows store (V3: FR-V3-1)
  if (oldVersion < 11) {
    if (!db.objectStoreNames.contains(STORE.WORKFLOWS)) {
      const wf = db.createObjectStore(STORE.WORKFLOWS, { keyPath: 'id' })
      wf.createIndex('by_name', 'name', { unique: false })
      wf.createIndex('by_updated', 'updatedAt', { unique: false })
    }
  }
}

// ─── Generic helpers ──────────────────────────────────────────────────────────

function req2promise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function dbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB()
  const tx = db.transaction(store, 'readonly')
  return req2promise<T>(tx.objectStore(store).get(key))
}

export async function dbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDB()
  const tx = db.transaction(store, 'readonly')
  return req2promise<T[]>(tx.objectStore(store).getAll())
}

export async function dbGetAllByIndex<T>(
  store: string,
  index: string,
  query: IDBValidKey | IDBKeyRange,
  count?: number
): Promise<T[]> {
  const db = await openDB()
  const tx = db.transaction(store, 'readonly')
  const idx = tx.objectStore(store).index(index)
  return req2promise<T[]>(idx.getAll(query, count))
}

export async function dbPut<T>(store: string, value: T): Promise<IDBValidKey> {
  const db = await openDB()
  const tx = db.transaction(store, 'readwrite')
  return req2promise<IDBValidKey>(tx.objectStore(store).put(value as object))
}

export async function dbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(store, 'readwrite')
  await req2promise<undefined>(tx.objectStore(store).delete(key))
}

export async function dbClear(store: string): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(store, 'readwrite')
  await req2promise<undefined>(tx.objectStore(store).clear())
}

export async function dbGetByIndexRange<T>(
  store: string,
  index: string,
  query: IDBValidKey | IDBKeyRange,
  limit = 100
): Promise<T[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const idx = tx.objectStore(store).index(index)
    const results: T[] = []
    const req = idx.openCursor(query, 'prev')
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || results.length >= limit) { resolve(results); return }
      results.push(cursor.value as T)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

export async function dbCount(store: string): Promise<number> {
  const db = await openDB()
  const tx = db.transaction(store, 'readonly')
  return req2promise<number>(tx.objectStore(store).count())
}
