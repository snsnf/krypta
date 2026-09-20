"use client"

import { useSyncExternalStore } from "react"

function subscribeToColorScheme(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
  mediaQuery.addEventListener("change", onStoreChange)
  return () => mediaQuery.removeEventListener("change", onStoreChange)
}

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

/**
 * Whether the device asks for dark mode, kept current as that setting
 * changes. False on the server, where there is no device to ask.
 *
 * What a form's "System" choice resolves to, in the builder and on the public
 * form alike.
 */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(
    subscribeToColorScheme,
    systemPrefersDark,
    () => false
  )
}
