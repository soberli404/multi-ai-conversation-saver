import type { Container, ConversationMessage, Tag } from '../types'

const DB_NAME = 'codex-container-copilot'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains('containers')) {
        database.createObjectStore('containers', { keyPath: 'id' })
      }

      if (!database.objectStoreNames.contains('tags')) {
        database.createObjectStore('tags', { keyPath: 'id' })
      }

      if (!database.objectStoreNames.contains('messages')) {
        const store = database.createObjectStore('messages', { keyPath: 'id' })
        store.createIndex('containerId', 'containerId')
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return dbPromise
}

async function getAll<T>(storeName: string): Promise<T[]> {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function get<T>(storeName: string, id: string): Promise<T | undefined> {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function put<T>(storeName: string, item: T): Promise<void> {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(item)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function del(storeName: string, id: string): Promise<void> {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function getAllByIndex<T>(storeName: string, indexName: string, key: string): Promise<T[]> {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).index(indexName).getAll(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function replaceByIndex<T>(storeName: string, indexName: string, key: string, items: T[]): Promise<void> {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const request = store.index(indexName).getAllKeys(key)

    request.onsuccess = () => {
      for (const recordKey of request.result) {
        store.delete(recordKey)
      }
      for (const item of items) {
        store.put(item)
      }
    }

    request.onerror = () => reject(request.error)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function deleteByIndex(storeName: string, indexName: string, key: string): Promise<void> {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const request = store.index(indexName).getAllKeys(key)

    request.onsuccess = () => {
      for (const recordKey of request.result) {
        store.delete(recordKey)
      }
    }

    request.onerror = () => reject(request.error)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export const db = {
  containers: {
    getAll: () => getAll<Container>('containers'),
    get: (id: string) => get<Container>('containers', id),
    put: (container: Container) => put('containers', container),
    del: (id: string) => del('containers', id),
  },
  tags: {
    getAll: () => getAll<Tag>('tags'),
    put: (tag: Tag) => put('tags', tag),
    del: (id: string) => del('tags', id),
  },
  messages: {
    getByContainer: (containerId: string) =>
      getAllByIndex<ConversationMessage>('messages', 'containerId', containerId),
    replaceForContainer: (containerId: string, messages: ConversationMessage[]) =>
      replaceByIndex('messages', 'containerId', containerId, messages),
    deleteByContainer: (containerId: string) => deleteByIndex('messages', 'containerId', containerId),
  },
}
