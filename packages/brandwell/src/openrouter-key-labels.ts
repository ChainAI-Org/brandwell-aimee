const OPENROUTER_KEY_LABEL_MAX_LENGTH = 120;

function labelPart(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\r\n\t]/g, " ");
}

function boundedLabel(value: string): string {
  return value.slice(0, OPENROUTER_KEY_LABEL_MAX_LENGTH).trimEnd();
}

export function brandwellMasterOpenRouterKeyLabel(companyName: string): string {
  const company = labelPart(companyName);
  if (!company) throw new Error("A client company name is required for the OpenRouter key label");
  return boundedLabel(`AIMEE-${company}`);
}

export function brandwellSidekickOpenRouterKeyLabel(
  companyName: string,
  userEmail: string,
): string {
  const company = labelPart(companyName);
  const email = labelPart(userEmail).toLowerCase();
  if (!company || !email) {
    throw new Error(
      "A client company name and Sidekick email are required for the OpenRouter key label",
    );
  }
  return boundedLabel(`AIMEE-${company}-${email}`);
}
