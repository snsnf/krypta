import {
  decryptWithKey,
  matchesFormKeyCommitment,
  type FormSchema,
  type FormSettings,
  type FormTheme,
  type Question,
} from "@krypta/crypto"
import { apiFetch } from "./api"
import { normalizeFormTheme } from "./form-theme"
import { normalizeFormSettings } from "./form-settings"

/**
 * The key this form would seal answers to is not the one its owner committed
 * to in the encrypted schema. Nothing has been sealed or sent when this is
 * thrown: it stops the form from opening at all.
 */
export class FormKeyMismatchError extends Error {
  constructor() {
    super("form public key does not match its commitment")
  }
}

interface PublicForm {
  title: string
  questions: Question[]
  theme: FormTheme
  settings: FormSettings
  publicKey: string
  acceptingResponses: boolean
  headerImage: boolean
}

export async function loadPublicForm(
  formId: string,
  schemaKey: string
): Promise<PublicForm> {
  const form = await apiFetch<{
    title_ciphertext: string
    schema_ciphertext: string
    form_public_key: string
    accepting_responses: boolean
    header_image?: boolean
  }>(`/forms/${formId}/public`)

  const title = decryptWithKey(form.title_ciphertext, schemaKey)
  const schema = JSON.parse(
    decryptWithKey(form.schema_ciphertext, schemaKey)
  ) as FormSchema

  // The server serves form_public_key in the clear and every answer is sealed
  // to it. The schema was authenticated just now by the link's key, which the
  // server never holds, so its commitment is the one statement about the key
  // the server cannot have rewritten. A schema without one is refused too:
  // every schema this app writes carries it, so a missing one means the form
  // predates the check, and passing it would be a way around the check.
  if (
    typeof schema.publicKeyCommitment !== "string" ||
    !matchesFormKeyCommitment(form.form_public_key, schema.publicKeyCommitment)
  ) {
    throw new FormKeyMismatchError()
  }

  return {
    title,
    questions: schema.questions,
    theme: normalizeFormTheme(schema.theme),
    settings: normalizeFormSettings(schema.settings),
    publicKey: form.form_public_key,
    acceptingResponses: form.accepting_responses === true,
    headerImage: form.header_image === true,
  }
}
