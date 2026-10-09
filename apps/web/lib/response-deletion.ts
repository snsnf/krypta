import { ApiClientError } from "./api"

export interface ResponseDeletionResult {
  /** Ids now gone from the server, including any that were already gone. */
  deleted: string[]
  failed: number
}

/**
 * Deletes responses one at a time and reports which went. Each delete locks
 * the form row, so firing them in parallel would only queue them on that
 * lock. A failure does not stop the rest: every response the owner chose is
 * attempted, and the caller restores only the ones that failed.
 */
export async function deleteResponsesInTurn<T extends { id: string }>(
  responses: readonly T[],
  deleteOne: (response: T) => Promise<unknown>
): Promise<ResponseDeletionResult> {
  const deleted: string[] = []
  let failed = 0
  for (const response of responses) {
    try {
      await deleteOne(response)
      deleted.push(response.id)
    } catch (error) {
      if (isAlreadyGone(error)) deleted.push(response.id)
      else failed += 1
    }
  }
  return { deleted, failed }
}

/**
 * The endpoint isn't idempotent: a retry after the delete already committed
 * gets a 404 because the row is genuinely gone, which is the outcome the
 * owner asked for. An attachment id the server rejects (e.g. one belonging to
 * another form) comes back as `bad_request`, not `not_found`, so `not_found`
 * means only "already gone" and must not be broadened into swallowing a real
 * rejection.
 */
function isAlreadyGone(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "not_found"
}
