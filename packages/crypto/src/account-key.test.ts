import sodium from "libsodium-wrappers-sumo"
import { describe, expect, it } from "vitest"
import { deriveUnlockKey, deriveVaultSalt } from "./account-key"

// The browser derivation is the only Argon2id that protects user content, and
// its cost is what an attacker holding a database dump pays per password
// guess. It is requested by libsodium's MODERATE preset rather than by number,
// so this pins the numbers the preset resolves to: 256 MiB, 3 passes, 1 lane.
// A libsodium upgrade that moved the preset would fail here rather than
// silently changing the cost of every future signup.
describe("deriveUnlockKey", () => {
  it("resolves MODERATE to 256 MiB and 3 passes of Argon2id v1.3", async () => {
    await sodium.ready
    expect(sodium.crypto_pwhash_MEMLIMIT_MODERATE).toBe(256 * 1024 * 1024)
    expect(sodium.crypto_pwhash_OPSLIMIT_MODERATE).toBe(3)
    expect(sodium.crypto_pwhash_ALG_ARGON2ID13).toBe(2)
  })

  // A known answer covers what the constants cannot: that the function still
  // calls Argon2id with them, over the salt derived from the address. Changing
  // any of those locks every existing account out, which is what this proves
  // has not happened.
  it("derives a stable key for a fixed password and address", async () => {
    const key = await deriveUnlockKey(
      "correct horse battery staple",
      deriveVaultSalt("Alice@Example.com")
    )
    expect(key).toBe("B8EvKaMPVt_loA_mMn5zwnbNtksDlFXvm7Eq01I0u1Y")
  }, 30_000)
})
