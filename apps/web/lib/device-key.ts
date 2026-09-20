"use client"

const DB_NAME = "krypta"
const DB_VERSION = 1
const STORE_NAME = "device-keys"

interface DeviceKeyRecord {
  userId: string
  deviceKey: CryptoKey
  wrappedAccountKey: ArrayBuffer
  iv: Uint8Array
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "userId" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function getRecord(
  db: IDBDatabase,
  userId: string
): Promise<DeviceKeyRecord | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly")
    const request = tx.objectStore(STORE_NAME).get(userId)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)
  })
}

function putRecord(db: IDBDatabase, record: DeviceKeyRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function deleteRecord(db: IDBDatabase, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).delete(userId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Wraps `accountKey` with a per-device, non-extractable AES-GCM key and stores the ciphertext
 * in IndexedDB, keyed by `userId`. The device key's raw bytes can never be read by JS, only
 * used in place for encrypt/decrypt, so this protects against disk/storage exfiltration, not
 * against active XSS (the project's strict CSP, per CLAUDE.md rule 8, is the defense for that).
 * Fails silently on any error (private mode, storage disabled, quota issues): callers should
 * treat this as best-effort and keep working with the in-memory account key regardless.
 */
export async function persistAccountKey(
  userId: string,
  accountKey: string
): Promise<void> {
  try {
    const db = await openDb()
    const existing = await getRecord(db, userId)
    const deviceKey =
      existing?.deviceKey ??
      (await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      ))
    const iv = new Uint8Array(crypto.getRandomValues(new Uint8Array(12)))
    const plaintext = new Uint8Array(new TextEncoder().encode(accountKey))
    const wrappedAccountKey = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      deviceKey,
      plaintext
    )
    await putRecord(db, { userId, deviceKey, wrappedAccountKey, iv })
  } catch {
    // IndexedDB/WebCrypto unavailable or blocked: fall back to in-memory-only, silently.
  }
}

/**
 * Attempts to restore the account key persisted by `persistAccountKey` for `userId`.
 * Returns `null` (never throws) if there's no record, the record is corrupted/tampered
 * (AES-GCM tag mismatch), or storage is unavailable. Callers should treat `null` as
 * "no persisted key available" and fall back to requiring the password.
 */
export async function loadPersistedAccountKey(
  userId: string
): Promise<string | null> {
  try {
    const db = await openDb()
    const record = await getRecord(db, userId)
    if (!record) return null
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv as BufferSource },
      record.deviceKey,
      record.wrappedAccountKey
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}

/** Deletes only `userId`'s persisted record and reports whether storage completed. */
export async function clearPersistedAccountKey(
  userId: string
): Promise<boolean> {
  try {
    const db = await openDb()
    await deleteRecord(db, userId)
    return true
  } catch {
    return false
  }
}
