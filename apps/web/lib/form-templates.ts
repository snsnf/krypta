import type { Question, QuestionCondition } from "@krypta/crypto"

/**
 * Ready-made forms for the "New form" gallery.
 *
 * Plain data shipped in the bundle. Which one a creator picks stays in the
 * browser: it is never put in a URL, where a slug like "anonymous-report"
 * would land in proxy and server logs as a description of what this person
 * is building.
 *
 * Questions use short local keys rather than ids so that every form made from
 * a template gets fresh ones (see `instantiateTemplate`); two forms sharing
 * question ids would be harmless today and a trap the day anything keys on
 * them across forms.
 */

export type TemplateQuestion = Omit<Question, "id" | "condition"> & {
  key: string
  condition?: {
    key: string
    operator: QuestionCondition["operator"]
    value: string
  }
}

export type FormTemplate = {
  /** A stable slug. Never sent anywhere. */
  id: string
  name: string
  description: string
  title: string
  confirmationMessage: string
  questions: TemplateQuestion[]
}

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    id: "event-feedback",
    name: "Event feedback",
    description: "A star rating, with a follow-up only for low scores.",
    title: "Event feedback",
    confirmationMessage: "Thanks for your feedback!",
    questions: [
      {
        key: "rating",
        type: "rating",
        label: "How was the event?",
        required: true,
        rating: { style: "stars", min: 1, max: 5 },
      },
      {
        key: "wrong",
        type: "long_text",
        label: "What went wrong?",
        condition: { key: "rating", operator: "at_most", value: "2" },
      },
      { key: "enjoyed", type: "long_text", label: "What was good?" },
      {
        key: "again",
        type: "multiple_choice",
        label: "Would you return?",
        options: ["Yes", "Maybe", "No"],
      },
    ],
  },
  {
    id: "rsvp",
    name: "RSVP",
    description: "Who is coming, how many guests, and dietary needs.",
    title: "RSVP",
    confirmationMessage: "Thanks for your reply!",
    questions: [
      { key: "name", type: "short_text", label: "Your name", required: true },
      {
        key: "attending",
        type: "multiple_choice",
        label: "Will you attend?",
        required: true,
        options: ["Yes", "No"],
      },
      {
        key: "guests",
        type: "number",
        label: "How many guests?",
        condition: { key: "attending", operator: "is", value: "Yes" },
      },
      // Asked of everyone: a second show-if rule would push an unedited RSVP
      // past the padding floor (see the size test).
      { key: "diet", type: "short_text", label: "Any dietary requirements?" },
    ],
  },
  {
    id: "job-application",
    name: "Job application",
    description: "Contact details, the role and an encrypted CV upload.",
    title: "Job application",
    confirmationMessage: "Thanks for applying!",
    questions: [
      { key: "name", type: "short_text", label: "Name", required: true },
      { key: "email", type: "email", label: "Email", required: true },
      {
        key: "role",
        type: "short_text",
        label: "Role",
        required: true,
      },
      { key: "cv", type: "file_upload", label: "Your CV", required: true },
      { key: "fit", type: "long_text", label: "Why you?" },
      { key: "start", type: "date", label: "Start date" },
    ],
  },
  {
    id: "contact",
    name: "Contact / feedback",
    description: "A message with a topic; name and email are optional.",
    title: "Contact us",
    confirmationMessage: "Thanks, we've received your message.",
    questions: [
      {
        key: "topic",
        type: "dropdown",
        label: "Topic",
        required: true,
        options: ["General question", "Report a problem", "Suggestion", "Other"],
      },
      { key: "message", type: "long_text", label: "Message", required: true },
      { key: "name", type: "short_text", label: "Name" },
      { key: "email", type: "email", label: "Email, if you'd like a reply" },
    ],
  },
  {
    id: "anonymous-report",
    name: "Anonymous report",
    description: "Report a concern without giving your name.",
    title: "Anonymous report",
    confirmationMessage:
      "Your report has been received. Thank you for speaking up.",
    questions: [
      { key: "what", type: "long_text", label: "What happened?", required: true },
      { key: "when", type: "date", label: "When did it happen?" },
      { key: "where", type: "short_text", label: "Where did it happen?" },
      { key: "evidence", type: "file_upload", label: "Evidence" },
      // One optional field rather than a yes/no plus a show-if follow-up:
      // the rule's extra id would push an unedited report into a larger,
      // rarer padding bucket, recognisable by size alone.
      {
        key: "reach",
        type: "short_text",
        label: "Want a reply? Leave a way to reach you (optional)",
      },
    ],
  },
]

/*
 * Every template published unedited must fit the 1024-byte padding floor,
 * or its fixed size would identify it; form-templates.test.ts enforces this.
 * Shorten copy before adding questions, and prefer dropping a show-if rule,
 * which costs a whole extra id.
 */

/**
 * The template as a new form's starting state: every question gets a fresh
 * id, and each condition is pointed at the new id of the question it names.
 */
export function instantiateTemplate(
  template: FormTemplate,
  newId: () => string = () => crypto.randomUUID()
): { title: string; confirmationMessage: string; questions: Question[] } {
  const ids = new Map(template.questions.map((q) => [q.key, newId()]))
  const questions = template.questions.map(
    ({ key, condition, ...rest }): Question => {
      const question: Question = { ...rest, id: ids.get(key) as string }
      if (condition) {
        question.condition = {
          questionId: ids.get(condition.key) as string,
          operator: condition.operator,
          value: condition.value,
        }
      }
      return question
    }
  )
  return {
    title: template.title,
    confirmationMessage: template.confirmationMessage,
    questions,
  }
}
