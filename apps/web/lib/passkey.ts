import {
  derivePasskeyUnlockKey,
  passkeyPrfSalt,
  unwrapAccountKeyForPasskey,
  wrapAccountKeyForPasskey,
} from "@krypta/crypto"
import { apiFetch } from "@/lib/api"
import { ensureSodiumReady } from "@/lib/sodium-ready"

/** Thrown when the authenticator cannot hold an encryption key. */
export class PasskeyUnsupportedError extends Error {
  constructor() {
    super("This device cannot store an encryption key")
    this.name = "PasskeyUnsupportedError"
  }
}

/**
 * Thrown when enrolment is cancelled at the SECOND prompt, the PRF assertion
 * `enrollPasskey` requests after `create()` has already succeeded.
 *
 * Distinct from a first-prompt cancellation on purpose: by the time this
 * prompt appears, a credential already exists on the authenticator that the
 * server never learned about, since `register/finish` is never called. The
 * caller must say so rather than reporting a clean cancel.
 */
export class PasskeyStrandedCredentialError extends Error {
  constructor() {
    super("Passkey setup was cancelled after a credential was created")
    this.name = "PasskeyStrandedCredentialError"
  }
}

const MIN_PRF_OUTPUT_BYTES = 32

export function bufferToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function prfResults(results: unknown): Record<string, unknown> | null {
  if (typeof results !== "object" || results === null) return null
  const prf = (results as Record<string, unknown>).prf
  if (typeof prf !== "object" || prf === null) return null
  return prf as Record<string, unknown>
}

/**
 * Reads the PRF output, or null when there is not a usable one.
 *
 * Deliberately does not gate on `enabled`: per the WebAuthn spec, `enabled` is
 * reported only on `create()` results. An assertion from `get()` returns just
 * `{ prf: { results: { first } } }` with no `enabled` field at all, so gating
 * on it here would reject every valid login. This function decides purely on
 * whether `results.first` is present and long enough; `prfSupportFrom` is
 * where the `enabled` check belongs, because it is only ever applied to
 * creation results.
 */
export function readPrfOutput(results: unknown): Uint8Array | null {
  const prf = prfResults(results)
  if (!prf) return null
  const first = (prf.results as Record<string, unknown> | undefined)?.first
  if (!first) return null
  const bytes =
    first instanceof Uint8Array ? first : new Uint8Array(first as ArrayBuffer)
  return bytes.length >= MIN_PRF_OUTPUT_BYTES ? bytes : null
}

/**
 * Classifies PRF support from a `create()` result only.
 *
 * `enabled` is authoritative here because it is only ever reported on
 * creation results (see `readPrfOutput`). Do not call this on an assertion
 * from `get()`; it would report "unsupported" for perfectly valid output.
 */
export function prfSupportFrom(
  results: unknown
): "usable" | "needs-assertion" | "unsupported" {
  const prf = prfResults(results)
  if (!prf || prf.enabled !== true) return "unsupported"
  return readPrfOutput(results) ? "usable" : "needs-assertion"
}

export function decodeOptions<T>(options: unknown): T {
  // The API sends WebAuthn's binary fields as base64url strings; the browser
  // wants BufferSources.
  const clone = JSON.parse(JSON.stringify(options)) as Record<string, unknown>
  const key = clone.publicKey as Record<string, unknown>
  key.challenge = base64UrlToBytes(key.challenge as string)
  if (key.user) {
    const user = key.user as Record<string, unknown>
    user.id = base64UrlToBytes(user.id as string)
  }
  for (const field of ["excludeCredentials", "allowCredentials"]) {
    const list = key[field] as Array<Record<string, unknown>> | undefined
    if (Array.isArray(list)) {
      for (const item of list) item.id = base64UrlToBytes(item.id as string)
    }
  }
  return clone as T
}

/**
 * Enrols a passkey and wraps the account key under its PRF output.
 *
 * Requires an unlocked vault, because the account key must be in memory to be
 * wrapped, and a reauthentication receipt, because a passkey is a standing way
 * into the account that a session alone must not be able to add.
 */
export async function enrollPasskey(
  accountKey: string,
  nickname: string,
  reauthenticationReceipt: string
): Promise<void> {
  await ensureSodiumReady()
  const salt = passkeyPrfSalt()

  const start = await apiFetch<{ ceremony_token: string; options: unknown }>(
    "/auth/passkeys/register/start",
    {
      method: "POST",
      body: JSON.stringify({
        reauthentication_receipt: reauthenticationReceipt,
      }),
    }
  )
  const options = decodeOptions<{
    publicKey: PublicKeyCredentialCreationOptions
  }>(start.options)
  options.publicKey.extensions = {
    ...options.publicKey.extensions,
    prf: { eval: { first: salt } },
  } as AuthenticationExtensionsClientInputs

  // Discoverable login is the only login path (there is no username step), so
  // a credential that is not discoverable would enrol successfully and then
  // never appear at sign-in. The server's own options do not set this
  // (`start_passkey_registration` calls `require_resident_key(false)`), so it
  // must be set here. userVerification already happens to be Required because
  // the crate pins it, but it is set explicitly anyway rather than depending
  // on that. Merge rather than replace so any other authenticatorSelection
  // fields the server sent are preserved.
  options.publicKey.authenticatorSelection = {
    ...options.publicKey.authenticatorSelection,
    residentKey: "required",
    userVerification: "required",
  }

  const created = (await navigator.credentials.create({
    publicKey: options.publicKey,
  })) as PublicKeyCredential | null
  if (!created) throw new PasskeyUnsupportedError()

  const support = prfSupportFrom(created.getClientExtensionResults())
  if (support === "unsupported") throw new PasskeyUnsupportedError()

  let prfOutput = readPrfOutput(created.getClientExtensionResults())
  if (!prfOutput) {
    // The second prompt. This assertion's challenge is generated locally and
    // is NEVER sent to the server, deliberately: we are not authenticating
    // with it, we only want the PRF bytes, and the credential is not
    // registered server-side yet so the server could not verify it anyway.
    // Adding a server round-trip here would be authenticating a credential the
    // server has never heard of.
    let assertion: PublicKeyCredential | null
    try {
      assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: created.rawId, type: "public-key" }],
          userVerification: "required",
          extensions: {
            prf: { eval: { first: salt } },
          } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null
    } catch (err) {
      // `create()` already succeeded, so a cancel here leaves a credential
      // stranded on the device that the server never learned about. That is
      // a different outcome from cancelling the first prompt and must be
      // reported as such, not as a clean cancellation.
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        throw new PasskeyStrandedCredentialError()
      }
      throw err
    }
    prfOutput = assertion
      ? readPrfOutput(assertion.getClientExtensionResults())
      : null
  }
  if (!prfOutput) throw new PasskeyUnsupportedError()

  const attestation = created.response as AuthenticatorAttestationResponse
  await apiFetch("/auth/passkeys/register/finish", {
    method: "POST",
    body: JSON.stringify({
      ceremony_token: start.ceremony_token,
      credential: {
        id: created.id,
        rawId: bufferToBase64Url(created.rawId),
        type: created.type,
        response: {
          attestationObject: bufferToBase64Url(attestation.attestationObject),
          clientDataJSON: bufferToBase64Url(attestation.clientDataJSON),
        },
      },
      wrapped_account_key: wrapAccountKeyForPasskey(
        accountKey,
        derivePasskeyUnlockKey(prfOutput)
      ),
      nickname,
    }),
  })
}

/** Signs in with a discoverable passkey and opens the vault. */
export async function loginWithPasskey(): Promise<{
  userId: string
  accountKey: string
}> {
  await ensureSodiumReady()
  const salt = passkeyPrfSalt()

  const start = await apiFetch<{ ceremony_token: string; options: unknown }>(
    "/auth/passkeys/login/start",
    { method: "POST", body: JSON.stringify({}) }
  )
  const options = decodeOptions<{
    publicKey: PublicKeyCredentialRequestOptions
  }>(start.options)
  options.publicKey.extensions = {
    ...options.publicKey.extensions,
    prf: { eval: { first: salt } },
  } as AuthenticationExtensionsClientInputs

  // Pass ONLY `publicKey`. The server's response also carries
  // `mediation: "conditional"`, which webauthn-rs hard-codes onto every
  // discoverable challenge (see its `start_discoverable_authentication`).
  // Conditional mediation is autofill UI: it renders no modal and silently
  // does nothing unless an input carries autocomplete="webauthn". Forwarding
  // it here, for instance by spreading the whole options object, would turn
  // the "Sign in with a passkey" button into a no-op with no error.
  const assertion = (await navigator.credentials.get({
    publicKey: options.publicKey,
  })) as PublicKeyCredential | null
  if (!assertion) throw new PasskeyUnsupportedError()

  const prfOutput = readPrfOutput(assertion.getClientExtensionResults())
  if (!prfOutput) throw new PasskeyUnsupportedError()

  const response = assertion.response as AuthenticatorAssertionResponse
  const result = await apiFetch<{
    user_id: string
    wrapped_account_key: string
  }>("/auth/passkeys/login/finish", {
    method: "POST",
    body: JSON.stringify({
      ceremony_token: start.ceremony_token,
      credential: {
        id: assertion.id,
        rawId: bufferToBase64Url(assertion.rawId),
        type: assertion.type,
        response: {
          authenticatorData: bufferToBase64Url(response.authenticatorData),
          clientDataJSON: bufferToBase64Url(response.clientDataJSON),
          signature: bufferToBase64Url(response.signature),
          userHandle: response.userHandle
            ? bufferToBase64Url(response.userHandle)
            : null,
        },
      },
    }),
  })

  return {
    userId: result.user_id,
    accountKey: unwrapAccountKeyForPasskey(
      result.wrapped_account_key,
      derivePasskeyUnlockKey(prfOutput)
    ),
  }
}
