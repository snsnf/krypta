import type { LocalizedDoc } from "./types"

/*
 * The terms of service. The limits, the billing behaviour and the recovery
 * warning are descriptions of what the software actually does and change when
 * it does, in both languages. No governing law appears: a jurisdiction clause
 * is one an operator writes with advice, not one a template guesses at.
 */
export const TERMS: LocalizedDoc = {
  en: {
    title: "Terms",
    description:
      "The terms you agree to when you use this instance, including what happens to your data and what we cannot do for you.",
    updated: "18 September 2026",
    lead: "These terms are between you and {entity}, who operates this instance. By creating an account or using the service you agree to them. If you do not, please do not use the service.",
    intro: [],
    sections: [
      {
        title: "Your account",
        blocks: [
          {
            kind: "text",
            text: "You are responsible for what happens under your account and for keeping your password, your vault recovery code and your devices to yourself. You must be old enough to enter a contract where you live, and the details you give us must be accurate enough that we can reach you.",
          },
          {
            kind: "text",
            text: "**We cannot recover your data if you lose both your password and your vault recovery code.** This is not a support policy we could make an exception to. Your data is encrypted with keys derived from those secrets and we hold neither. There is no reset that recovers content, no administrator with a way in, and no copy of your key held anywhere for a rainy day. While you can still sign in you can generate a fresh vault recovery code from settings, so losing the code alone is survivable. Losing both is not. The [security page](/security) explains why.",
          },
        ],
      },
      {
        title: "Your content is yours",
        blocks: [
          {
            kind: "text",
            text: "Your forms, your responses and your files remain yours. We claim no licence over them beyond storing and transmitting the encrypted material so the service works, which is all we are technically able to do with it.",
          },
          {
            kind: "text",
            text: "Because you decide what your forms collect, you are responsible for collecting it lawfully: for telling respondents what you are gathering and why, for having a basis to gather it, and for answering respondents who ask you about their own answers. We cannot answer for you, since we cannot read what you collected.",
          },
        ],
      },
      {
        title: "What you must not use it for",
        blocks: [
          {
            kind: "list",
            items: [
              "Collecting credentials, payment details or other secrets under a false identity. A form that impersonates a bank, an employer or a public body is phishing, and encryption makes it more convincing rather than more acceptable.",
              "Distributing malware, including as an attachment to a form you control.",
              "Collecting data you have no lawful basis to collect, or using a form to harass, defraud or endanger anyone.",
              "Attacking the service: probing for vulnerabilities on this instance rather than your own, defeating rate limits, or attempting to reach other accounts. Security research is welcome against an instance you run yourself.",
              "Reselling access in a way designed to work around account limits.",
            ],
          },
          {
            kind: "text",
            text: "How this is enforced is worth being straight about. We cannot read form content, so we do not monitor it and we could not pre-screen it if we wanted to. We act on reports, and the only tools we have are blunt ones at the level of an account or a form. Encryption is there to protect people from us and from whoever takes our database, not to shelter abuse from consequences.",
          },
        ],
      },
      {
        title: "Plans, payment and limits",
        blocks: [
          {
            kind: "text",
            text: "There is a free plan and a paid plan. The price, the billing period and what each plan includes are shown at checkout, and the paid plan renews automatically until you cancel. You can cancel at any time from the billing portal, and access continues to the end of the period you have paid for. Payments are handled by our payment processor; we never receive your card details.",
          },
          {
            kind: "text",
            text: "Plans carry limits on open forms, stored files and responses per month. Reaching a limit stops the account adding more: creating or reopening a form is refused, and a form may stop accepting responses. It never deletes anything.",
          },
          {
            kind: "text",
            text: "That last point holds when a subscription ends too, whether you cancel or a payment fails. Nothing you have stored is deleted on downgrade. Choosing what to remove would mean ranking your titles, responses and filenames by importance, and all of it is ciphertext to us. An account past its limits stops being able to add; it never stops being able to read what it already has.",
          },
          {
            kind: "text",
            text: "If we change prices, we will tell account holders before the change applies to them.",
          },
        ],
      },
      {
        title: "Availability",
        blocks: [
          {
            kind: "text",
            text: "We work to keep the service up and to keep your encrypted data safe, including backups held off the server. We do not promise an uptime figure, and we will take the service down for maintenance when it needs it. Keep your own copies of anything you cannot afford to lose: responses export as CSV from the dashboard.",
          },
        ],
      },
      {
        title: "Suspending or closing an account",
        blocks: [
          {
            kind: "text",
            text: "You can stop using the service at any time and ask us to close your account by writing to {email}. We may suspend or close an account that breaks these terms, that is being used to harm someone, or where we are legally required to. Except where the circumstances make it impossible or unlawful, we will tell you why and give you a chance to export your data first.",
          },
        ],
      },
      {
        title: "The software and the service",
        blocks: [
          {
            kind: "text",
            text: "The software is open source under the AGPL, and you are free to read it, change it and run your own instance under that licence. These terms cover the hosted service we operate, not the software licence, and nothing here takes away a right the licence gives you.",
          },
        ],
      },
      {
        title: "Liability",
        blocks: [
          {
            kind: "text",
            text: "The service is provided as it is. To the extent the law allows, we exclude implied warranties and are not liable for indirect or consequential loss, for lost profits, or for data you can no longer decrypt because the secrets that open it were lost. Where we are liable, our liability is limited to what you paid us in the twelve months before the claim.",
          },
          {
            kind: "text",
            text: "Nothing here limits liability that cannot be limited by law, including for death or personal injury caused by negligence, or for fraud. If you are a consumer, your statutory rights are unaffected.",
          },
        ],
      },
      {
        title: "Changes",
        blocks: [
          {
            kind: "text",
            text: "We may update these terms. If a change matters to you, the date at the top changes and we will tell account holders before it takes effect. Continuing to use the service after that means you accept the new terms.",
          },
        ],
      },
      {
        title: "Contact",
        blocks: [
          {
            kind: "text",
            text: "Write to {email}. The [privacy policy](/privacy) covers what we store and how to ask for it.",
          },
        ],
      },
    ],
  },
  ar: {
    title: "الشروط",
    description:
      "الشروط التي توافق عليها عند استخدام هذه النسخة، بما فيها ما يحدث لبياناتك وما لا نستطيع فعله لأجلك.",
    updated: "18 سبتمبر 2026",
    lead: "هذه الشروط بينك وبين {entity} التي تشغّل هذه النسخة. بإنشاء حساب أو استخدام الخدمة فإنك توافق عليها. وإن لم توافق فلا تستخدم الخدمة. هذه الصفحة ترجمة للنص الإنجليزي، وعند أي اختلاف بين النصين يُعتمد النص الإنجليزي.",
    intro: [],
    sections: [
      {
        title: "حسابك",
        blocks: [
          {
            kind: "text",
            text: "أنت مسؤول عما يحدث في حسابك وعن إبقاء كلمة مرورك ورمز استرداد خزنتك وأجهزتك لنفسك. ويجب أن تكون في سن تسمح لك بإبرام عقد في بلد إقامتك، وأن تكون البيانات التي تقدمها لنا دقيقة بما يكفي لنتمكن من الوصول إليك.",
          },
          {
            kind: "text",
            text: "**لا نستطيع استرداد بياناتك إذا فقدت كلمة مرورك ورمز استرداد خزنتك معًا.** هذه ليست سياسة دعم يمكننا أن نستثني منها. بياناتك مشفرة بمفاتيح مشتقة من هذين السرّين ولا نملك أيًّا منهما. لا توجد إعادة تعيين تسترد المحتوى، ولا مسؤول لديه طريق إلى الداخل، ولا نسخة من مفتاحك محفوظة في أي مكان ليوم الشدة. ما دمت قادرًا على تسجيل الدخول يمكنك إنشاء رمز استرداد جديد للخزنة من الإعدادات، فضياع الرمز وحده يمكن تجاوزه. أما ضياعهما معًا فلا. توضح [صفحة الأمان](/security) السبب.",
          },
        ],
      },
      {
        title: "محتواك ملكك",
        blocks: [
          {
            kind: "text",
            text: "تبقى نماذجك وردودك وملفاتك ملكك. لا ندّعي أي ترخيص عليها يتجاوز تخزين المواد المشفرة ونقلها كي تعمل الخدمة، وهو كل ما نستطيع فعله بها تقنيًا.",
          },
          {
            kind: "text",
            text: "ولأنك من يقرر ما تجمعه نماذجك، فأنت مسؤول عن جمعه بصورة مشروعة: عن إخبار المجيبين بما تجمعه ولماذا، وعن وجود أساس لجمعه، وعن الرد على المجيبين الذين يسألونك عن إجاباتهم. لا نستطيع الرد عنك، لأننا لا نستطيع قراءة ما جمعته.",
          },
        ],
      },
      {
        title: "ما يُحظر استخدامها فيه",
        blocks: [
          {
            kind: "list",
            items: [
              "جمع بيانات اعتماد أو تفاصيل دفع أو أسرار أخرى بهوية كاذبة. النموذج الذي ينتحل صفة مصرف أو جهة عمل أو جهة عامة هو تصيّد، والتشفير يجعله أكثر إقناعًا لا أكثر قبولًا.",
              "نشر برمجيات خبيثة، بما في ذلك كمرفق في نموذج تتحكم فيه.",
              "جمع بيانات لا أساس مشروع لديك لجمعها، أو استخدام نموذج لمضايقة أحد أو الاحتيال عليه أو تعريضه للخطر.",
              "مهاجمة الخدمة: البحث عن ثغرات في هذه النسخة بدل نسختك أنت، أو تجاوز حدود المعدل، أو محاولة الوصول إلى حسابات أخرى. البحث الأمني مرحَّب به على نسخة تديرها بنفسك.",
              "إعادة بيع الوصول بطريقة مصممة للالتفاف على حدود الحساب.",
            ],
          },
          {
            kind: "text",
            text: "يستحق تطبيق هذا أن نكون صريحين بشأنه. لا نستطيع قراءة محتوى النماذج، فلا نراقبه ولا نستطيع فحصه مسبقًا ولو أردنا. نتصرف بناءً على البلاغات، وأدواتنا الوحيدة فظة وعلى مستوى الحساب أو النموذج. التشفير موجود لحماية الناس منا ومن كل من يأخذ قاعدة بياناتنا، لا لإيواء الإساءة بعيدًا عن عواقبها.",
          },
        ],
      },
      {
        title: "الخطط والدفع والحدود",
        blocks: [
          {
            kind: "text",
            text: "توجد خطة مجانية وخطة مدفوعة. يظهر السعر وفترة الفوترة وما تتضمنه كل خطة عند الدفع، وتتجدد الخطة المدفوعة تلقائيًا حتى تلغيها. يمكنك الإلغاء في أي وقت من بوابة الفوترة، ويستمر الوصول حتى نهاية الفترة التي دفعت عنها. يتولى معالج الدفع لدينا المدفوعات؛ ولا نتلقى تفاصيل بطاقتك أبدًا.",
          },
          {
            kind: "text",
            text: "تحمل الخطط حدودًا للنماذج المفتوحة والملفات المخزنة والردود في الشهر. بلوغ الحد يمنع الحساب من إضافة المزيد: يُرفض إنشاء نموذج أو إعادة فتحه، وقد يتوقف نموذج عن قبول الردود. ولا يحذف ذلك أي شيء أبدًا.",
          },
          {
            kind: "text",
            text: "وهذه النقطة الأخيرة تصدق أيضًا عند انتهاء الاشتراك، سواء ألغيته أو فشلت دفعة. لا يُحذف شيء مما خزنته عند خفض الخطة. فاختيار ما يُزال يعني ترتيب عناوينك وردودك وأسماء ملفاتك حسب الأهمية، وكلها نص مشفر بالنسبة إلينا. الحساب الذي تجاوز حدوده يفقد القدرة على الإضافة؛ ولا يفقد أبدًا القدرة على قراءة ما لديه.",
          },
          {
            kind: "text",
            text: "إذا غيّرنا الأسعار فسنخبر أصحاب الحسابات قبل سريان التغيير عليهم.",
          },
        ],
      },
      {
        title: "التوفر",
        blocks: [
          {
            kind: "text",
            text: "نعمل على إبقاء الخدمة قائمة وبياناتك المشفرة آمنة، بما فيها النسخ الاحتياطية المحفوظة خارج الخادم. لا نعد بنسبة تشغيل محددة، وسنوقف الخدمة للصيانة عند الحاجة. احتفظ بنسخك الخاصة من كل ما لا تحتمل خسارته: تُصدَّر الردود بصيغة CSV من لوحة النماذج.",
          },
        ],
      },
      {
        title: "تعليق الحساب أو إغلاقه",
        blocks: [
          {
            kind: "text",
            text: "يمكنك التوقف عن استخدام الخدمة في أي وقت وطلب إغلاق حسابك بمراسلة {email}. قد نعلّق أو نغلق حسابًا يخالف هذه الشروط أو يُستخدم لإيذاء أحد أو حين يُلزمنا القانون بذلك. وما لم تجعل الظروف ذلك مستحيلًا أو غير قانوني، سنخبرك بالسبب ونمنحك فرصة لتصدير بياناتك أولًا.",
          },
        ],
      },
      {
        title: "البرنامج والخدمة",
        blocks: [
          {
            kind: "text",
            text: "البرنامج مفتوح المصدر بموجب رخصة AGPL، ولك أن تقرأه وتغيّره وتشغّل نسختك الخاصة بموجب تلك الرخصة. تغطي هذه الشروط الخدمة المستضافة التي نشغّلها لا رخصة البرنامج، ولا ينتزع شيء هنا حقًا تمنحك إياه الرخصة.",
          },
        ],
      },
      {
        title: "المسؤولية",
        blocks: [
          {
            kind: "text",
            text: "تُقدَّم الخدمة كما هي. بالقدر الذي يسمح به القانون، نستبعد الضمانات الضمنية ولا نتحمل المسؤولية عن الخسارة غير المباشرة أو التبعية ولا عن الأرباح الفائتة ولا عن بيانات لم تعد قادرًا على فك تشفيرها لأن الأسرار التي تفتحها ضاعت. وحيث نكون مسؤولين، تقتصر مسؤوليتنا على ما دفعته لنا في الاثني عشر شهرًا السابقة للمطالبة.",
          },
          {
            kind: "text",
            text: "لا يحد شيء هنا من مسؤولية لا يجوز تحديدها قانونًا، بما فيها الوفاة أو الإصابة الشخصية الناتجة عن الإهمال أو الاحتيال. وإن كنت مستهلكًا فلا تتأثر حقوقك النظامية.",
          },
        ],
      },
      {
        title: "التغييرات",
        blocks: [
          {
            kind: "text",
            text: "قد نحدّث هذه الشروط. إذا كان التغيير يهمك يتغير التاريخ في الأعلى وسنخبر أصحاب الحسابات قبل سريانه. ومواصلة استخدام الخدمة بعد ذلك تعني قبولك الشروط الجديدة.",
          },
        ],
      },
      {
        title: "التواصل",
        blocks: [
          {
            kind: "text",
            text: "راسل {email}. وتغطي [سياسة الخصوصية](/privacy) ما نخزنه وكيف تطلبه.",
          },
        ],
      },
    ],
  },
}
