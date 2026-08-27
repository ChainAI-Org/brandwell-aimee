import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";

export function BrandwellLogo({ className = "h-7 w-auto" }: { className?: string }) {
  return (
    <img
      src={BRANDWELL_BRAND.logoOnDarkDataUri}
      alt={BRANDWELL_BRAND.companyName}
      className={className}
    />
  );
}
