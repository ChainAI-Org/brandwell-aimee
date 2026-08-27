export const BRANDWELL_BRAND = {
  productName: "AIMEE",
  fullProductName: "BrandWell AI GTM Employee",
  companyName: "BrandWell",
  supportEmail: "support@brandwell.ai",
  apiUrl: "https://ai.brandwell.ai",
  portalUrl: "https://portal.brandwell.ai",
  privacyUrl: "https://brandwell.ai/privacy-policy/",
  termsUrl: "https://brandwell.ai/terms-of-service/",
  colors: {
    background: "#101114",
    surface: "#1a1b21",
    primary: "#6f1cff",
    accent: "#ed168c",
    text: "#f7f7fa",
    muted: "#a6a7b1",
  },
} as const;

export type BrandwellBrandConfig = typeof BRANDWELL_BRAND;
