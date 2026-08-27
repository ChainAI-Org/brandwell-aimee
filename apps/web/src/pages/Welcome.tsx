import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import { ArrowRight, BellRing, MessageSquareText, Monitor } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { BrandwellLogo } from "../components/brandwell/BrandwellLogo";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="relative flex min-h-full flex-col overflow-hidden bg-[#0b0c0f] text-[#f7f7fa]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_20%,rgba(111,28,255,.18),transparent_34%),radial-gradient(circle_at_20%_85%,rgba(237,22,140,.10),transparent_30%)]" />
      <div className="app-drag relative flex items-center justify-between border-b border-[#282a31] px-5 py-4 md:px-8">
        <BrandwellLogo className="h-[26px] w-auto" />
        <div className="hidden md:block">
          <WindowChrome />
        </div>
      </div>
      <main className="relative mx-auto grid w-full max-w-[1180px] flex-1 items-center gap-12 px-6 py-14 md:grid-cols-[1.08fr_.92fr] md:px-10 md:py-20">
        <section>
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#b786ff]">
            {BRANDWELL_BRAND.fullProductName}
          </p>
          <h1 className="mt-4 max-w-[680px] text-[48px] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[64px]">
            Your AI employee, with its own computer.
          </h1>
          <p className="mt-6 max-w-[620px] text-[17px] leading-7 text-[#a6a7b1]">
            Talk to AIMEE, see the work it completes, and step into its computer only when a login,
            approval, or decision needs you.
          </p>
          <button
            type="button"
            onClick={() => navigate("/sign-in")}
            className="app-no-drag mt-8 inline-flex items-center gap-2 rounded-full bg-[#ed168c] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_34px_rgba(237,22,140,.22)] transition hover:bg-[#ff279d]"
          >
            Open AIMEE
            <ArrowRight size={17} strokeWidth={2} />
          </button>
        </section>

        <section className="rounded-[24px] border border-[#30323a] bg-[#15161a]/95 p-5 shadow-[0_28px_80px_rgba(0,0,0,.38)] sm:p-7">
          <div className="flex items-center justify-between border-b border-[#2a2c33] pb-5">
            <div>
              <p className="text-[12px] uppercase tracking-[0.12em] text-[#858792]">
                AI GTM Employee
              </p>
              <p className="mt-1 text-[20px] font-semibold">AIMEE</p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#193225] px-3 py-1.5 text-[12px] font-medium text-[#67d996]">
              <span className="h-2 w-2 rounded-full bg-[#44c47a]" />
              Working normally
            </span>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <PreviewCard
              icon={<MessageSquareText size={18} />}
              title="Chat"
              detail="Ask, assign, and review"
            />
            <PreviewCard
              icon={<Monitor size={18} />}
              title="Computer"
              detail="Preview or take control"
            />
            <PreviewCard
              icon={<BellRing size={18} />}
              title="Needs attention"
              detail="Only when you are needed"
            />
            <PreviewCard
              icon={<ArrowRight size={18} />}
              title="Routines"
              detail="Work continues on schedule"
            />
          </div>
          <div className="mt-4 rounded-2xl border border-[#34363f] bg-[#1b1c21] p-4">
            <p className="text-[12px] uppercase tracking-[0.1em] text-[#858792]">
              Next scheduled work
            </p>
            <div className="mt-3 flex items-center justify-between gap-4">
              <div>
                <p className="text-[14px] font-medium">Review new buyer activity</p>
                <p className="mt-1 text-[12px] text-[#8c8e98]">
                  Intent, TrafficID, and campaign actions
                </p>
              </div>
              <span className="shrink-0 text-[13px] text-[#b786ff]">10:30 AM</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function PreviewCard({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-[#30323a] bg-[#1b1c21] p-4">
      <span className="text-[#b786ff]">{icon}</span>
      <p className="mt-4 text-[14px] font-medium">{title}</p>
      <p className="mt-1 text-[12px] text-[#858792]">{detail}</p>
    </div>
  );
}
