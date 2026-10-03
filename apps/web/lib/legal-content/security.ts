import type { LocalizedDoc } from "./types"

/*
 * The public half of SECURITY.md, for someone deciding whether to trust an
 * instance before they read any code. It may say less than SECURITY.md and
 * must never say more, in either language. Changing a default, a header or a
 * limit means changing the code, SECURITY.md and both texts together.
 */
export const SECURITY: LocalizedDoc = {
  en: {
    title: "Security",
    description:
      "What krypta encrypts, what the server can still see, and what this design does not protect against.",
    lead: "Form questions, responses, file attachments and form titles are encrypted in the browser before they are sent. The server stores and moves ciphertext and holds no key that opens any of it. That is the whole claim, and it is the only one worth trusting: a database dump, a stolen backup, a compromised host or a subpoena to the operator yields ciphertext.",
    intro: [
      "Your password never reaches the server either. The browser derives a key from it and sends a one-way verifier instead, so the password is absent from the wire, from request logs and from the memory of the server.",
    ],
    sections: [
      {
        title: "What the server can still see",
        blocks: [
          {
            kind: "text",
            text: "Zero knowledge is about content. Some metadata is unavoidable if the service is to work at all, and pretending otherwise would be dishonest.",
          },
          {
            kind: "list",
            items: [
              "That an account exists for an address, and when it was created. The API never confirms this to an unauthenticated caller: registering an address that already exists returns the same response as a fresh signup.",
              "When forms and responses were created, and how many of each exist.",
              "The size of uploaded files, because storage quotas are counted against it. Ciphertext lengths for titles, questions and responses are padded to a floor of 1024 bytes, so those sizes reveal close to nothing.",
              "The close date and response cap of a form, which are readable because a limit the server cannot read is a limit it cannot enforce.",
              "Whether a form is accepting responses, and who collaborates on it in what role.",
              "TOTP secrets, which must be readable to verify codes. That is an authentication factor rather than form content.",
            ],
          },
        ],
      },
      {
        title: "What this does not protect against",
        blocks: [
          {
            kind: "text",
            text: "These are real limits rather than oversights. Anyone relying on the guarantee above should read them.",
          },
          {
            kind: "limits",
            items: [
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
            ],
          },
        ],
      },
      {
        title: "How keys are handled",
        blocks: [
          {
            kind: "text",
            text: "A random 32-byte account key is generated in your browser and sits between your password and everything else. Each unlock method wraps it separately, and those wrapped blobs are all the server stores: your password through Argon2id, your vault recovery code the same way, and a passkey through its WebAuthn PRF output.",
          },
          {
            kind: "text",
            text: "That account key in turn wraps every form key and the sharing key of the account. Nothing below it is tied to the password, which is why recovering an account re-wraps rather than re-encrypts, and why adding a passkey is a new wrapper rather than a migration.",
          },
          {
            kind: "text",
            text: "Responses are sealed to the public key of a form with X-Wing, the hybrid of ML-KEM-768 and X25519, under ChaCha20-Poly1305. The hybrid is deliberate: a total break of ML-KEM leaves the seal exactly as safe as the X25519 it replaced. Worth knowing before you depend on it, the post-quantum library is pinned to an exact version and its maintainers state that it has not been independently audited. Everything else is libsodium.",
          },
        ],
      },
      {
        title: "Reporting a vulnerability",
        blocks: [
          {
            kind: "text",
            text: "Report privately through the security advisories of the repository rather than opening a public issue, and please include enough detail to reproduce. If you believe user data is at risk on a running instance, say so in the first line. You are welcome to test against your own instance. Do not test against instances you do not operate.",
          },
          {
            kind: "text",
            text: "The full text, including session lifetimes, the rate-limit table and the upload limits, ships with the source as SECURITY.md.",
          },
        ],
      },
    ],
  },
  ar: {
    title: "الأمان",
    description:
      "ما يشفّره krypta، وما يستطيع الخادم رؤيته رغم ذلك، وما لا يحمي منه هذا التصميم.",
    lead: "تُشفَّر أسئلة النماذج وردودها ومرفقاتها وعناوينها في المتصفح قبل إرسالها. يخزّن الخادم نصًا مشفرًا وينقله ولا يملك أي مفتاح يفتح شيئًا منه. هذا هو الادعاء كله، وهو الوحيد الذي يستحق الثقة: نسخة من قاعدة البيانات أو نسخة احتياطية مسروقة أو خادم مخترق أو أمر قضائي إلى المشغّل لا تُنتج إلا نصًا مشفرًا. هذه الصفحة ترجمة للنص الإنجليزي، وعند أي اختلاف بين النصين يُعتمد النص الإنجليزي.",
    intro: [
      "كلمة مرورك أيضًا لا تصل إلى الخادم. يشتق المتصفح منها مفتاحًا ويرسل مُحقِّقًا أحادي الاتجاه بدلًا منها، فتغيب كلمة المرور عن الشبكة وعن سجلات الطلبات وعن ذاكرة الخادم.",
    ],
    sections: [
      {
        title: "ما يستطيع الخادم رؤيته رغم ذلك",
        blocks: [
          {
            kind: "text",
            text: "انعدام المعرفة يخص المحتوى. بعض البيانات الوصفية لا مفر منها كي تعمل الخدمة أصلًا، والتظاهر بغير ذلك غير صادق.",
          },
          {
            kind: "list",
            items: [
              "أن لعنوان بريد حسابًا، ومتى أُنشئ. لا يؤكد الواجهة البرمجية ذلك أبدًا لمن لم يسجّل الدخول: التسجيل بعنوان موجود يعيد الاستجابة نفسها لتسجيل جديد.",
              "متى أُنشئت النماذج والردود، وكم يوجد من كل منهما.",
              "حجم الملفات المرفوعة، لأن حصص التخزين تُحتسب عليه. أما أطوال النصوص المشفرة للعناوين والأسئلة والردود فتُحشى إلى حد أدنى قدره 1024 بايت، لذا لا تكشف أحجامها شيئًا يُذكر.",
              "تاريخ إغلاق النموذج وحد ردوده، وهما مقروءان لأن الحد الذي لا يستطيع الخادم قراءته حد لا يستطيع تطبيقه.",
              "ما إذا كان النموذج يقبل ردودًا، ومن يتعاون عليه وبأي دور.",
              "أسرار TOTP، التي يجب أن تكون مقروءة للتحقق من الرموز. وهذا عامل مصادقة لا محتوى نموذج.",
            ],
          },
        ],
      },
      {
        title: "ما لا يحمي منه هذا التصميم",
        blocks: [
          {
            kind: "text",
            text: "هذه حدود حقيقية لا أوجه إغفال. على كل من يعتمد على الضمان أعلاه أن يقرأها.",
          },
          {
            kind: "limits",
            items: [
              {
                title: "مشغّل يقدّم JavaScript معدَّلًا",
                body: "يحدث التشفير في شيفرة يسلّمها الخادم. والمشغّل الذي يغيّر تلك الشيفرة يستطيع سحب المفاتيح من الصفحة قبل أن يُشفَّر أي شيء. لا يعالج هذا أي تغيير في البروتوكول. إنه الحد الذي لا يُختزل للتشفير الطرفي المقدَّم عبر المتصفح، ولهذا الرخصة AGPL ولهذا بناء النسخة من المصدر مسار مدعوم: يمكنك تشغيل شيفرة قرأتها بدل ملف ثنائي سلّمه لك أحد.",
              },
              {
                title: "كلمة مرور ضعيفة، متى تسرّبت قاعدة البيانات",
                body: "يخزّن الخادم تجزئة لمُحقِّق مشتق هو نفسه من كلمة مرورك. ومن يحوز قاعدة البيانات يستطيع التخمين دون اتصال. تكلّف كل محاولة 256 ميبي بايت من الذاكرة وثلاث جولات من Argon2id، وهناك اختبار يثبّت هذه الأرقام كي لا يخفضها أي تحديث، لكن كلمات المرور القوية تبقى حاملة للثقل. يتطلب التسجيل اثني عشر حرفًا ولا يستطيع التحقق من أكثر من ذلك، لأن الخادم لا يتلقى كلمة المرور ليقيسها.",
              },
              {
                title: "فقدان كلمة مرورك ورمز استرداد خزنتك معًا",
                body: "لا توجد إعادة تعيين لكلمة المرور تسترد بياناتك، ولا مسؤول يستطيع المساعدة، ولا إيداع للمفاتيح. تصبح الخزنة غير قابلة للقراءة نهائيًا. ما دمت قادرًا على تسجيل الدخول يمكنك إصدار رمز استرداد جديد للخزنة من الإعدادات، فضياع الرمز وحده يمكن تجاوزه.",
              },
              {
                title: "التحقق من المحتوى",
                body: "لا يستطيع الخادم فحص ما لا يقرؤه. لا يوجد استنتاج لنوع MIME ولا فحص للأرقام السحرية ولا مسح للفيروسات على الملفات المرفوعة، لأن البايتات تصل مشفرة أصلًا. وتُفرض الحقول المطلوبة والأسئلة الشرطية في المتصفح فقط. تعامل مع أي مرفق تنزّله كما تتعامل مع أي ملف أرسله إليك غريب.",
              },
              {
                title: "إزالة متعاون ليست بأثر رجعي",
                body: "إزالة أحد أو إلغاء دعوة أو نقل الملكية توقف الوصول مستقبلًا عبر الواجهة البرمجية. ولا تستطيع محو المفاتيح أو النصوص المشفرة أو النصوص الصريحة التي نسخها بالفعل.",
              },
              {
                title: "رد واحد لكل شخص",
                body: "الإرسال مجهول الهوية بالتصميم، لذا فهذا مجاملة تُفرض في المتصفح لا غير. ولا يمكن فرضه دون جمع شيء يعرّف بالشخص.",
              },
            ],
          },
        ],
      },
      {
        title: "كيف تُعالَج المفاتيح",
        blocks: [
          {
            kind: "text",
            text: "يُولَّد مفتاح حساب عشوائي من 32 بايت في متصفحك ويقف بين كلمة مرورك وكل شيء آخر. تلفّه كل طريقة فتح على حدة، وهذه الكتل الملفوفة هي كل ما يخزنه الخادم: كلمة مرورك عبر Argon2id، ورمز استرداد خزنتك بالطريقة نفسها، ومفتاح المرور عبر مخرجات WebAuthn PRF.",
          },
          {
            kind: "text",
            text: "ويلفّ مفتاح الحساب هذا بدوره كل مفتاح نموذج ومفتاح المشاركة الخاص بالحساب. لا شيء تحته مرتبط بكلمة المرور، ولهذا يعيد استرداد الحساب اللفّ لا التشفير، ولهذا إضافة مفتاح مرور غلاف جديد لا ترحيل.",
          },
          {
            kind: "text",
            text: "تُختم الردود بالمفتاح العام للنموذج بخوارزمية X-Wing، وهي هجين من ML-KEM-768 وX25519، تحت ChaCha20-Poly1305. الهجين مقصود: كسر ML-KEM كسرًا كاملًا يترك الختم آمنًا تمامًا كما كان X25519 الذي حلّ محله. ومما يجدر معرفته قبل الاعتماد عليه أن مكتبة ما بعد الكم مثبّتة على إصدار محدد وأن القائمين عليها يذكرون أنها لم تُدقَّق باستقلال. وكل ما عدا ذلك libsodium.",
          },
        ],
      },
      {
        title: "الإبلاغ عن ثغرة",
        blocks: [
          {
            kind: "text",
            text: "أبلغ بسرية عبر الإشعارات الأمنية للمستودع بدل فتح مشكلة عامة، وأرفق تفاصيل تكفي لإعادة الإنتاج. وإذا رأيت أن بيانات مستخدمين معرضة للخطر على نسخة قيد التشغيل فاذكر ذلك في السطر الأول. أنت مرحّب بالاختبار على نسختك الخاصة. لا تختبر على نسخ لا تديرها.",
          },
          {
            kind: "text",
            text: "النص الكامل، بما فيه أعمار الجلسات وجدول حدود المعدل وحدود الرفع، يأتي مع الشيفرة المصدرية باسم SECURITY.md.",
          },
        ],
      },
    ],
  },
}
