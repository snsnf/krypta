export type QuestionCondition = {
  /**
   * Must name an EARLIER question in the same form. That restriction is what
   * makes dependency cycles structurally impossible rather than something the
   * evaluator has to detect.
   */
  questionId: string;
  operator: "is" | "is_not";
  /** One of the source question's options. */
  value: string;
};

export type Question = {
  id: string;
  type:
    | "short_text"
    | "long_text"
    | "multiple_choice"
    | "checkboxes"
    | "dropdown"
    | "number"
    | "email"
    | "date"
    | "file_upload";
  label: string;
  options?: string[];
  required?: boolean;
  pageBreakBefore?: boolean;
  // Only meaningful when pageBreakBefore is true: an optional title shown
  // above the new page this question starts, Google-Forms-style.
  sectionTitle?: string;
  /**
   * Show this question only when the condition holds. Absent means always
   * visible, so every existing form is unaffected.
   */
  condition?: QuestionCondition;
  /**
   * Offer respondents an "Other" choice with a free-text box, on
   * multiple_choice and checkboxes. Absent means no, so existing forms are
   * unaffected. The written text is stored as a marked option value rather
   * than as its own field: see apps/web/lib/form-other.ts for why the answer
   * shape could not change.
   */
  allowOther?: boolean;
};

export type FormThemePreset =
  | "forest"
  | "ocean"
  | "plum"
  | "terracotta"
  | "sunflower"
  | "graphite"
  | "custom";

export type FormTypography = {
  font: string;
  size: number;
  /**
   * The font variant, named as the font catalogue names it: "regular",
   * "italic", "700", "700italic". Absent keeps the weight and style each
   * element already has, which is how every form made before variants existed
   * renders.
   */
  variant?: string;
};

export type FormLayout = "classic" | "focus";

export type FormTheme = {
  preset: FormThemePreset;
  accentColor: string;
  backgroundColor: string;
  typography: {
    header: FormTypography;
    question: FormTypography;
    text: FormTypography;
  };
  allowDarkMode?: boolean;
  layout?: FormLayout;
};

export type FormSettings = {
  allowMultipleResponses: boolean;
  /** Shown instead of the default thank-you text. Encrypted with the schema. */
  confirmationMessage?: string;
};

export type FormSchema = {
  questions: Question[];
  theme?: FormTheme;
  settings?: FormSettings;
  /**
   * `formKeyCommitment` of the form's public key. A respondent refuses a
   * served key that does not match it, and a schema without one. Every schema
   * this app writes carries it; it is optional in the type only because a
   * decrypted schema is untrusted input until it has been checked.
   */
  publicKeyCommitment?: string;
};
