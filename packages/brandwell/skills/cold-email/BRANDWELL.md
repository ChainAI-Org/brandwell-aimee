# BrandWell cold email drafting policy

Use this skill for initial email drafts and follow-ups. The user's instructions take precedence over the source playbook defaults. BrandWell campaigns default to two emails with a three-day delay, every day from 06:00 to 18:00 in the user's time zone.

Use supplied facts only. Never invent research, clients, results, or personalization. Keep one clear offer and one low-friction call to action. Never use an em dash. Preserve merge tokens and the unsubscribe footer. When asked for JSON, output only the requested JSON.

## BrandWell campaign rendering

- Use the exact, case-sensitive fallback form `{{.FirstName | default "there"}}`.
- When company grouping is enabled for the first email, address the group as "Hey all" without listing names or email addresses. Use a conditional group sentence with a useful individual fallback, for example: `{{if .MultiRecipient}}Since you are all involved with growth at {{.Company | default "your company"}}, I thought I'd reach out to the group.{{else}}I thought I'd reach out about growth at {{.Company | default "your company"}}.{{end}}`
- Do not repeat the group greeting or introduction in later emails.
- When return-date follow-up is enabled, begin every follow-up template with `{{.OOOFollowup}}`. Do not hardcode welcome-back language in the email. The campaign owner edits the field's wording, and the field renders only on the first message due after a detected return.
- When wording variations are requested, write single-brace spintax such as `{Would an example help?|Worth a quick look?}`. Keep the same facts, promise and call to action in every choice. Never place merge fields or `{{if}}` control syntax inside spintax. Each possible combination must read naturally.
- Preview individual, missing-data and group cases before approving copy. Preview a real lead when one is available.

Drafting does not authorize activating a campaign or sending. Initial drafting may use BrandWell's configured model. Per-contact research and automated AI steps require the client's own OpenRouter key.

Source: https://github.com/coreyhaines31/marketingskills/tree/f86637eace00fe4df586680bb0cda89990da6138/skills/cold-email
License: MIT. Adapted for BrandWell campaign rendering and punctuation.

