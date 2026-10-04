#[cfg(test)]
use std::sync::{Arc, Mutex};

use lettre::message::MultiPart;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use uuid::Uuid;

use crate::config::Config;

#[derive(Clone, Debug, PartialEq)]
pub struct Mail {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// The language a mail is written in. The same two the web app speaks; anything
/// else a client sends is English.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Language {
    #[default]
    En,
    Ar,
}

impl Language {
    /// Total on purpose: an unknown or missing code is English, never an error.
    pub fn from_code(code: Option<&str>) -> Self {
        match code {
            Some("ar") => Language::Ar,
            _ => Language::En,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Language::En => "en",
            Language::Ar => "ar",
        }
    }

    fn dir(self) -> &'static str {
        match self {
            Language::En => "ltr",
            Language::Ar => "rtl",
        }
    }

    fn align(self) -> &'static str {
        match self {
            Language::En => "left",
            Language::Ar => "right",
        }
    }

    /// Picks the text for this language.
    fn pick<'a>(self, en: &'a str, ar: &'a str) -> &'a str {
        match self {
            Language::En => en,
            Language::Ar => ar,
        }
    }
}

/// The language an address's mail is written in: the account's own, or English
/// when there is no account (or the lookup fails, which must never stop a mail).
pub async fn language_for_email(db: &sqlx::PgPool, email: &str) -> Language {
    let code = sqlx::query_scalar!("SELECT language FROM users WHERE email = $1", email)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    Language::from_code(code.as_deref())
}

#[cfg(test)]
#[derive(Clone)]
pub struct BlockingDelivery {
    send_started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[cfg(test)]
impl BlockingDelivery {
    pub async fn wait_until_send_started(&self) {
        self.send_started.notified().await;
    }

    pub fn release(&self) {
        self.release.notify_one();
    }
}

/// The transport, chosen at startup.
///
/// An enum rather than a trait object: `async fn` in a trait is not
/// `dyn`-safe, and `AppState` has to stay `Clone`.
#[derive(Clone)]
pub enum Mailer {
    Smtp {
        transport: AsyncSmtpTransport<Tokio1Executor>,
        from: String,
    },
    /// Records instead of sending, so handler tests need no SMTP server.
    ///
    /// Unit tests use this to avoid external SMTP delivery.
    #[cfg(test)]
    Capture(Arc<Mutex<Vec<Mail>>>),
    #[cfg(test)]
    Failing,
    #[cfg(test)]
    Blocking {
        send_started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
}

/// The one form of an email address this service keys, stores and mails.
///
/// `send` parses its recipient with lettre, which accepts a display name,
/// surrounding whitespace and other decorations and delivers every one of them
/// to the same inbox. The per-address rate limits used to hash whatever string
/// arrived, so each spelling of one inbox got a fresh counter, and the limit
/// that exists to stop one inbox being mail-bombed stopped nothing.
///
/// Only a bare address that lettre would print back unchanged is accepted,
/// lowercased to match the CITEXT column. A decorated one is refused rather
/// than stripped: the browser derives the account's salts from the address it
/// holds, so quietly turning `" a@b.c"` into `"a@b.c"` here would give the
/// account a stored address its own salts were not derived from.
pub fn canonical_address(raw: &str) -> Option<String> {
    if raw.len() > 320 {
        return None;
    }
    let address: lettre::Address = raw.parse().ok()?;
    if AsRef::<str>::as_ref(&address) != raw {
        return None;
    }
    Some(raw.to_lowercase())
}

impl Mailer {
    pub fn from_config(config: &Config) -> anyhow::Result<Self> {
        let builder = match config.smtp_tls.as_str() {
            "implicit" => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.smtp_host)?,
            "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_host)?,
            // Plaintext SMTP. Only mailpit on localhost should ever use this.
            "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.smtp_host),
            other => anyhow::bail!("SMTP_TLS must be starttls, implicit or none, got {other}"),
        }
        .port(config.smtp_port);

        let builder = if config.smtp_user.is_empty() {
            builder
        } else {
            builder.credentials(Credentials::new(
                config.smtp_user.clone(),
                config.smtp_password.clone(),
            ))
        };

        Ok(Mailer::Smtp {
            transport: builder.build(),
            from: config.mail_from.clone(),
        })
    }

    /// A mailer that records instead of sending.
    #[cfg(test)]
    pub fn capture() -> Self {
        Mailer::Capture(Arc::new(Mutex::new(Vec::new())))
    }

    #[cfg(test)]
    pub fn failing() -> Self {
        Mailer::Failing
    }

    #[cfg(test)]
    pub fn blocking() -> (Self, BlockingDelivery) {
        let send_started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        (
            Mailer::Blocking {
                send_started: send_started.clone(),
                release: release.clone(),
            },
            BlockingDelivery {
                send_started,
                release,
            },
        )
    }

    pub async fn send(&self, mail: Mail) -> anyhow::Result<()> {
        match self {
            Mailer::Smtp { transport, from } => {
                let message = Message::builder()
                    .from(from.parse()?)
                    .to(mail.to.parse()?)
                    .subject(mail.subject.clone())
                    .multipart(MultiPart::alternative_plain_html(
                        mail.text.clone(),
                        mail.html.clone(),
                    ))?;
                transport.send(message).await?;
                Ok(())
            }
            #[cfg(test)]
            Mailer::Capture(sent) => {
                sent.lock()
                    .map_err(|_| anyhow::anyhow!("capture mailer poisoned"))?
                    .push(mail);
                Ok(())
            }
            #[cfg(test)]
            Mailer::Failing => Err(anyhow::anyhow!("test mail delivery failed")),
            #[cfg(test)]
            Mailer::Blocking {
                send_started,
                release,
            } => {
                send_started.notify_one();
                release.notified().await;
                Ok(())
            }
        }
    }

    /// Everything the capture mailer has been handed. Panics on the SMTP
    /// variant, which is only reachable from a test that built the wrong one.
    #[cfg(test)]
    pub fn captured(&self) -> Vec<Mail> {
        match self {
            Mailer::Capture(sent) => sent.lock().expect("capture mailer poisoned").clone(),
            Mailer::Smtp { .. } => panic!("captured() called on the SMTP mailer"),
            #[cfg(test)]
            Mailer::Failing => panic!("captured() called on the failing mailer"),
            #[cfg(test)]
            Mailer::Blocking { .. } => panic!("captured() called on the blocking mailer"),
        }
    }
}

/*
 * The shell every krypta mail is built in.
 *
 * Three constraints shape it, and only the first is about looks.
 *
 * **It fetches nothing.** No image, no web font, no tracking pixel, no
 * remote stylesheet. A product that removed Google Fonts because they handed
 * a third party every respondent's IP address cannot ship a mail that pings
 * its own server the moment it is opened. That is also why the mark at the
 * top is set in type rather than being an `<img>`: a hosted logo is a read
 * receipt with a picture attached, and most clients block it anyway.
 *
 * **It says only what the server could know.** No titles, no answers, no
 * counts of anything encrypted. The unit tests below and in each constructor
 * enforce that vocabulary.
 *
 * **It is built like mail, not like a page.** Tables for structure, inline
 * styles for everything a client might strip, classes only for the
 * dark-scheme overrides that clients honouring `prefers-color-scheme` will
 * apply. Anything that degrades (the radius under Outlook's Word engine, the
 * letter-spacing on the code) degrades to plain and legible.
 */

/// Brand green, the one colour taken straight from the logo mark. Every
/// other value in the palette is a tint or shade in the same family, so the
/// mail reads as krypta without carrying a picture of the logo.
const INK: &str = "#101A14";
const BODY: &str = "#3C4B41";
const META: &str = "#5C6B60";
const GROUND: &str = "#EEF1EC";
const PLATE: &str = "#FFFFFF";
const RULE: &str = "#DDE4DE";
const BRAND: &str = "#356343";

/// The product's own faces first, then the system stack. Neither Geist nor
/// Schibsted Grotesk will load in a mail client, and that is fine: naming
/// them costs nothing and the fallbacks carry the same proportions.
const SANS: &str = "'Schibsted Grotesk','Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO: &str = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/// Dark-scheme overrides for the clients that honour them. The brand green is
/// too dark to read on a dark ground, so the mark lifts to a mint of the same
/// hue; the button keeps the green, which still carries white text.
const DARK_SCHEME: &str = "@media (prefers-color-scheme: dark) {\
 .ground { background-color: #0E1511 !important; }\
 .ink { color: #EAF0EB !important; }\
 .body { color: #C3D0C7 !important; }\
 .meta { color: #9DAFA2 !important; }\
 .mark { color: #8FC2A0 !important; }\
 .plate { background-color: #16201A !important; border-color: #2C3B32 !important; }\
 .rule { border-color: #2C3B32 !important; }\
 }";

/// What a mail asks the reader to do. Exactly one per mail, or none: a code
/// and a button in the same message would be two calls to action competing,
/// and every krypta mail has only one thing to say.
enum Payload<'a> {
    None,
    Code(&'a str),
    Action { label: &'a str, url: &'a str },
}

/// Minimal escaping for the values that reach the markup: a role from the
/// database, a code, a URL built from configuration. None of them can carry
/// markup today, which is exactly why this is cheap insurance rather than a
/// dependency.
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn hairline() -> String {
    format!(
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">\
         <tr><td class=\"rule\" height=\"1\" style=\"border-top:1px solid {RULE};font-size:0;line-height:0;\">&nbsp;</td></tr></table>"
    )
}

fn render_payload(payload: &Payload<'_>) -> String {
    match payload {
        Payload::None => String::new(),
        // The code is the loudest thing in the mail, and it earns that by
        // being the only thing the reader has to carry somewhere else. Wide
        // tracking is what makes six digits transcribable at a glance; the
        // headline above it is set tight, and that contrast is the identity.
        Payload::Code(code) => format!(
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:28px 0 0;\">\
             <tr><td class=\"plate\" align=\"center\" style=\"background-color:{PLATE};border:1px solid {RULE};border-radius:12px;padding:22px 30px;\">\
             <span class=\"ink\" style=\"font-family:{MONO};font-size:32px;line-height:1.1;font-weight:500;letter-spacing:0.16em;color:{INK};\">{code}</span>\
             </td></tr></table>",
            code = escape(code)
        ),
        Payload::Action { label, url } => format!(
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:28px 0 0;\">\
             <tr><td bgcolor=\"{BRAND}\" style=\"background-color:{BRAND};border-radius:12px;\">\
             <a href=\"{url}\" style=\"display:inline-block;padding:13px 22px;font-family:{SANS};font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none;\">{label}</a>\
             </td></tr></table>",
            url = escape(url),
            label = escape(label)
        ),
    }
}

/// Wraps a headline, the sentences that introduce the payload, the payload
/// itself and whatever is left to say in the shell.
///
/// `lead` and `note` are separate arguments rather than one list because the
/// payload belongs directly under the sentence that introduces it. The "if
/// this was not you" line is always the last thing in a mail, never something
/// the reader has to step over to reach the code they came for.
fn letter(
    lang: Language,
    headline: &str,
    lead: &[&str],
    payload: Payload<'_>,
    note: &[&str],
) -> String {
    // The class travels with the colour: the dark-scheme block keys off it,
    // so a paragraph styled as meta must also be classed as meta or it comes
    // back at full strength on a dark ground.
    let paragraphs = |set: &[&str], size: u8, color: &str, class: &str| {
        set.iter()
            .map(|paragraph| {
                format!(
                    "<p class=\"{class}\" style=\"margin:14px 0 0;font-size:{size}px;line-height:1.6;color:{color};\">{}</p>",
                    escape(paragraph)
                )
            })
            .collect::<String>()
    };
    let body = paragraphs(lead, 16, BODY, "body");
    // Whatever follows the payload is a caveat, not an instruction, so it is
    // set quieter: at body size it competes with the code the reader came
    // for, which is the one thing this mail exists to hand over.
    let tail = paragraphs(note, 14, META, "meta");

    format!(
        "<!doctype html><html lang=\"{lang_code}\" dir=\"{dir}\"><head>\
         <meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"color-scheme\" content=\"light dark\">\
         <meta name=\"supported-color-schemes\" content=\"light dark\">\
         <style>{DARK_SCHEME}</style></head>\
         <body class=\"ground\" style=\"margin:0;padding:0;background-color:{GROUND};\">\
         <table role=\"presentation\" class=\"ground\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background-color:{GROUND};\">\
         <tr><td align=\"center\" style=\"padding:40px 20px;\">\
         <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:520px;\">\
         <tr><td dir=\"{dir}\" style=\"font-family:{SANS};text-align:{align};\">\
         <p class=\"mark\" style=\"margin:0 0 14px;font-size:15px;font-weight:600;letter-spacing:-0.03em;color:{BRAND};\">krypta</p>\
         {rule}\
         <h1 class=\"ink\" style=\"margin:26px 0 0;font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:{INK};\">{headline}</h1>\
         {body}\
         {payload}\
         {tail}\
         <div style=\"height:32px;line-height:32px;font-size:0;\">&nbsp;</div>\
         {rule}\
         <p class=\"meta\" style=\"margin:14px 0 0;font-size:13px;line-height:1.6;color:{META};\">\
         {footer}</p>\
         </td></tr></table></td></tr></table></body></html>",
        lang_code = lang.code(),
        dir = lang.dir(),
        align = lang.align(),
        footer = escape(lang.pick(FOOTER_EN, FOOTER_AR)),
        headline = escape(headline),
        rule = hairline(),
        payload = render_payload(&payload),
    )
}

const FOOTER_EN: &str = "Sent by krypta. This message loads nothing when you open it: no images, no web fonts, no tracking.";
const FOOTER_AR: &str =
    "أُرسلت من krypta. لا تحمّل هذه الرسالة أي شيء عند فتحها: لا صور ولا خطوط ويب ولا تتبع.";

/// The code mail. No links, no tracking pixel, no user content: a mail
/// provider breach yields a six-digit number that has already expired.
pub fn verification_mail(to: &str, code: &str, ttl_minutes: u64, lang: Language) -> Mail {
    match lang {
        Language::En => Mail {
            to: to.to_string(),
            subject: "Your krypta verification code".to_string(),
            text: format!(
                "Your krypta verification code is {code}\n\n\
                 It expires in {ttl_minutes} minutes. If you did not try to create an \
                 account, you can ignore this message."
            ),
            html: letter(
                lang,
                "Your verification code",
                &[&format!(
                    "Enter it to finish creating your account. It expires in {ttl_minutes} minutes."
                )],
                Payload::Code(code),
                &["If you did not try to create an account, ignore this message."],
            ),
        },
        Language::Ar => Mail {
            to: to.to_string(),
            subject: "رمز التحقق من حسابك في krypta".to_string(),
            text: format!(
                "رمز التحقق من حسابك في krypta هو {code}\n\n\
                 تنتهي صلاحيته خلال {ttl_minutes} دقيقة. إذا لم تحاول إنشاء حساب فيمكنك \
                 تجاهل هذه الرسالة."
            ),
            html: letter(
                lang,
                "رمز التحقق الخاص بك",
                &[&format!(
                    "أدخله لإكمال إنشاء حسابك. تنتهي صلاحيته خلال {ttl_minutes} دقيقة."
                )],
                Payload::Code(code),
                &["إذا لم تحاول إنشاء حساب فتجاهل هذه الرسالة."],
            ),
        },
    }
}

/// Sent instead of a code when the address already has an account. This is the
/// only place the duplicate case is distinguishable, and only the real owner
/// sees it; the HTTP response is identical either way.
pub fn account_exists_mail(to: &str, lang: Language) -> Mail {
    match lang {
        Language::En => Mail {
            to: to.to_string(),
            subject: "Someone tried to sign up to krypta with your address".to_string(),
            text: "An account with this address already exists, so no new one was \
                   created and no code was issued.\n\n\
                   If this was you, sign in instead. If it was not, no action is \
                   needed: whoever tried cannot access your account without your \
                   password."
                .to_string(),
            html: letter(
                lang,
                "This address already has an account",
                &["No new account was created and no code was issued."],
                Payload::None,
                &[
                    "If this was you, sign in instead. If it was not, no action is needed: \
                   whoever tried cannot reach your account without your password.",
                ],
            ),
        },
        Language::Ar => Mail {
            to: to.to_string(),
            subject: "حاول أحدهم التسجيل في krypta بعنوانك".to_string(),
            text: "يوجد حساب بهذا العنوان من قبل، لذا لم يُنشأ حساب جديد ولم يصدر أي رمز.\n\n\
                   إذا كنت أنت، فسجّل الدخول بدلًا من ذلك. وإذا لم تكن أنت فلا حاجة إلى \
                   أي إجراء: من حاول لا يستطيع الوصول إلى حسابك دون كلمة مرورك."
                .to_string(),
            html: letter(
                lang,
                "لهذا العنوان حساب بالفعل",
                &["لم يُنشأ حساب جديد ولم يصدر أي رمز."],
                Payload::None,
                &[
                    "إذا كنت أنت، فسجّل الدخول بدلًا من ذلك. وإذا لم تكن أنت فلا حاجة إلى أي \
                     إجراء: من حاول لا يستطيع الوصول إلى حسابك دون كلمة مرورك.",
                ],
            ),
        },
    }
}

/// The vault-recovery code mail.
///
/// Deliberately as bare as the verification mail: a six-digit code, a lifetime,
/// and nothing else. No form title (the server cannot read one), no account
/// detail beyond the address it is being sent to, and no link: a mailed link
/// that advances an account-recovery flow is exactly what the code-based design
/// exists to avoid.
pub fn recovery_code_mail(to: &str, code: &str, ttl_minutes: u64, lang: Language) -> Mail {
    match lang {
        Language::En => Mail {
            to: to.to_string(),
            subject: "Your krypta vault recovery code".to_string(),
            text: format!(
                "Your krypta vault recovery code is {code}\n\n\
                 It expires in {ttl_minutes} minutes. You will also need the recovery \
                 code you saved when you created your account. If you did not ask to \
                 recover your vault, you can ignore this message."
            ),
            html: letter(
                lang,
                "Your vault recovery code",
                &[&format!(
                    "Enter it to continue. It expires in {ttl_minutes} minutes."
                )],
                Payload::Code(code),
                &[
                    "You will also need the recovery code you saved when you created your \
                     account. Without it, nobody can open your vault, and that includes us.",
                    "If you did not ask to recover your vault, ignore this message.",
                ],
            ),
        },
        Language::Ar => Mail {
            to: to.to_string(),
            subject: "رمز استرداد خزنتك في krypta".to_string(),
            text: format!(
                "رمز استرداد خزنتك في krypta هو {code}\n\n\
                 تنتهي صلاحيته خلال {ttl_minutes} دقيقة. ستحتاج أيضًا إلى رمز الاسترداد \
                 الذي حفظته عند إنشاء حسابك. إذا لم تطلب استرداد خزنتك فيمكنك تجاهل هذه \
                 الرسالة."
            ),
            html: letter(
                lang,
                "رمز استرداد خزنتك",
                &[&format!(
                    "أدخله للمتابعة. تنتهي صلاحيته خلال {ttl_minutes} دقيقة."
                )],
                Payload::Code(code),
                &[
                    "ستحتاج أيضًا إلى رمز الاسترداد الذي حفظته عند إنشاء حسابك. وبدونه لا \
                     يستطيع أحد فتح خزنتك، ونحن منهم.",
                    "إذا لم تطلب استرداد خزنتك فتجاهل هذه الرسالة.",
                ],
            ),
        },
    }
}

/// Sent instead of a code when no account exists for the address.
///
/// The mirror of `account_exists_mail`: the HTTP response to `recover/start` is
/// identical either way, so this mail is the only place the two cases differ
/// and only the address's owner ever sees it.
pub fn no_account_mail(to: &str, lang: Language) -> Mail {
    match lang {
        Language::En => Mail {
            to: to.to_string(),
            subject: "No krypta account exists for this address".to_string(),
            text: "Someone asked to recover a krypta vault for this address, but no \
                   account exists here, so nothing was sent and nothing was changed.\n\n\
                   If this was you, check which address you signed up with."
                .to_string(),
            html: letter(
                lang,
                "No account exists for this address",
                &[
                    "Someone asked to recover a vault here. Nothing was sent and nothing \
                   was changed.",
                ],
                Payload::None,
                &["If this was you, check which address you signed up with."],
            ),
        },
        Language::Ar => Mail {
            to: to.to_string(),
            subject: "لا يوجد حساب في krypta بهذا العنوان".to_string(),
            text: "طلب أحدهم استرداد خزنة في krypta لهذا العنوان، لكن لا يوجد حساب هنا، \
                   لذا لم يُرسل شيء ولم يتغير شيء.\n\n\
                   إذا كنت أنت، فتحقق من العنوان الذي سجّلت به."
                .to_string(),
            html: letter(
                lang,
                "لا يوجد حساب بهذا العنوان",
                &["طلب أحدهم استرداد خزنة هنا. لم يُرسل شيء ولم يتغير شيء."],
                Payload::None,
                &["إذا كنت أنت، فتحقق من العنوان الذي سجّلت به."],
            ),
        },
    }
}

/// "a viewer" but "an editor". The two roles that reach this today start with
/// a consonant and a vowel respectively, so the article cannot be a constant.
fn article_for(role: &str) -> &'static str {
    match role.chars().next() {
        Some('a' | 'e' | 'i' | 'o' | 'u' | 'A' | 'E' | 'I' | 'O' | 'U') => "an",
        _ => "a",
    }
}

/// The role as the Arabic text names it. Anything unknown is passed through, so
/// a new role is merely untranslated rather than lost.
fn role_ar(role: &str) -> &str {
    match role {
        "editor" => "محرر",
        "viewer" => "مشاهد",
        other => other,
    }
}

/// A generic collaboration invitation. Form content and cryptographic
/// material never enter mail; the opaque capability remains in the URL
/// fragment until the browser explicitly continues the invitation flow.
pub fn invitation_mail(
    to: &str,
    role: &str,
    invitation_url: &str,
    ttl_days: u64,
    lang: Language,
) -> Mail {
    match lang {
        Language::En => {
            let article = article_for(role);
            Mail {
                to: to.to_string(),
                subject: "You have been invited to collaborate in krypta".to_string(),
                text: format!(
                    "You have been invited to collaborate as {article} {role} in krypta.\n\n\
                     Open this invitation to continue:\n{invitation_url}\n\n\
                     This invitation expires in {ttl_days} days. If you were not expecting it, \
                     you can ignore this message."
                ),
                html: letter(
                    lang,
                    "You have been invited to collaborate",
                    &[&format!(
                        "Someone has shared their work with you as {article} {role}."
                    )],
                    Payload::Action {
                        label: "Open invitation",
                        url: invitation_url,
                    },
                    &[&format!(
                        "The invitation expires in {ttl_days} days. If you were not expecting it, \
                         ignore this message."
                    )],
                ),
            }
        }
        Language::Ar => {
            let role = role_ar(role);
            Mail {
                to: to.to_string(),
                subject: "دُعيت إلى التعاون في krypta".to_string(),
                text: format!(
                    "دُعيت إلى التعاون بصفة {role} في krypta.\n\n\
                     افتح هذه الدعوة للمتابعة:\n{invitation_url}\n\n\
                     تنتهي صلاحية هذه الدعوة خلال {ttl_days} أيام. إذا لم تكن تتوقعها فيمكنك \
                     تجاهل هذه الرسالة."
                ),
                html: letter(
                    lang,
                    "دُعيت إلى التعاون",
                    &[&format!("شارك أحدهم عمله معك بصفة {role}.")],
                    Payload::Action {
                        label: "فتح الدعوة",
                        url: invitation_url,
                    },
                    &[&format!(
                        "تنتهي صلاحية الدعوة خلال {ttl_days} أيام. إذا لم تكن تتوقعها فتجاهل \
                         هذه الرسالة."
                    )],
                ),
            }
        }
    }
}

/// A content-free notification sent only after an accepted membership has
/// received both sealed form grants. It intentionally contains no form link,
/// title, role, key material, or other collaboration metadata.
pub fn form_ready_mail(to: &str, lang: Language) -> Mail {
    match lang {
        Language::En => Mail {
            to: to.to_string(),
            subject: "A shared form is ready in krypta".to_string(),
            text: "A form shared with you is ready. You can sign in to krypta to open it."
                .to_string(),
            html: letter(
                lang,
                "A shared form is ready",
                &["You can sign in to krypta to open it."],
                // No link, deliberately: this mail names no form and carries no
                // capability, so there is nothing here worth linking to that the
                // dashboard does not already show.
                Payload::None,
                &[],
            ),
        },
        Language::Ar => Mail {
            to: to.to_string(),
            subject: "نموذج مشترك جاهز في krypta".to_string(),
            text: "نموذج شُورك معك أصبح جاهزًا. يمكنك تسجيل الدخول إلى krypta لفتحه.".to_string(),
            html: letter(
                lang,
                "نموذج مشترك جاهز",
                &["يمكنك تسجيل الدخول إلى krypta لفتحه."],
                Payload::None,
                &[],
            ),
        },
    }
}

/// Tells a member that responses arrived, without naming the form.
///
/// The form title is `forms.title_ciphertext` and the API holds no key for it,
/// so there is nothing to put in a subject line. The recipient's browser
/// decrypts the name after following the link. Never add response content or a
/// title here: the server has neither.
pub fn response_notification_mail(
    to: &str,
    form_id: Uuid,
    count: i64,
    web_base_url: &str,
    lang: Language,
) -> Mail {
    let link = format!("{}/dashboard/{form_id}", web_base_url.trim_end_matches('/'));
    match lang {
        Language::En => {
            let noun = if count == 1 { "response" } else { "responses" };
            Mail {
                to: to.to_string(),
                subject: format!("New {noun} in krypta"),
                text: format!("You have {count} new {noun}. Open the form to read them: {link}"),
                html: letter(
                    lang,
                    &format!("You have {count} new {noun}"),
                    &[
                        "They are waiting in your dashboard, encrypted until your browser opens them.",
                    ],
                    Payload::Action {
                        label: "Open the form",
                        url: &link,
                    },
                    &[],
                ),
            }
        }
        Language::Ar => {
            // Arabic counts: one, two, 3 to 10 take the plural, 11 and over the singular.
            let phrase = match count {
                1 => "رد جديد واحد".to_string(),
                2 => "ردّان جديدان".to_string(),
                3..=10 => format!("{count} ردود جديدة"),
                _ => format!("{count} ردًا جديدًا"),
            };
            Mail {
                to: to.to_string(),
                subject: "ردود جديدة في krypta".to_string(),
                text: format!("لديك {phrase}. افتح النموذج لقراءتها: {link}"),
                html: letter(
                    lang,
                    &format!("لديك {phrase}"),
                    &["هي بانتظارك في لوحتك، مشفرة حتى يفتحها متصفحك."],
                    Payload::Action {
                        label: "فتح النموذج",
                        url: &link,
                    },
                    &[],
                ),
            }
        }
    }
}

/// Warns an owner that an account is approaching its monthly response
/// allowance, before the account hits it and submissions start bouncing.
///
/// No form title: `forms.title_ciphertext` is encrypted and the API holds no
/// key. The link goes to account settings rather than any one form, because
/// the allowance is per account, not per form.
pub fn allowance_warning_mail(
    to: &str,
    used: i64,
    allowance: i64,
    web_base_url: &str,
    lang: Language,
) -> Mail {
    let link = format!("{}/dashboard/settings", web_base_url.trim_end_matches('/'));
    match lang {
        Language::En => Mail {
            to: to.to_string(),
            subject: "You are approaching your krypta response limit".to_string(),
            text: format!(
                "You have used {used} of your {allowance} responses for this billing \
                 period.\n\n\
                 Once you reach the limit, new responses will stop being collected \
                 until the period resets or you upgrade. Manage your plan: {link}"
            ),
            html: letter(
                lang,
                "You are close to your response limit",
                &[
                    &format!(
                        "You have used {used} of your {allowance} responses for this billing period."
                    ),
                    "At the limit, new responses stop being collected until the period resets \
                     or you upgrade. Nothing already collected is ever deleted.",
                ],
                Payload::Action {
                    label: "Manage your plan",
                    url: &link,
                },
                &[],
            ),
        },
        Language::Ar => Mail {
            to: to.to_string(),
            subject: "اقتربت من حد الردود في krypta".to_string(),
            text: format!(
                "استخدمت {used} من أصل {allowance} ردًا في فترة الفوترة هذه.\n\n\
                 عند بلوغ الحد يتوقف جمع الردود الجديدة حتى تبدأ فترة جديدة أو تقوم \
                 بالترقية. أدر خطتك: {link}"
            ),
            html: letter(
                lang,
                "اقتربت من حد الردود",
                &[
                    &format!("استخدمت {used} من أصل {allowance} ردًا في فترة الفوترة هذه."),
                    "عند بلوغ الحد يتوقف جمع الردود الجديدة حتى تبدأ فترة جديدة أو تقوم \
                     بالترقية. لا يُحذف أي شيء جُمع بالفعل.",
                ],
                Payload::Action {
                    label: "إدارة خطتك",
                    url: &link,
                },
                &[],
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn canonical_address_accepts_only_a_bare_address_and_lowercases_it() {
        assert_eq!(
            canonical_address("Someone@Example.COM").as_deref(),
            Some("someone@example.com")
        );
        for decorated in [
            " someone@example.com",
            "someone@example.com ",
            "Someone <someone@example.com>",
            "<someone@example.com>",
            "someone@example.com, other@example.com",
            "not an address",
            "",
        ] {
            assert_eq!(canonical_address(decorated), None, "{decorated:?}");
        }
    }

    use super::*;

    #[tokio::test]
    async fn capture_mailer_records_what_it_was_asked_to_send() {
        let mailer = Mailer::capture();
        mailer
            .send(verification_mail(
                "someone@example.com",
                "123456",
                15,
                Language::En,
            ))
            .await
            .unwrap();

        let sent = mailer.captured();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].to, "someone@example.com");
        assert!(sent[0].text.contains("123456"));
    }

    #[tokio::test]
    async fn failing_mailer_reports_delivery_failure_without_inspecting_mail() {
        let result = Mailer::failing()
            .send(invitation_mail(
                "recipient@example.com",
                "viewer",
                "https://app.example/invitations/accept#token=opaque",
                7,
                Language::En,
            ))
            .await;
        assert!(result.is_err());
    }

    /// Every mail krypta sends, in one place, so the invariants below cannot
    /// be satisfied by seven of them.
    fn every_mail_in(lang: Language) -> Vec<Mail> {
        vec![
            verification_mail("someone@example.com", "007007", 15, lang),
            account_exists_mail("someone@example.com", lang),
            recovery_code_mail("someone@example.com", "424242", 15, lang),
            no_account_mail("someone@example.com", lang),
            invitation_mail(
                "someone@example.com",
                "editor",
                "https://app.example/invitations/accept#token=opaque",
                7,
                lang,
            ),
            form_ready_mail("someone@example.com", lang),
            response_notification_mail(
                "someone@example.com",
                Uuid::now_v7(),
                3,
                "https://krypta.example",
                lang,
            ),
            allowance_warning_mail(
                "someone@example.com",
                200,
                250,
                "https://krypta.example",
                lang,
            ),
        ]
    }

    fn every_mail() -> Vec<Mail> {
        [Language::En, Language::Ar]
            .into_iter()
            .flat_map(every_mail_in)
            .collect()
    }

    /// Opening a krypta mail must request nothing from anywhere.
    ///
    /// This is the same property the product enforces on the web, where the
    /// header image and the font files were both pulled back onto this origin
    /// so that reading something never announces itself to a third party. A
    /// remote logo, a spacer image or a hosted stylesheet would put a read
    /// receipt in every message, which is why the mark at the top of each
    /// mail is set in type instead.
    #[test]
    fn no_mail_requests_a_remote_resource_when_it_is_opened() {
        for mail in every_mail() {
            let html = mail.html.to_lowercase();
            for fetcher in ["<img", "src=", "url(", "@import", "background=", "<iframe"] {
                assert!(
                    !html.contains(fetcher),
                    "{} would fetch something: {fetcher}",
                    mail.subject
                );
            }
        }
    }

    /// The only URL any mail may carry is the one the reader is being asked
    /// to follow, and four of the eight ask for nothing at all.
    #[test]
    fn a_mail_links_only_where_it_asks_the_reader_to_go() {
        for mail in every_mail() {
            let links = mail.html.matches("href=").count();
            assert!(
                links <= 1,
                "{} carries {links} links; one action per mail",
                mail.subject
            );
        }
    }

    /// Every mail is recognisably from krypta and says what it is.
    #[test]
    fn every_mail_carries_the_mark_and_the_footer() {
        for mail in every_mail() {
            assert!(
                mail.html.contains(">krypta</p>"),
                "{} lost the mark",
                mail.subject
            );
            assert!(
                mail.html
                    .contains("This message loads nothing when you open it")
                    || mail.html.contains("لا تحمّل هذه الرسالة أي شيء"),
                "{} lost the footer",
                mail.subject
            );
        }
    }

    #[test]
    fn verification_mail_carries_the_code_and_no_links() {
        let mail = verification_mail("someone@example.com", "007007", 15, Language::En);
        assert!(mail.text.contains("007007"));
        assert!(mail.html.contains("007007"));
        // No URL may appear: a mailed link that grants account state is
        // exactly what the code-based flow exists to avoid.
        assert!(!mail.text.contains("http"));
        assert!(!mail.html.contains("http"));
    }

    #[test]
    fn verification_mail_ttl_follows_the_argument() {
        let mail = verification_mail("someone@example.com", "007007", 5, Language::En);
        assert!(mail.text.contains("5 minutes"));
        assert!(mail.html.contains("5 minutes"));
        assert!(!mail.text.contains("15 minutes"));
        assert!(!mail.html.contains("15 minutes"));
    }

    #[test]
    fn recovery_code_mail_carries_the_code_and_nothing_about_the_account() {
        let mail = recovery_code_mail("someone@example.com", "424242", 15, Language::En);
        assert!(mail.text.contains("424242"));
        assert!(mail.html.contains("424242"));
        assert!(mail.text.contains("15 minutes"));
        // No link, and nothing the server could not have known without
        // decrypting something.
        assert!(!mail.text.contains("http"));
        assert!(!mail.html.contains("http"));
        for leak in ["form", "title", "wrapped", "verifier", "account key"] {
            assert!(!mail.text.to_lowercase().contains(leak), "leaked {leak}");
            assert!(!mail.html.to_lowercase().contains(leak), "leaked {leak}");
        }
    }

    #[test]
    fn no_account_mail_carries_no_code() {
        let mail = no_account_mail("someone@example.com", Language::En);
        assert!(!mail.text.chars().any(|c| c.is_ascii_digit()));
        assert!(!mail.text.contains("http"));
    }

    #[test]
    fn account_exists_mail_carries_no_code() {
        let mail = account_exists_mail("someone@example.com", Language::En);
        assert!(!mail.text.chars().any(|c| c.is_ascii_digit()));
        assert!(mail.subject.to_lowercase().contains("krypta"));
    }

    #[test]
    fn invitation_mail_has_fragment_token_but_no_form_content() {
        let mail = invitation_mail(
            "viewer@example.com",
            "viewer",
            "https://app.example/invitations/accept#token=opaque",
            7,
            Language::En,
        );
        assert!(mail.text.contains("#token=opaque"));
        assert!(mail.text.contains("7 days"));
        assert!(!mail.text.contains("form title"));
        assert!(!mail.text.contains("question ciphertext"));
    }

    #[test]
    fn response_notification_names_no_form_and_carries_a_deep_link() {
        let form_id = Uuid::now_v7();
        let mail = response_notification_mail(
            "owner@example.com",
            form_id,
            12,
            "https://krypta.example",
            Language::En,
        );

        assert_eq!(mail.to, "owner@example.com");
        assert_eq!(mail.subject, "New responses in krypta");
        assert!(mail.text.contains("12 new responses"));
        assert!(
            mail.text
                .contains(&format!("https://krypta.example/dashboard/{form_id}"))
        );
        assert!(
            mail.html
                .contains(&format!("https://krypta.example/dashboard/{form_id}"))
        );
    }

    #[test]
    fn a_single_response_reads_as_singular() {
        let mail = response_notification_mail(
            "owner@example.com",
            Uuid::now_v7(),
            1,
            "https://krypta.example",
            Language::En,
        );

        assert_eq!(mail.subject, "New response in krypta");
        assert!(mail.text.contains("1 new response"));
        assert!(!mail.text.contains("1 new responses"));
    }

    #[test]
    fn allowance_warning_carries_the_numbers_and_a_settings_link_but_no_form_title() {
        let mail = allowance_warning_mail(
            "owner@example.com",
            200,
            250,
            "https://krypta.example",
            Language::En,
        );

        assert_eq!(mail.to, "owner@example.com");
        assert!(mail.text.contains("200"));
        assert!(mail.text.contains("250"));
        assert!(
            mail.text
                .contains("https://krypta.example/dashboard/settings")
        );
        assert!(
            mail.html
                .contains("https://krypta.example/dashboard/settings")
        );
        for leak in ["title", "schema", "ciphertext"] {
            assert!(!mail.text.to_lowercase().contains(leak), "leaked {leak}");
            assert!(!mail.html.to_lowercase().contains(leak), "leaked {leak}");
        }
    }
}

#[cfg(test)]
mod arabic {
    use super::*;

    #[test]
    fn an_arabic_mail_is_right_to_left_and_in_arabic() {
        let mail = verification_mail("someone@example.com", "007007", 15, Language::Ar);
        assert!(mail.html.contains("lang=\"ar\" dir=\"rtl\""));
        assert!(mail.html.contains("text-align:right"));
        assert!(mail.text.contains("007007"));
        assert!(mail.text.contains("15 دقيقة"));
        assert!(mail.subject.contains("krypta"));
        assert!(
            mail.text
                .chars()
                .any(|c| ('\u{0600}'..='\u{06ff}').contains(&c))
        );
    }

    #[test]
    fn english_stays_left_to_right() {
        let mail = verification_mail("someone@example.com", "007007", 15, Language::En);
        assert!(mail.html.contains("lang=\"en\" dir=\"ltr\""));
    }

    #[test]
    fn an_unknown_language_is_english() {
        assert_eq!(Language::from_code(Some("ar")), Language::Ar);
        assert_eq!(Language::from_code(Some("fr")), Language::En);
        assert_eq!(Language::from_code(Some("")), Language::En);
        assert_eq!(Language::from_code(None), Language::En);
    }

    #[test]
    fn arabic_response_counts_follow_arabic_grammar() {
        let text = |count| {
            response_notification_mail(
                "a@b.c",
                Uuid::now_v7(),
                count,
                "https://k.example",
                Language::Ar,
            )
            .text
        };
        assert!(text(1).contains("رد جديد واحد"));
        assert!(text(2).contains("ردّان جديدان"));
        assert!(text(5).contains("5 ردود جديدة"));
        assert!(text(12).contains("12 ردًا جديدًا"));
    }

    #[test]
    fn an_arabic_mail_carries_no_dash() {
        for lang in [Language::Ar] {
            let mail = invitation_mail("a@b.c", "viewer", "https://k.example/x", 7, lang);
            for text in [&mail.text, &mail.html, &mail.subject] {
                assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
            }
        }
    }
}

#[cfg(test)]
mod form_ready {
    use super::form_ready_mail;

    #[test]
    fn contains_no_form_content_or_key_material() {
        let mail = form_ready_mail("recipient@example.com", super::Language::En);
        assert_eq!(mail.subject, "A shared form is ready in krypta");
        assert!(mail.text.contains("sign in to krypta"));
        assert!(mail.html.contains("sign in to krypta"));
        for sensitive in [
            "form title",
            "question ciphertext",
            "encrypted_form_data_key",
            "encrypted_form_private_key",
            "recipient public key",
            "http",
        ] {
            assert!(!mail.text.contains(sensitive));
            assert!(!mail.html.contains(sensitive));
        }
    }
}
