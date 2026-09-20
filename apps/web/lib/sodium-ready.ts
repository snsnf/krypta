"use client"
import sodium from "libsodium-wrappers-sumo"

let readyPromise: Promise<void> | null = null
export function ensureSodiumReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = sodium.ready
  }
  return readyPromise
}
