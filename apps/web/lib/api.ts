export interface FormListWireItem {
  id: string
  role: "owner" | "editor" | "viewer"
  membership_state: "active" | "awaiting_keys"
  title_ciphertext: string | null
  key_scheme: "master_wrap_v1" | "account_sealed_box_v1" | null
  encrypted_form_data_key: string | null
  encrypted_form_private_key: string | null
  created_at: string
  archived_at: string | null
  /**
   * The form's version at the moment the list was read, or null when this
   * member cannot read the form. A rename sends this back as
   * `expected_version`: see the comment on the query in `list_forms`.
   */
  version: number | null
}

export class ApiClientError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080/api/v1"

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  const body = await res.json()
  if (!body.success) {
    throw new ApiClientError(
      body.error?.code ?? "unknown",
      body.error?.message ?? "Request failed"
    )
  }
  return body.data as T
}

export async function apiUploadBytes<T>(
  path: string,
  bytes: Uint8Array
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/octet-stream" },
    // Uint8Array is valid BodyInit at runtime; this TS lib version doesn't structurally accept it.
    body: bytes as BodyInit,
  })
  const body = await res.json()
  if (!body.success) {
    throw new ApiClientError(
      body.error?.code ?? "unknown",
      body.error?.message ?? "Request failed"
    )
  }
  return body.data as T
}

// Narrow variant of `apiFetch` for the one caller that needs to tell "this
// route does not exist on this instance" (a plain, envelope-less 404, which
// only happens when a whole router is conditionally unmounted, as billing is
// when Stripe is not configured) apart from a genuine failure. `apiFetch`
// itself is left untouched: it has many callers and none of them need this.
export async function apiFetchWithStatus<T>(
  path: string,
  init?: RequestInit
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  if (res.status === 404) {
    return { status: 404, data: null }
  }
  const body = await res.json().catch(() => null)
  if (!body || !body.success) {
    throw new ApiClientError(
      body?.error?.code ?? "unknown",
      body?.error?.message ?? "Request failed"
    )
  }
  return { status: res.status, data: body.data as T }
}

export async function apiDownloadBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiClientError(
      body?.error?.code ?? "unknown",
      body?.error?.message ?? "Request failed"
    )
  }
  const buffer = await res.arrayBuffer()
  return new Uint8Array(buffer)
}
