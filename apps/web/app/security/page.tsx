import type { Metadata } from "next"
import {
  ProseLead,
  ProseList,
  ProsePage,
  ProseSection,
  ProseText,
} from "@/components/prose-page"

/*
 * The public half of SECURITY.md, for someone deciding whether to trust an
 * instance before they read any code.
 *
 * It may say less than SECURITY.md and must never say more, and the limits
 * below are not a disclaimer to be softened later: a reader who finds them
 * listed plainly has a reason to believe the guarantee above them. Changing a
 * default, a header or a limit means changing the code, SECURITY.md and this
 * page together.
 */
export const metadata: Metadata = {
  title: "Security",
  description:
    "What krypta encrypts, what the server can still see, and what this design does not protect against.",
  alternates: { canonical: "/security" },
}

const SERVER_SEES = [
  "That an account exists for an address, and when it was created. The API never confirms this to an unauthenticated caller: registering an address that already exists returns the same response as a fresh signup.",
  "When forms and responses were created, and how many of each exist.",
  "The size of uploaded files, because storage quotas are counted against it. Ciphertext lengths for titles, questions and responses are padded to a floor of 1024 bytes, so those sizes reveal close to nothing.",
  "The close date and response cap of a form, which are readable because a limit the server cannot read is a limit it cannot enforce.",
  "Whether a form is accepting responses, and who collaborates on it in what role.",
  "TOTP secrets, which must be readable to verify codes. That is an authentication factor rather than form content.",
]

const LIMITS = [
  {
    title: "An operator serving modified JavaScript",
    body: "The encryption happens in code the server delivers. An operator who changes that code could take keys out of the page before anything is encrypted. No protocol change fixes this. It is the irreducible limit of browser-delivered end-to-end encryption, and it is why the licence is AGPL and why building from source is a supported path: you can run code you have read instead of a binary someone handed you.",
  },
  {
    title: "A weak password, once the database leaks",
    body: "The server stores a hash of a verifier that is itself derived from your password. Someone holding the database can still guess offline. Each guess costs 256 MiB of memory and three passes of Argon2id, and a test pins those numbers so an upgrade cannot lower them, but strong passwords are still load-bearing. Signup requires twelve characters and cannot check more than that, because the server never receives the password to measure it.",
  },
  {
    title: "Losing both your password and your vault recovery code",
    body: "There is no password reset that recovers your data, no administrator who can help, and no key escrow. The vault becomes permanently unreadable. While you can still sign in you can mint a fresh vault recovery code from settings, so losing the code alone is survivable.",
  },
  {
    title: "Content validation",
    body: "The server cannot check what it cannot read. There is no MIME sniffing, no magic-number check and no virus scanning on uploads, because the bytes arrive already encrypted. Required fields and conditional questions are enforced in the browser only. Treat a downloaded attachment the way you would treat any file a stranger sent you.",
  },
  {
    title: "Removing a collaborator is not retroactive",
    body: "Removing someone, revoking an invitation or transferring ownership stops future access through the API. It cannot erase keys, ciphertext or plaintext they already copied.",
  },
  {
    title: "One response per person",
    body: "Submission is anonymous by design, so this is a courtesy enforced in the browser and nothing more. It cannot be enforced without collecting something identifying.",
  },
]

export default function SecurityPage() {
  return (
    <ProsePage title="Security">
      <ProseLead>
        Form questions, responses, file attachments and form titles are
        encrypted in the browser before they are sent. The server stores and
        moves ciphertext and holds no key that opens any of it. That is the
        whole claim, and it is the only one worth trusting: a database dump, a
        stolen backup, a compromised host or a subpoena to the operator yields
        ciphertext.
      </ProseLead>
      <ProseText>
        Your password never reaches the server either. The browser derives a key
        from it and sends a one-way verifier instead, so the password is absent
        from the wire, from request logs and from the memory of the server.
      </ProseText>

      <ProseSection title="What the server can still see">
        <ProseText>
          Zero knowledge is about content. Some metadata is unavoidable if the
          service is to work at all, and pretending otherwise would be
          dishonest.
        </ProseText>
        <ProseList items={SERVER_SEES} />
      </ProseSection>

      <ProseSection title="What this does not protect against">
        <ProseText>
          These are real limits rather than oversights. Anyone relying on the
          guarantee above should read them.
        </ProseText>
        <div className="mt-8 flex flex-col gap-8">
          {LIMITS.map((limit) => (
            <div key={limit.title}>
              <h3 className="font-heading text-lg font-semibold tracking-[-0.01em]">
                {limit.title}
              </h3>
              <p className="mt-3 leading-relaxed text-muted-foreground">
                {limit.body}
              </p>
            </div>
          ))}
        </div>
      </ProseSection>

      <ProseSection title="How keys are handled">
        <ProseText>
          A random 32-byte account key is generated in your browser and sits
          between your password and everything else. Each unlock method wraps it
          separately, and those wrapped blobs are all the server stores: your
          password through Argon2id, your vault recovery code the same way, and
          a passkey through its WebAuthn PRF output.
        </ProseText>
        <ProseText>
          That account key in turn wraps every form key and the sharing key of
          the account. Nothing below it is tied to the password, which is why
          recovering an account re-wraps rather than re-encrypts, and why adding
          a passkey is a new wrapper rather than a migration.
        </ProseText>
        <ProseText>
          Responses are sealed to the public key of a form with X-Wing, the
          hybrid of ML-KEM-768 and X25519, under ChaCha20-Poly1305. The hybrid
          is deliberate: a total break of ML-KEM leaves the seal exactly as safe
          as the X25519 it replaced. Worth knowing before you depend on it, the
          post-quantum library is pinned to an exact version and its maintainers
          state that it has not been independently audited. Everything else is
          libsodium.
        </ProseText>
      </ProseSection>

      <ProseSection title="Reporting a vulnerability">
        <ProseText>
          Report privately through the security advisories of the repository
          rather than opening a public issue, and please include enough detail
          to reproduce. If you believe user data is at risk on a running
          instance, say so in the first line. You are welcome to test against
          your own instance. Do not test against instances you do not operate.
        </ProseText>
        <ProseText>
          The full text, including session lifetimes, the rate-limit table and
          the upload limits, ships with the source as SECURITY.md.
        </ProseText>
      </ProseSection>
    </ProsePage>
  )
}
