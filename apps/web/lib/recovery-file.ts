import type { AppTranslator } from "./app-translator"
import type { AppLanguage } from "./app-locale"

/**
 * The text of the downloadable recovery-code file, in the app's language.
 *
 * Non-English text starts with a byte-order mark. A Blob always encodes its
 * strings as UTF-8, and a charset in its MIME type is only a hint some tools
 * ignore, so the mark is what lets an older editor open Arabic correctly. The
 * English file is exactly what it always was, with no mark.
 */
export function recoveryFileText(
  code: string,
  t: AppTranslator,
  language: AppLanguage
): string {
  return (
    (language === "en" ? "" : "﻿") +
    `${t("auth.recoveryCard.fileTitle")}\n\n` +
    `${code}\n\n` +
    t("auth.recoveryCard.fileBody")
  )
}
