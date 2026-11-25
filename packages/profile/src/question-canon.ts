// The question canon (ANS-001, ANS-002): the application questions that recur across forms, each
// with its kind and a few wordings. matchQuestion compares a form's question with these wordings.
// Slots in braces ({company}, {skill}, {country}, {city}) stand for any proper name.

export const QUESTION_KINDS = ["factual", "reusable_narrative", "company_specific"] as const;
// factual: answered from profile settings, no drafting. reusable_narrative: answered from the
// answer bank. company_specific: drafted fresh for each company (ANS-001).
export type QuestionKind = (typeof QUESTION_KINDS)[number];

// The profile setting that answers each factual question. The settings themselves arrive with the
// answer bank; these names are the contract between the two.
export const FACTUAL_FIELDS = [
  "work_authorization",
  "needs_sponsorship",
  "years_of_experience",
  "current_location",
  "willing_to_relocate",
  "work_arrangement",
  "earliest_start_date",
  "notice_period",
  "salary_expectation",
  "referral_source",
  "previously_employed",
  "linkedin_url",
  "portfolio_url",
] as const;
export type FactualField = (typeof FACTUAL_FIELDS)[number];

export interface CanonicalQuestion {
  readonly id: string;
  readonly kind: QuestionKind;
  // Set for factual questions only (a test checks it).
  readonly factualField: FactualField | null;
  // The canonical wording, shown to Paul.
  readonly text: string;
  // Other wordings that mean the same thing. Each must match this question exactly (a test checks
  // that no wording is closer to, or as close to, another question).
  readonly examples: readonly string[];
}

export const CANONICAL_QUESTIONS = [
  // Factual: answered from profile settings.
  {
    id: "work-authorization",
    kind: "factual",
    factualField: "work_authorization",
    text: "Are you legally authorized to work in {country}?",
    examples: [
      "Are you eligible to work in {country}?",
      "Do you have the right to work in {country}?",
    ],
  },
  {
    id: "sponsorship",
    kind: "factual",
    factualField: "needs_sponsorship",
    text: "Will you now or in the future require visa sponsorship?",
    examples: ["Do you need sponsorship?", "Will you require sponsorship to work in {country}?"],
  },
  {
    id: "years-experience",
    kind: "factual",
    factualField: "years_of_experience",
    text: "How many years of experience do you have with {skill}?",
    examples: ["Years of {skill} experience", "How many years have you worked with {skill}?"],
  },
  {
    id: "current-location",
    kind: "factual",
    factualField: "current_location",
    text: "Where are you currently located?",
    examples: ["Where are you based?", "What city do you currently live in?"],
  },
  {
    id: "relocation",
    kind: "factual",
    factualField: "willing_to_relocate",
    text: "Are you willing to relocate?",
    examples: ["Would you be open to relocating to {city}?", "Are you open to relocation?"],
  },
  {
    id: "work-arrangement",
    kind: "factual",
    factualField: "work_arrangement",
    text: "Do you prefer remote, hybrid or on-site work?",
    examples: ["Are you comfortable working on-site?", "Are you open to a hybrid arrangement?"],
  },
  {
    id: "start-date",
    kind: "factual",
    factualField: "earliest_start_date",
    text: "What is your earliest start date?",
    examples: ["When can you start?", "When would you be available to start?"],
  },
  {
    id: "notice-period",
    kind: "factual",
    factualField: "notice_period",
    text: "What is your notice period?",
    examples: ["How much notice do you need to give your current employer?"],
  },
  {
    id: "salary-expectation",
    kind: "factual",
    factualField: "salary_expectation",
    text: "What are your salary expectations?",
    examples: ["What is your desired salary?", "What are your compensation expectations?"],
  },
  {
    id: "referral-source",
    kind: "factual",
    factualField: "referral_source",
    text: "How did you hear about this role?",
    examples: ["How did you find this job?", "Who referred you?"],
  },
  {
    id: "previously-employed",
    kind: "factual",
    factualField: "previously_employed",
    text: "Have you previously worked for {company}?",
    examples: ["Have you ever been employed by {company}?", "Have you worked here before?"],
  },
  {
    id: "linkedin-url",
    kind: "factual",
    factualField: "linkedin_url",
    text: "LinkedIn profile URL",
    examples: ["Link to your LinkedIn"],
  },
  {
    id: "portfolio-url",
    kind: "factual",
    factualField: "portfolio_url",
    text: "Portfolio or personal website",
    examples: ["Link to your GitHub or portfolio", "Website"],
  },

  // Reusable narrative: answered from the answer bank, citing stories.
  {
    id: "about-yourself",
    kind: "reusable_narrative",
    factualField: null,
    text: "Tell us about yourself.",
    examples: ["Tell me about yourself.", "Introduce yourself.", "Tell us about your background."],
  },
  {
    id: "challenging-project",
    kind: "reusable_narrative",
    factualField: null,
    text: "Describe a challenging project you worked on.",
    examples: [
      "Tell me about the most difficult problem you have solved.",
      "What is the hardest technical problem you have worked on?",
    ],
  },
  {
    id: "accomplishment",
    kind: "reusable_narrative",
    factualField: null,
    text: "What accomplishment are you most proud of?",
    examples: ["What is your greatest achievement?", "Describe your biggest accomplishment."],
  },
  {
    id: "conflict",
    kind: "reusable_narrative",
    factualField: null,
    text: "Tell me about a time you had a conflict with a colleague.",
    examples: [
      "Describe a disagreement with a coworker and how you resolved it.",
      "How do you handle conflict?",
    ],
  },
  {
    id: "failure",
    kind: "reusable_narrative",
    factualField: null,
    text: "Tell me about a time you failed.",
    examples: ["Describe a mistake you made.", "Tell me about a setback and how you handled it."],
  },
  {
    id: "leadership",
    kind: "reusable_narrative",
    factualField: null,
    text: "Describe a time you led a team.",
    examples: [
      "Tell me about your leadership experience.",
      "Give an example of when you took the lead.",
    ],
  },
  {
    id: "ambiguity",
    kind: "reusable_narrative",
    factualField: null,
    text: "Tell me about a time you worked with unclear requirements.",
    examples: ["How do you handle ambiguity?", "Describe a situation with a lot of uncertainty."],
  },
  {
    id: "strengths",
    kind: "reusable_narrative",
    factualField: null,
    text: "What are your greatest strengths?",
    examples: ["What is your biggest strength?"],
  },
  {
    id: "weaknesses",
    kind: "reusable_narrative",
    factualField: null,
    text: "What is your biggest weakness?",
    examples: ["What is an area you are working to improve?", "What are your weaknesses?"],
  },
  {
    id: "why-leaving",
    kind: "reusable_narrative",
    factualField: null,
    text: "Why are you leaving your current job?",
    examples: [
      "Why did you leave your last position?",
      "Why do you want to leave your current role?",
    ],
  },
  {
    id: "career-goals",
    kind: "reusable_narrative",
    factualField: null,
    text: "What are your career goals?",
    examples: ["Where do you see yourself in five years?", "What are your long-term goals?"],
  },
  {
    id: "work-style",
    kind: "reusable_narrative",
    factualField: null,
    text: "Describe your ideal work environment.",
    examples: [
      "What kind of team environment helps you do your best work?",
      "Describe your ideal manager.",
    ],
  },

  // Company-specific narrative: drafted fresh, with company research and a bank template.
  {
    id: "why-this-company",
    kind: "company_specific",
    factualField: null,
    text: "Why do you want to work at {company}?",
    examples: [
      "Why do you want to work here?",
      "Why do you want to join {company}?",
      "What interests you about {company}?",
    ],
  },
  {
    id: "why-this-role",
    kind: "company_specific",
    factualField: null,
    text: "Why are you interested in this role?",
    examples: ["What excites you about this position?", "Why do you want this job?"],
  },
  {
    id: "company-knowledge",
    kind: "company_specific",
    factualField: null,
    text: "What do you know about {company}?",
    examples: ["What do you know about us?"],
  },
  {
    id: "contribution",
    kind: "company_specific",
    factualField: null,
    text: "What would you bring to {company}?",
    examples: ["How would you contribute to our team?", "What would you bring to the team?"],
  },
] as const satisfies readonly CanonicalQuestion[];

export type CanonicalQuestionId = (typeof CANONICAL_QUESTIONS)[number]["id"];
