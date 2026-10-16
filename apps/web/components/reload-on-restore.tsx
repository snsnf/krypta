"use client"

import { useEffect } from "react"

/**
 * Reloads a signed-in page the browser restores from its back/forward cache.
 *
 * A restored page comes back exactly as it was left, decrypted responses and
 * any code it had just shown included, without asking the server anything.
 * After a sign-out on a shared device, Back could then show the next person
 * what the last one saw. Reloading makes the page ask for the session again,
 * which a signed-out browser no longer has, and it lands on the login page.
 */
export function ReloadOnRestore() {
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) window.location.reload()
    }
    window.addEventListener("pageshow", onPageShow)
    return () => window.removeEventListener("pageshow", onPageShow)
  }, [])
  return null
}
