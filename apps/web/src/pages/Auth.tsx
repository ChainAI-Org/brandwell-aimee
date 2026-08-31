import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import { ArrowLeft, Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BrandwellLogo } from "../components/brandwell/BrandwellLogo";

export function AuthPage() {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const response = await fetch("/api/auth/sign-in/brandwell", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).catch(() => null);
    const result = await response?.json().catch(() => ({}));
    setPending(false);
    if (!response?.ok) {
      setError(
        typeof result?.message === "string"
          ? result.message
          : typeof result?.error === "string"
            ? result.error
            : "Could not sign in with BrandWell",
      );
      return;
    }
    window.location.assign("/app");
  }

  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-[#0b0c0f] px-5 py-12 text-[#f7f7fa]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(111,28,255,.14),transparent_38%)]" />
      <Link
        to="/"
        className="absolute left-5 top-5 z-10 grid h-10 w-10 place-items-center rounded-full border border-[#30323a] bg-[#15161a] text-[#a6a7b1] hover:text-white"
        aria-label="Back"
      >
        <ArrowLeft size={17} />
      </Link>
      <form
        onSubmit={submit}
        className="relative w-full max-w-[430px] rounded-[24px] border border-[#30323a] bg-[#15161a] p-6 shadow-[0_30px_90px_rgba(0,0,0,.42)] sm:p-8"
      >
        <BrandwellLogo className="mx-auto h-[28px] w-auto" />
        <div className="mt-7 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#b786ff]">
            {BRANDWELL_BRAND.productName}
          </p>
          <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.03em]">
            Sign in with BrandWell
          </h1>
          <p className="mx-auto mt-2 max-w-[330px] text-[13.5px] leading-5 text-[#8c8e98]">
            Use your existing BrandWell account to access your AI employee, activity, and computer.
          </p>
        </div>

        <AuthField id="email" label="Email" icon={<Mail size={16} />}>
          <input
            ref={firstFieldRef}
            id="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            type="email"
            required
            className="w-full bg-transparent text-[15px] text-[#f7f7fa] outline-none placeholder:text-[#5f616b]"
          />
        </AuthField>

        <AuthField id="current-password" label="Password" icon={<LockKeyhole size={16} />}>
          <input
            id="current-password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            type={showPassword ? "text" : "password"}
            required
            minLength={8}
            className="w-full bg-transparent text-[15px] text-[#f7f7fa] outline-none placeholder:text-[#5f616b]"
          />
          <button
            type="button"
            onClick={() => setShowPassword((current) => !current)}
            className="text-[#777984] hover:text-white"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </AuthField>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-xl border border-[#5b2b38] bg-[#28161c] px-3 py-2.5 text-[13px] text-[#ff9cab]"
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="mt-5 w-full rounded-xl bg-[#ed168c] py-3.5 text-center text-[15px] font-semibold text-white shadow-[0_10px_28px_rgba(237,22,140,.18)] hover:bg-[#ff279d] disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "Signing in..." : "Sign in"}
        </button>

        <p className="mt-6 text-center text-[13.5px] text-[#858792]">
          Need access? Ask your BrandWell account administrator to assign an AIMEE master or paid
          Sidekick seat to your user.
        </p>
        <p className="mt-7 text-center text-[11.5px] leading-5 text-[#62646e]">
          By continuing, you agree to the{" "}
          <a className="hover:text-[#a6a7b1]" href={BRANDWELL_BRAND.termsUrl}>
            Terms of Service
          </a>{" "}
          and{" "}
          <a className="hover:text-[#a6a7b1]" href={BRANDWELL_BRAND.privacyUrl}>
            Privacy Policy
          </a>
          .
        </p>
      </form>
    </div>
  );
}

function AuthField({
  id,
  label,
  icon,
  children,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 block text-[12.5px] font-medium text-[#a6a7b1]">
      <label htmlFor={id}>{label}</label>
      <span className="mt-2 flex items-center gap-3 rounded-xl border border-[#353740] bg-[#1d1e24] px-3.5 py-3.5 focus-within:border-[#9f62ff] focus-within:ring-2 focus-within:ring-[#6f1cff]/20">
        <span className="text-[#777984]">{icon}</span>
        {children}
      </span>
    </div>
  );
}
