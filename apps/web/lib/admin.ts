import { apiFetch } from "./api"

export interface AdminMe {
  instance_admin: boolean
  totp_enabled: boolean
  second_factor_verified: boolean
}

export interface AdminCursor {
  id: string
  createdAt: string
}

interface AdminWireCursor {
  id: string
  created_at: string
}

export interface AdminAccount {
  id: string
  createdAt: string
  instanceAdmin: boolean
  suspended: boolean
  totpEnabled: boolean
  maxForms: number | null
  maxAttachmentBytes: number | null
  maxResponses: number | null
  formsUsed: number
  attachmentBytesUsed: number
}

interface AdminAccountWire {
  id: string
  created_at: string
  instance_admin: boolean
  suspended: boolean
  totp_enabled: boolean
  max_forms: number | null
  max_attachment_bytes: number | null
  max_responses: number | null
  forms_used: number
  attachment_bytes_used: number
}

export interface AdminAccountsPage {
  accounts: AdminAccount[]
  nextCursor: AdminCursor | null
}

export interface EligibleOwnershipTransfer {
  formId: string
  editorMemberIds: string[]
}

interface EligibleOwnershipTransferWire {
  form_id: string
  editor_member_ids: string[]
}

interface AdminAccountsWirePage {
  accounts: AdminAccountWire[]
  next_cursor: AdminWireCursor | null
}

export interface AdminSettings {
  registrationEnabled: boolean
  registerRateLimitPerHour: number
  loginRateLimitPerMinute: number
  defaultMaxForms: number
  defaultMaxAttachmentBytes: number
  // Null is "no instance-wide response cap", which is what an instance that
  // does not bill and has set none resolves to.
  defaultMaxResponsesPerPeriod: number | null
  mailConfigured: boolean
  // When this instance bills, every account resolves its quota through its
  // plan and the three defaults above are never reached. They stay editable
  // because they are the floor the instance falls back to without Stripe.
  billingEnabled: boolean
}

interface AdminSettingsWire {
  registration_enabled: boolean
  register_rate_limit_per_hour: number
  login_rate_limit_per_minute: number
  default_max_forms: number
  default_max_attachment_bytes: number
  default_max_responses_per_period: number | null
  mail_configured: boolean
  billing_enabled: boolean
}

interface AdminSettingsPatch {
  registrationEnabled?: boolean
  registerRateLimitPerHour?: number
  loginRateLimitPerMinute?: number
  defaultMaxForms?: number
  defaultMaxAttachmentBytes?: number
  // Explicitly null clears the cap, so this is only omitted when the field is
  // not being changed at all.
  defaultMaxResponsesPerPeriod?: number | null
}

export type AdminAuditAction =
  | "settings_updated"
  | "account_suspended"
  | "account_reactivated"
  | "form_transferred"
  | "account_deletion_started"
  | "account_deleted"

export type AdminAuditResult = "succeeded" | "rejected" | "failed"

export interface AdminAuditEvent {
  id: string
  actorUserId: string
  targetUserId: string | null
  action: AdminAuditAction
  result: AdminAuditResult
  createdAt: string
}

interface AdminAuditEventWire {
  id: string
  actor_user_id: string
  target_user_id: string | null
  action: AdminAuditAction
  result: AdminAuditResult
  created_at: string
}

export interface AdminAuditPage {
  events: AdminAuditEvent[]
  nextCursor: AdminCursor | null
}

interface AdminAuditWirePage {
  events: AdminAuditEventWire[]
  next_cursor: AdminWireCursor | null
}

interface AdminAccountsQuery {
  search?: string
  limit?: number
  cursor?: AdminCursor | null
}

interface AdminAuditQuery {
  action?: AdminAuditAction
  result?: AdminAuditResult
  limit?: number
  cursor?: AdminCursor | null
}

export function canOpenAdmin(me: AdminMe): boolean {
  return Boolean(
    me.instance_admin && me.totp_enabled && me.second_factor_verified
  )
}

function toCursor(
  cursor: AdminWireCursor | null | undefined
): AdminCursor | null {
  if (!cursor?.id || !cursor.created_at) return null
  return { id: cursor.id, createdAt: cursor.created_at }
}

function appendPagination(
  params: URLSearchParams,
  query: { limit?: number; cursor?: AdminCursor | null }
): void {
  if (query.limit !== undefined) params.set("limit", String(query.limit))
  if (query.cursor?.id && query.cursor.createdAt) {
    params.set("cursor_id", query.cursor.id)
    params.set("cursor_created_at", query.cursor.createdAt)
  }
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

function fromAccount(account: AdminAccountWire): AdminAccount {
  return {
    id: account.id,
    createdAt: account.created_at,
    instanceAdmin: account.instance_admin,
    suspended: account.suspended,
    totpEnabled: account.totp_enabled,
    maxForms: account.max_forms,
    maxAttachmentBytes: account.max_attachment_bytes,
    maxResponses: account.max_responses,
    formsUsed: account.forms_used,
    attachmentBytesUsed: account.attachment_bytes_used,
  }
}

function fromSettings(settings: AdminSettingsWire): AdminSettings {
  return {
    registrationEnabled: settings.registration_enabled,
    registerRateLimitPerHour: settings.register_rate_limit_per_hour,
    loginRateLimitPerMinute: settings.login_rate_limit_per_minute,
    defaultMaxForms: settings.default_max_forms,
    defaultMaxAttachmentBytes: settings.default_max_attachment_bytes,
    defaultMaxResponsesPerPeriod: settings.default_max_responses_per_period,
    mailConfigured: settings.mail_configured,
    billingEnabled: settings.billing_enabled,
  }
}

function fromAuditEvent(event: AdminAuditEventWire): AdminAuditEvent {
  return {
    id: event.id,
    actorUserId: event.actor_user_id,
    targetUserId: event.target_user_id,
    action: event.action,
    result: event.result,
    createdAt: event.created_at,
  }
}

export async function listAdminAccounts(
  query: AdminAccountsQuery = {}
): Promise<AdminAccountsPage> {
  const params = new URLSearchParams()
  if (query.search) params.set("search", query.search)
  appendPagination(params, query)
  const page = await apiFetch<AdminAccountsWirePage>(
    withQuery("/admin/accounts", params)
  )
  return {
    accounts: page.accounts.map(fromAccount),
    nextCursor: toCursor(page.next_cursor),
  }
}

export async function getAdminSettings(): Promise<AdminSettings> {
  return fromSettings(await apiFetch<AdminSettingsWire>("/admin/settings"))
}

export async function listEligibleOwnershipTransfers(
  accountId: string
): Promise<EligibleOwnershipTransfer[]> {
  const result = await apiFetch<{
    transfers: EligibleOwnershipTransferWire[]
  }>(`/admin/accounts/${accountId}/eligible-transfers`)
  return result.transfers.map((transfer) => ({
    formId: transfer.form_id,
    editorMemberIds: transfer.editor_member_ids,
  }))
}

export async function updateAdminSettings(
  patch: AdminSettingsPatch
): Promise<AdminSettings> {
  const body = {
    ...(patch.registrationEnabled !== undefined
      ? { registration_enabled: patch.registrationEnabled }
      : {}),
    ...(patch.registerRateLimitPerHour !== undefined
      ? { register_rate_limit_per_hour: patch.registerRateLimitPerHour }
      : {}),
    ...(patch.loginRateLimitPerMinute !== undefined
      ? { login_rate_limit_per_minute: patch.loginRateLimitPerMinute }
      : {}),
    ...(patch.defaultMaxForms !== undefined
      ? { default_max_forms: patch.defaultMaxForms }
      : {}),
    ...(patch.defaultMaxAttachmentBytes !== undefined
      ? { default_max_attachment_bytes: patch.defaultMaxAttachmentBytes }
      : {}),
    ...(patch.defaultMaxResponsesPerPeriod !== undefined
      ? { default_max_responses_per_period: patch.defaultMaxResponsesPerPeriod }
      : {}),
  }
  return fromSettings(
    await apiFetch<AdminSettingsWire>("/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  )
}

export async function suspendAccount(accountId: string): Promise<void> {
  await apiFetch(`/admin/accounts/${accountId}/suspend`, { method: "POST" })
}

export async function reactivateAccount(accountId: string): Promise<void> {
  await apiFetch(`/admin/accounts/${accountId}/reactivate`, { method: "POST" })
}

export async function transferAdminForm(
  formId: string,
  editorMemberId: string
): Promise<void> {
  await apiFetch(`/admin/forms/${formId}/transfer`, {
    method: "POST",
    body: JSON.stringify({ member_id: editorMemberId }),
  })
}

export async function deleteAccount(
  accountId: string,
  reauthenticationReceipt: string
): Promise<void> {
  await apiFetch(`/admin/accounts/${accountId}`, {
    method: "DELETE",
    body: JSON.stringify({
      reauthentication_receipt: reauthenticationReceipt,
    }),
  })
}

export async function listAuditEvents(
  query: AdminAuditQuery = {}
): Promise<AdminAuditPage> {
  const params = new URLSearchParams()
  if (query.action) params.set("action", query.action)
  if (query.result) params.set("result", query.result)
  appendPagination(params, query)
  const page = await apiFetch<AdminAuditWirePage>(
    withQuery("/admin/audit", params)
  )
  return {
    events: page.events.map(fromAuditEvent),
    nextCursor: toCursor(page.next_cursor),
  }
}
