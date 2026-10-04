import type { LocalizedDoc } from "./types"

/*
 * The privacy policy. Every factual claim has to stay true of the code: this
 * page is a promise made to a user about their own data, so a sentence that
 * outruns the code is a false statement. When a default, a retention period or
 * a stored field changes, both languages change with it.
 */
export const PRIVACY: LocalizedDoc = {
  en: {
    title: "Privacy",
    description:
      "What this instance stores, what it cannot read, and how to ask for your data.",
    updated: "18 September 2026",
    lead: "This instance is operated by {entity}. This page describes what it stores about you, what it is unable to read, and how to ask for something to be changed or removed.",
    intro: [
      "The short version: form titles, questions, answers and uploaded files are encrypted in your browser before they are sent. We hold ciphertext and no key that opens it. That is not a policy commitment that could be revised later, it is a property of how the software is built, and it means a database dump, a stolen backup, a compromised host or a legal demand made to us yields ciphertext.",
    ],
    sections: [
      {
        title: "What we hold about your account",
        blocks: [
          {
            kind: "list",
            items: [
              "Your email address. It identifies the account, receives the six-digit code that verifies it, and receives collaboration invitations and response notifications.",
              "Which language, English or Arabic, our emails to you are written in. It is a display preference, set from the language your browser was showing and changed when you pick another one, and it says nothing about your forms.",
              "A hash of a verifier derived from your password. Your password is not sent to the server and is not stored here in any form: the browser derives a key from it and sends a one-way verifier, which the server then hashes again with Argon2id.",
              "Wrapped copies of your account key, one for each way you unlock it. These are ciphertext that only your password, your vault recovery code or your passkey can open.",
              "If you enrol two-factor authentication, the TOTP secret, which has to be readable to check your codes, and hashes of your TOTP recovery codes. If you enrol a passkey, the credential it registered.",
              "Session records, which hold a hash of the session token rather than the token. Sessions expire after 30 days of not being used, and 90 days after they were created whatever happens.",
            ],
          },
        ],
      },
      {
        title: "What we hold about your forms",
        blocks: [
          {
            kind: "text",
            text: "Some metadata is unavoidable if the service is to work at all, and pretending otherwise would be dishonest.",
          },
          {
            kind: "list",
            items: [
              "Ciphertext for form titles, questions and responses, and the encrypted bytes of uploaded files. None of it can be read by this instance, its operator, its host or anyone served a copy of its database.",
              "The size of each uploaded file, because storage limits are counted against it. Ciphertext lengths for titles, questions and responses are padded, so those sizes say close to nothing about their contents.",
              "Timestamps, counts, and whether a form is accepting responses, along with its close date and response cap. A limit the server cannot read is a limit it cannot enforce.",
              "Who collaborates on which form and in what role, and the email address an invitation was sent to.",
            ],
          },
        ],
      },
      {
        title: "What we hold to run the service",
        blocks: [
          {
            kind: "list",
            items: [
              "IP addresses, used to count requests against rate limits. These counters are short-lived, they are not written to a request log for this purpose, and the login limiter counts against a hash of the address you typed rather than the address itself.",
              "Pending signups, held for 15 minutes so a verification code can be checked, and discarded whether or not it is used.",
              "If you subscribe to a paid plan, the customer and subscription identifiers issued by our payment processor, your plan, its status, and how many responses your account has received this month. Card details are handled by the payment processor and never reach this instance.",
            ],
          },
        ],
      },
      {
        title: "What we do not do",
        blocks: [
          {
            kind: "text",
            text: "There is no analytics, no advertising, no profiling and no third-party tracking on this site. We do not sell or share personal data. Fonts are served from this origin rather than a font network, so opening a form does not hand your address to anyone else, and the pages load no third-party scripts.",
          },
          {
            kind: "text",
            text: "Cookies here do two things: they sign you in (a session cookie, and a short-lived one that carries a collaboration invitation while you accept it), and, only if you choose a language, one remembers that choice. The language cookie is not set unless you choose, and it holds only the language. All of them are restricted to this site and none is used to follow you anywhere.",
          },
        ],
      },
      {
        title: "If you are answering someone's form",
        blocks: [
          {
            kind: "text",
            text: "You do not need an account and we do not ask who you are. Your answers are encrypted in your browser and sealed to the form, so only the people running that form can read them. We cannot read your answers, and we cannot find them for you: to us they are ciphertext with no name on it.",
          },
          {
            kind: "text",
            text: "That has a consequence worth stating plainly. The person who made the form decides what they collect and what they do with it, so a request to see, correct or delete your answers has to go to them rather than to us. We are not in a position to act on it, whatever we might wish.",
          },
          {
            kind: "text",
            text: "While you are part-way through a form, your answers are kept in your own browser so that closing the tab does not lose them. They stay on your device, are never sent to us in that form, are removed after 30 days, and the form gives you a control that removes them immediately. On a shared computer, use it.",
          },
        ],
      },
      {
        title: "Who else processes this data",
        blocks: [
          {
            kind: "text",
            text: "We use service providers to run the instance: a hosting provider for the servers, an object storage provider for encrypted file uploads, an email provider to deliver verification codes, invitations and notifications, and a payment processor for paid plans. They receive only what their job requires, and the encrypted material stays encrypted in their hands too.",
          },
          {
            kind: "text",
            text: "Notification emails carry a count and a link, never the title of a form or anything from a response, because those are encrypted and we could not put them in an email if we wanted to.",
          },
        ],
      },
      {
        title: "How long we keep it",
        blocks: [
          {
            kind: "text",
            text: "Your forms, responses and uploads stay until you delete them. You can delete a response or a whole form from the dashboard, and deleting a form deletes the responses and files attached to it.",
          },
          {
            kind: "text",
            text: "Encrypted database backups are kept for a short period so the service can be restored after a failure, and a deletion works through to those backups as they age out. Rate-limit counters and pending signups are transient and measured in minutes to hours. Sessions expire as described above.",
          },
          {
            kind: "text",
            text: "To close your account, write to us at {email}. There is no self-service button for this yet, so it is a request we carry out by hand rather than one you can complete on your own, and we say so rather than implying otherwise. Deleting an account deletes the encrypted material only that account holds.",
          },
        ],
      },
      {
        title: "Your rights",
        blocks: [
          {
            kind: "text",
            text: "You can ask for a copy of what we hold about you, ask us to correct it, ask us to delete it, or object to how we use it. Write to {email} and we will answer within one month.",
          },
          {
            kind: "text",
            text: "Two honest limits apply. Anything encrypted can be exported by you from inside the app, where the keys are, and the export you make there is more useful than anything we could assemble, since ours would be ciphertext. And we cannot correct or delete something we cannot identify: answers submitted to a form someone else runs are theirs to act on.",
          },
          {
            kind: "text",
            text: "If you think we have handled your data badly, please tell us first, and know that you can also complain to the data protection authority where you live.",
          },
        ],
      },
      {
        title: "Changes and contact",
        blocks: [
          {
            kind: "text",
            text: "If this policy changes in a way that matters, the date at the top changes with it and we will say so to account holders before it takes effect. Questions, requests and complaints go to {email}.",
          },
        ],
      },
    ],
  },
  ar: {
    title: "الخصوصية",
    description:
      "ما تخزنه هذه النسخة، وما لا تستطيع قراءته، وكيف تطلب بياناتك.",
    updated: "18 سبتمبر 2026",
    lead: "تشغّل هذه النسخةَ {entity}. تصف هذه الصفحة ما تخزنه عنك، وما لا تستطيع قراءته، وكيف تطلب تعديل شيء أو إزالته. هذه الصفحة ترجمة للنص الإنجليزي، وعند أي اختلاف بين النصين يُعتمد النص الإنجليزي.",
    intro: [
      "باختصار: عناوين النماذج وأسئلتها وإجاباتها والملفات المرفوعة تُشفَّر في متصفحك قبل إرسالها. نحتفظ بنص مشفر ولا نملك أي مفتاح يفتحه. وهذا ليس التزامًا في سياسة يمكن مراجعته لاحقًا، بل خاصية في طريقة بناء البرنامج، ويعني أن نسخة من قاعدة البيانات أو نسخة احتياطية مسروقة أو خادمًا مخترقًا أو طلبًا قانونيًا موجّهًا إلينا لا يُنتج إلا نصًا مشفرًا.",
    ],
    sections: [
      {
        title: "ما نحتفظ به عن حسابك",
        blocks: [
          {
            kind: "list",
            items: [
              "بريدك الإلكتروني. يعرّف الحساب، ويستقبل الرمز المكوّن من ست خانات الذي يتحقق منه، ويستقبل دعوات التعاون وإشعارات الردود.",
              "اللغة، الإنجليزية أو العربية، التي تُكتب بها رسائلنا إليك. هي تفضيل للعرض، تُضبط من اللغة التي كان متصفحك يعرضها وتتغير عندما تختار لغة أخرى، ولا تقول شيئًا عن نماذجك.",
              "تجزئة لمُحقِّق مشتق من كلمة مرورك. لا تُرسل كلمة المرور إلى الخادم ولا تُخزَّن هنا بأي صورة: يشتق المتصفح منها مفتاحًا ويرسل مُحقِّقًا أحادي الاتجاه، ثم يجزّئه الخادم مرة أخرى بخوارزمية Argon2id.",
              "نسخًا ملفوفة من مفتاح حسابك، واحدة لكل طريقة تفتح بها حسابك. هذه نصوص مشفرة لا يفتحها إلا كلمة مرورك أو رمز استرداد خزنتك أو مفتاح المرور الخاص بك.",
              "إذا فعّلت المصادقة الثنائية: سر TOTP الذي يجب أن يكون مقروءًا للتحقق من رموزك، وتجزئات رموز استرداد TOTP. وإذا سجّلت مفتاح مرور: بيانات الاعتماد التي سجّلها.",
              "سجلات الجلسات، وتحتوي تجزئة لرمز الجلسة لا الرمز نفسه. تنتهي الجلسات بعد 30 يومًا من عدم الاستخدام، وبعد 90 يومًا من إنشائها مهما حدث.",
            ],
          },
        ],
      },
      {
        title: "ما نحتفظ به عن نماذجك",
        blocks: [
          {
            kind: "text",
            text: "بعض البيانات الوصفية لا مفر منها كي تعمل الخدمة أصلًا، والتظاهر بغير ذلك غير صادق.",
          },
          {
            kind: "list",
            items: [
              "نصوصًا مشفرة لعناوين النماذج وأسئلتها وردودها، والبايتات المشفرة للملفات المرفوعة. لا تستطيع هذه النسخة ولا مشغّلها ولا مضيفها ولا أي شخص حصل على نسخة من قاعدة بياناتها قراءة شيء منها.",
              "حجم كل ملف مرفوع، لأن حدود التخزين تُحتسب عليه. أما أطوال النصوص المشفرة لعناوين النماذج والأسئلة والردود فتُحشى، لذا لا تكاد تدل أحجامها على شيء من محتواها.",
              "الطوابع الزمنية والأعداد، وما إذا كان النموذج يقبل ردودًا، مع تاريخ إغلاقه وحد ردوده. الحد الذي لا يستطيع الخادم قراءته حد لا يستطيع تطبيقه.",
              "من يتعاون على أي نموذج وبأي دور، وعنوان البريد الذي أُرسلت إليه الدعوة.",
            ],
          },
        ],
      },
      {
        title: "ما نحتفظ به لتشغيل الخدمة",
        blocks: [
          {
            kind: "list",
            items: [
              "عناوين IP، وتُستخدم لعدّ الطلبات مقابل حدود المعدل. هذه العدادات قصيرة العمر، ولا تُكتب في سجل طلبات لهذا الغرض، ويعدّ محدّد تسجيل الدخول مقابل تجزئة للعنوان الذي كتبته لا العنوان نفسه.",
              "عمليات التسجيل المعلّقة، وتُحفظ 15 دقيقة كي يمكن التحقق من رمز التأكيد، وتُتلف سواء استُخدمت أم لا.",
              "إذا اشتركت في خطة مدفوعة: معرّفات العميل والاشتراك الصادرة عن معالج الدفع لدينا، وخطتك وحالتها، وعدد الردود التي استلمها حسابك هذا الشهر. يتولى معالج الدفع تفاصيل البطاقة ولا تصل إلى هذه النسخة أبدًا.",
            ],
          },
        ],
      },
      {
        title: "ما لا نفعله",
        blocks: [
          {
            kind: "text",
            text: "لا توجد في هذا الموقع تحليلات ولا إعلانات ولا بناء ملفات تعريفية ولا تتبع من أطراف ثالثة. لا نبيع البيانات الشخصية ولا نشاركها. تُقدَّم الخطوط من هذا النطاق لا من شبكة خطوط، فلا يؤدي فتح نموذج إلى تسليم عنوانك لأحد، ولا تحمّل الصفحات أي نصوص برمجية من أطراف ثالثة.",
          },
          {
            kind: "text",
            text: "تؤدي ملفات تعريف الارتباط هنا أمرين: تُبقيك مسجلًا للدخول (ملف للجلسة، وآخر قصير العمر يحمل دعوة التعاون أثناء قبولك لها)، وإن اخترت لغة فقط، ملف يتذكر اختيارك. لا يُضبط ملف اللغة ما لم تختر، ولا يحمل إلا اللغة. كلها مقصورة على هذا الموقع، ولا يُستخدم أي منها لتتبعك في أي مكان.",
          },
        ],
      },
      {
        title: "إذا كنت تجيب عن نموذج شخص آخر",
        blocks: [
          {
            kind: "text",
            text: "لا تحتاج إلى حساب ولا نسألك من تكون. تُشفَّر إجاباتك في متصفحك وتُختم للنموذج، فلا يقرؤها إلا من يديرون ذلك النموذج. لا نستطيع قراءة إجاباتك ولا العثور عليها لك: هي بالنسبة إلينا نص مشفر بلا اسم عليه.",
          },
          {
            kind: "text",
            text: "ولهذا نتيجة تستحق أن تُذكر بوضوح. من أنشأ النموذج هو من يقرر ما يجمعه وما يفعله به، لذا فإن طلب الاطلاع على إجاباتك أو تصحيحها أو حذفها يجب أن يُوجَّه إليه لا إلينا. لسنا في موضع يسمح لنا بالتصرف بشأنه، مهما تمنّينا.",
          },
          {
            kind: "text",
            text: "وأنت في منتصف نموذج، تُحفظ إجاباتك في متصفحك كي لا يضيع شيء منها بإغلاق التبويب. تبقى على جهازك، ولا تُرسل إلينا بهذه الصورة أبدًا، وتُزال بعد 30 يومًا، ويمنحك النموذج أداة تزيلها فورًا. على جهاز مشترك، استخدمها.",
          },
        ],
      },
      {
        title: "من يعالج هذه البيانات أيضًا",
        blocks: [
          {
            kind: "text",
            text: "نستعين بمزوّدي خدمات لتشغيل النسخة: مزوّد استضافة للخوادم، ومزوّد تخزين كائنات للملفات المشفرة المرفوعة، ومزوّد بريد لتسليم رموز التحقق والدعوات والإشعارات، ومعالج دفع للخطط المدفوعة. لا يتلقون إلا ما تتطلبه مهمتهم، وتبقى المواد المشفرة مشفرة في أيديهم أيضًا.",
          },
          {
            kind: "text",
            text: "تحمل رسائل الإشعارات عددًا ورابطًا، ولا تحمل أبدًا عنوان نموذج ولا شيئًا من رد، لأن هذه مشفرة ولا نستطيع وضعها في رسالة ولو أردنا.",
          },
        ],
      },
      {
        title: "كم نحتفظ بها",
        blocks: [
          {
            kind: "text",
            text: "تبقى نماذجك وردودك وملفاتك المرفوعة حتى تحذفها. يمكنك حذف رد أو نموذج كامل من لوحة النماذج، ويؤدي حذف نموذج إلى حذف الردود والملفات المرتبطة به.",
          },
          {
            kind: "text",
            text: "تُحفظ النسخ الاحتياطية المشفرة لقاعدة البيانات مدة قصيرة كي يمكن استعادة الخدمة بعد عطل، ويمتد الحذف إلى تلك النسخ مع انقضاء مدتها. أما عدادات حدود المعدل وعمليات التسجيل المعلّقة فمؤقتة وتُقاس بالدقائق إلى الساعات. وتنتهي الجلسات كما هو موضح أعلاه.",
          },
          {
            kind: "text",
            text: "لإغلاق حسابك، راسلنا على {email}. لا يوجد زر ذاتي الخدمة لهذا بعد، فهو طلب ننفذه يدويًا لا طلب تُكمله بنفسك، ونقول ذلك صراحة بدل أن نوحي بغيره. يؤدي حذف الحساب إلى حذف المواد المشفرة التي يحتفظ بها ذلك الحساب وحده.",
          },
        ],
      },
      {
        title: "حقوقك",
        blocks: [
          {
            kind: "text",
            text: "يمكنك أن تطلب نسخة مما نحتفظ به عنك، أو أن نصحّحه، أو أن نحذفه، أو أن تعترض على طريقة استخدامنا له. راسل {email} وسنرد في غضون شهر واحد.",
          },
          {
            kind: "text",
            text: "ينطبق حدّان صريحان. كل ما هو مشفر يمكنك تصديره بنفسك من داخل التطبيق حيث المفاتيح، والتصدير الذي تجريه هناك أنفع من أي شيء نستطيع تجميعه، لأن ما عندنا نص مشفر. ولا نستطيع تصحيح أو حذف ما لا نستطيع تحديده: الإجابات المرسلة إلى نموذج يديره شخص آخر أمرها إليه.",
          },
          {
            kind: "text",
            text: "إذا رأيت أننا أسأنا التعامل مع بياناتك، فأخبرنا أولًا، واعلم أن بإمكانك أيضًا تقديم شكوى إلى سلطة حماية البيانات في بلد إقامتك.",
          },
        ],
      },
      {
        title: "التغييرات والتواصل",
        blocks: [
          {
            kind: "text",
            text: "إذا تغيرت هذه السياسة تغيّرًا يهم، يتغير التاريخ في أعلاها وسنخبر أصحاب الحسابات قبل سريانه. توجَّه الأسئلة والطلبات والشكاوى إلى {email}.",
          },
        ],
      },
    ],
  },
}
