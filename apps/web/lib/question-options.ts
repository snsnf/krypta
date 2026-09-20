/**
 * A choice question's options as a respondent can actually tell them apart.
 *
 * An answer, a condition and a quiz key all name an option by its text, so two
 * options with the same text are one answer everywhere the choice is stored.
 * Rendering both made a published form show two radios that light up
 * together, and gave React two list items with the same key. Every place that
 * lists a question's choices by value (the respondent's field, Focus's letter
 * shortcuts, the answer key editor, the condition picker) uses this list, so
 * all of them agree on what the choices are and which letter picks which.
 *
 * Returns the input itself when nothing repeats.
 */
export function distinctOptions(
  options: readonly string[] | undefined
): string[] {
  if (options === undefined) return []
  const distinct = [...new Set(options)]
  return distinct.length === options.length ? (options as string[]) : distinct
}

/**
 * Whether two options share their text, for the builder to warn about. Blank
 * rows are options not typed yet rather than choices that collide.
 */
export function hasDuplicateOptions(
  options: readonly string[] | undefined
): boolean {
  const typed = (options ?? []).filter((option) => option !== "")
  return new Set(typed).size !== typed.length
}
