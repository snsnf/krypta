import {
  encryptWithKey,
  formKeyCommitment,
  generateSealKeyPair,
  generateSymmetricKey,
  wrapKey,
  type FormSchema,
  type FormSettings,
  type FormTheme,
  type Question,
} from "@krypta/crypto"
import { apiFetch } from "./api"
import { reconcileAnswerKey, type AnswerKey } from "./quiz"
import { sealAnswerKey } from "./quiz-sealing"
import { ensureSodiumReady } from "./sodium-ready"

/**
 * Creates a form with brand-new keys. The one place a form is born, shared by
 * New form and Duplicate so the key handling exists once.
 */
export interface CreateFormInput {
  accountKey: string
  title: string
  questions: Question[]
  theme: FormTheme
  settings: FormSettings
  answerKey: AnswerKey | null
  allowResponseEditing: boolean
  acceptingResponses: boolean
  closesAt: string | null
  maxResponses: number | null
  notifyOnResponse: boolean
}

export async function createForm(
  input: CreateFormInput
): Promise<{ id: string; formDataKey: string }> {
  await ensureSodiumReady()

  const formDataKey = generateSymmetricKey()
  const { publicKey, privateKey } = generateSealKeyPair()
  // Binds the key respondents seal to into the schema the link's key
  // authenticates, so a key swapped in the database is refused.
  const schema: FormSchema = {
    questions: input.questions,
    theme: input.theme,
    settings: input.settings,
    publicKeyCommitment: formKeyCommitment(publicKey),
  }

  const { id } = await apiFetch<{ id: string }>("/forms", {
    method: "POST",
    body: JSON.stringify({
      title_ciphertext: encryptWithKey(input.title, formDataKey),
      schema_ciphertext: encryptWithKey(JSON.stringify(schema), formDataKey),
      form_public_key: publicKey,
      wrapped_form_private_key: wrapKey(privateKey, input.accountKey),
      wrapped_form_data_key: wrapKey(formDataKey, input.accountKey),
      // Sealed under the key derived from the private key just generated,
      // never under the form data key that goes into the link.
      answer_key_ciphertext: input.answerKey
        ? sealAnswerKey(
            reconcileAnswerKey(input.questions, input.answerKey),
            privateKey
          )
        : undefined,
      // The confirmation message and one-response-per-person are not here:
      // they sit in `settings`, inside the encrypted schema.
      allow_response_editing: input.allowResponseEditing,
      accepting_responses: input.acceptingResponses,
      closes_at: input.closesAt,
      max_responses: input.maxResponses,
      notify_on_response: input.notifyOnResponse,
    }),
  })

  return { id, formDataKey }
}
