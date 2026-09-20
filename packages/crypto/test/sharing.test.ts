import { describe, expect, it } from "vitest"
import {
  createAccountSharingKey,
  generateSymmetricKey,
  openSealedFormGrant,
  openSharingPrivateKey,
  sealFormGrant,
} from "../src"

describe("account sharing grants", () => {
  it("wraps the account private key and opens a two-key form grant", () => {
    const masterKey = generateSymmetricKey()
    const account = createAccountSharingKey(masterKey)
    const sharingPrivateKey = openSharingPrivateKey(account, masterKey)
    const formDataKey = generateSymmetricKey()
    const formPrivateKey = generateSymmetricKey()
    const grant = sealFormGrant(
      formDataKey,
      formPrivateKey,
      account.sharingPublicKey
    )

    expect(grant.keyScheme).toBe("account_sealed_box_v1")
    expect(openSealedFormGrant(grant, sharingPrivateKey)).toEqual({
      formDataKey,
      formPrivateKey,
    })
  })

  it("fails closed with another account's private key", () => {
    const firstMaster = generateSymmetricKey()
    const secondMaster = generateSymmetricKey()
    const first = createAccountSharingKey(firstMaster)
    const second = createAccountSharingKey(secondMaster)
    const grant = sealFormGrant(
      generateSymmetricKey(),
      generateSymmetricKey(),
      first.sharingPublicKey
    )

    expect(() =>
      openSealedFormGrant(grant, openSharingPrivateKey(second, secondMaster))
    ).toThrow()
  })
})
