import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import { ArrowLeft, Eye, EyeOff, LockKeyhole, Mail, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BrandwellLogo } from "../components/brandwell/BrandwellLogo";
import { authClient } from "../lib/auth";

export function AuthPage({ mode }: { mode: "in" | "up" }) {
  const navigate = useNavigate();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [mode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result =
      mode === "up"
        ? await authClient.signUp.email({
            email,
            password,
            name: name || email.split("@")[0] || "User",
          })
        : await authClient.signIn.email({ email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not continue");
      return;
    }
    navigate(mode === "up" ? "/onboarding" : "/app");
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
            {mode === "in" ? "Sign in to your account" : "Activate your AIMEE access"}
          </h1>
          <p className="mx-auto mt-2 max-w-[330px] text-[13.5px] leading-5 text-[#8c8e98]">
            {mode === "in"
              ? "Continue to your AI employee, activity, routines, and computer."
              : "Use the email address where BrandWell sent your invitation."}
          </p>
        </div>

        {mode === "up" ? (
          <AuthField id="name" label="Name" icon={<UserRound size={16} />}>
            <input
              ref={firstFieldRef}
              id="name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              className="w-full bg-transparent text-[15px] text-[#f7f7fa] outline-none placeholder:text-[#5f616b]"
            />
          </AuthField>
        ) : null}

        <AuthField id="email" label="Email" icon={<Mail size={16} />}>
          <input
            ref={mode === "in" ? firstFieldRef : undefined}
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

        <AuthField
          id={mode === "in" ? "current-password" : "new-password"}
          label="Password"
          icon={<LockKeyhole size={16} />}
        >
          <input
            id={mode === "in" ? "current-password" : "new-password"}
            name="password"
            autoComplete={mode === "in" ? "current-password" : "new-password"}
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
          {pending ? "Working..." : mode === "in" ? "Sign in" : "Create access"}
        </button>

        <p className="mt-6 text-center text-[13.5px] text-[#858792]">
          {mode === "in" ? (
            <>
              Have an invitation?{" "}
              <Link to="/sign-up" className="font-medium text-[#cfb1ff] hover:text-white">
                Activate access
              </Link>
            </>
          ) : (
            <>
              Already activated?{" "}
              <Link to="/sign-in" className="font-medium text-[#cfb1ff] hover:text-white">
                Sign in
              </Link>
            </>
          )}
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
