import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import type {
  Bot,
  BrandwellClientNotification,
  ComputerStatus,
  Me,
  Routine,
  RunActivityRow,
} from "@rakazo/contracts";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock3,
  Home,
  MessageSquare,
  Monitor,
  Plug,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BuiButton, BuiCard, LoadingState } from "../components/beautiful-ui/primitives";
import { BrandwellLogo } from "../components/brandwell/BrandwellLogo";
import { rpc } from "../lib/rpc";
import { ShellPage } from "./Shell";

type ManagedHomeState = {
  bot: Bot;
  computer: ComputerStatus | null;
  routines: Routine[];
  activeRuns: RunActivityRow[];
  recentRuns: RunActivityRow[];
  notifications: BrandwellClientNotification[];
};

export function WorkspaceHomePage() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void rpc
      .me()
      .then((next) => {
        if (active) setMe(next);
      })
      .catch(() => {
        if (active) setMe(null);
      });
    return () => {
      active = false;
    };
  }, []);

  if (me === undefined) {
    return (
      <div className="grid h-full place-items-center bg-[#101114] text-[#f7f7fa]">
        <LoadingState label="Opening AIMEE" />
      </div>
    );
  }
  if (!me?.brandwell) return <ShellPage />;
  return <BrandwellHome me={me} />;
}

function BrandwellHome({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [state, setState] = useState<ManagedHomeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      const bots = await rpc.bots.list();
      const bot =
        bots.find((candidate) => candidate.id === me.brandwell?.primaryBotId) ??
        bots.find((candidate) => candidate.managedByBrandWell);
      if (!bot) throw new Error("AIMEE is still being provisioned for this workspace.");
      const [computer, routines, activeResult, recentResult, notifications] = await Promise.all([
        rpc.computer.status({ botId: bot.id }).catch(() => null),
        rpc.routines.list({ botId: bot.id }),
        rpc.runs.list({ filter: "active" }),
        rpc.runs.list({ filter: "recent" }),
        rpc.notifications.list({ includeResolved: false }),
      ]);
      if (!active) return;
      setState({
        bot,
        computer,
        routines,
        activeRuns: activeResult.runs.filter((run) => run.botId === bot.id),
        recentRuns: recentResult.runs.filter((run) => run.botId === bot.id),
        notifications,
      });
      setError(null);
    }
    void load().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load AIMEE.");
    });
    return () => {
      active = false;
    };
  }, [me.brandwell?.primaryBotId]);

  const nextRoutine = useMemo(
    () =>
      state?.routines
        .filter((routine) => routine.active && routine.nextRunAt)
        .sort((left, right) => String(left.nextRunAt).localeCompare(String(right.nextRunAt)))[0] ??
      null,
    [state?.routines],
  );
  const needsAttention =
    (state?.notifications.some((notice) => notice.requiresAction && !notice.resolvedAt) ?? false) ||
    (state?.activeRuns.some((run) =>
      ["waiting_input", "waiting_takeover", "failed"].includes(run.status),
    ) ??
      false);

  const open = (view?: "computer" | "integrations" | "account" | "routines") => {
    if (!state) return;
    const query = view ? `?view=${view}` : "";
    navigate(`/app/${state.bot.id}${query}`);
  };

  const openNotice = async (notice: BrandwellClientNotification) => {
    if (!state) return;
    if (!notice.readAt) {
      await rpc.notifications.markRead({ notificationId: notice.id }).catch(() => undefined);
    }
    navigate(brandwellNotificationDestination(notice, state.bot.id));
  };

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-[#101114] text-[#f7f7fa]">
      <aside className="hidden w-[248px] shrink-0 flex-col border-e border-[#282a31] bg-[#15161a] md:flex">
        <div className="border-b border-[#282a31] px-5 py-5">
          <BrandwellLogo className="h-[27px] w-auto" />
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#a6a7b1]">
            {BRANDWELL_BRAND.productName}
          </p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="AIMEE navigation">
          <HomeNavItem icon={<Home size={17} />} label="Home" active onClick={() => undefined} />
          <HomeNavItem icon={<MessageSquare size={17} />} label="Chat" onClick={() => open()} />
          <HomeNavItem
            icon={<Activity size={17} />}
            label="Activity"
            onClick={() => document.getElementById("aimee-activity")?.scrollIntoView()}
          />
          <HomeNavItem
            icon={<Monitor size={17} />}
            label="Computer"
            onClick={() => open("computer")}
          />
          <HomeNavItem
            icon={<Plug size={17} />}
            label="Connections"
            onClick={() => open("integrations")}
          />
          <HomeNavItem
            icon={<Settings size={17} />}
            label="Settings"
            onClick={() => open("account")}
          />
        </nav>
        <div className="border-t border-[#282a31] px-5 py-4 text-[12px] text-[#777984]">
          {me.email}
        </div>
      </aside>

      <main className="rk-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-5 py-8 md:px-10 md:py-10">
          <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <div className="md:hidden">
                <BrandwellLogo className="mb-5 h-[26px] w-auto" />
              </div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#b786ff]">
                Your AI GTM Employee
              </p>
              <h1 className="mt-2 text-[34px] font-semibold tracking-[-0.035em] md:text-[46px]">
                {state?.bot.name ?? "AIMEE"}
              </h1>
              <p className="mt-2 max-w-[660px] text-[15px] leading-6 text-[#a6a7b1]">
                Talk to AIMEE, review scheduled work, and step into the computer only when a login
                or approval needs you.
              </p>
            </div>
            <div className="flex gap-2.5">
              <BuiButton onClick={() => open("computer")}>View computer</BuiButton>
              <BuiButton tone="accent" onClick={() => open()}>
                Chat with AIMEE
              </BuiButton>
            </div>
          </header>

          {error ? (
            <BuiCard className="mt-7 border border-[#5b2b38] p-5 text-[14px] text-[#ff9cab]">
              {error}
            </BuiCard>
          ) : null}

          {!state ? (
            <div className="mt-10">
              <LoadingState label="Loading workspace" />
            </div>
          ) : (
            <>
              <section className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  label="Employee status"
                  value={needsAttention ? "Needs you" : statusLabel(state.bot.status)}
                  detail={needsAttention ? "A run is waiting for input" : "Operating normally"}
                  icon={needsAttention ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                  tone={needsAttention ? "warning" : "good"}
                />
                <MetricCard
                  label="Computer"
                  value={computerStateLabel(state.computer?.state)}
                  detail={computerDetail(state.computer)}
                  icon={<Monitor size={18} />}
                />
                <MetricCard
                  label="Next routine"
                  value={nextRoutine?.name ?? "Nothing scheduled"}
                  detail={
                    nextRoutine?.nextRunAt ? formatDate(nextRoutine.nextRunAt) : "Add a routine"
                  }
                  icon={<Clock3 size={18} />}
                />
                <MetricCard
                  label="Recent work"
                  value={`${state.recentRuns.length} run${state.recentRuns.length === 1 ? "" : "s"}`}
                  detail="Latest completed activity"
                  icon={<Activity size={18} />}
                />
              </section>

              {state.notifications.length ? (
                <BuiCard className="mt-6 border border-[#4d3b24] p-5 md:p-6">
                  <SectionHeading
                    title="Needs attention"
                    detail="AIMEE will continue as soon as the requested login or approval is complete"
                  />
                  <div className="mt-4 grid gap-2 md:grid-cols-2">
                    {state.notifications.slice(0, 6).map((notice) => (
                      <button
                        type="button"
                        key={notice.id}
                        onClick={() => void openNotice(notice)}
                        className="rounded-xl border border-[#3a3530] bg-[#201d1a] px-4 py-3.5 text-start hover:border-[#6d5331]"
                      >
                        <span className="flex items-center justify-between gap-3">
                          <strong className="text-[14px] font-medium text-[#fff4e2]">
                            {notice.title}
                          </strong>
                          {notice.requiresAction ? (
                            <span className="shrink-0 rounded-full bg-[#5b421f] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#ffc66f]">
                              Action
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1.5 block text-[12.5px] leading-5 text-[#b9a990]">
                          {notice.body}
                        </span>
                      </button>
                    ))}
                  </div>
                </BuiCard>
              ) : null}

              <div className="mt-6 grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
                <BuiCard id="aimee-activity" className="p-5 md:p-6">
                  <SectionHeading
                    title="Activity"
                    detail="What AIMEE is doing and what finished recently"
                  />
                  <div className="mt-5 space-y-2">
                    {[...state.activeRuns, ...state.recentRuns].slice(0, 8).map((run) => (
                      <ActivityRow key={run.runId} run={run} onOpen={() => open()} />
                    ))}
                    {state.activeRuns.length === 0 && state.recentRuns.length === 0 ? (
                      <EmptyState text="AIMEE activity will appear here as routines and requests run." />
                    ) : null}
                  </div>
                </BuiCard>

                <BuiCard className="p-5 md:p-6">
                  <SectionHeading
                    title="Routines"
                    detail="Recurring work AIMEE runs for this workspace"
                  />
                  <div className="mt-5 space-y-2">
                    {state.routines.slice(0, 6).map((routine) => (
                      <button
                        type="button"
                        key={routine.id}
                        onClick={() => open("routines")}
                        className="flex w-full items-center gap-3 rounded-xl border border-[#30323a] bg-[#1d1e24] px-3.5 py-3 text-start hover:border-[#454853]"
                      >
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${routine.active ? "bg-[#44c47a]" : "bg-[#62646e]"}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium text-[#f7f7fa]">
                            {routine.name}
                          </span>
                          <span className="mt-0.5 block truncate text-[12px] text-[#8c8e98]">
                            {routine.nextRunAt ? formatDate(routine.nextRunAt) : "Paused"}
                          </span>
                        </span>
                      </button>
                    ))}
                    {state.routines.length === 0 ? (
                      <EmptyState text="No routines are configured yet." />
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => open("routines")}
                    className="mt-4 text-[13px] font-medium text-[#b786ff] hover:text-[#cfb1ff]"
                  >
                    Manage routines
                  </button>
                </BuiCard>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function HomeNavItem({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] transition ${
        active
          ? "bg-[#26212f] font-medium text-white"
          : "text-[#a6a7b1] hover:bg-[#1d1e23] hover:text-white"
      }`}
    >
      <span className={active ? "text-[#9f62ff]" : "text-[#777984]"}>{icon}</span>
      {label}
    </button>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  tone?: "neutral" | "good" | "warning";
}) {
  const color = tone === "good" ? "#44c47a" : tone === "warning" ? "#ffb34e" : "#b786ff";
  return (
    <BuiCard className="min-h-[145px] p-4.5">
      <div className="flex items-center justify-between text-[12px] font-medium uppercase tracking-[0.08em] text-[#858792]">
        <span>{label}</span>
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="mt-5 truncate text-[21px] font-semibold tracking-[-0.02em] text-[#f7f7fa]">
        {value}
      </div>
      <div className="mt-1.5 truncate text-[12.5px] text-[#8c8e98]">{detail}</div>
    </BuiCard>
  );
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <header>
      <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-[#f7f7fa]">{title}</h2>
      <p className="mt-1 text-[13px] text-[#8c8e98]">{detail}</p>
    </header>
  );
}

function ActivityRow({ run, onOpen }: { run: RunActivityRow; onOpen: () => void }) {
  const waiting = run.status === "waiting_input" || run.status === "waiting_takeover";
  const failed = run.status === "failed";
  const color = failed
    ? "#ff6b7b"
    : waiting
      ? "#ffb34e"
      : run.status === "completed"
        ? "#44c47a"
        : "#9f62ff";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-3 text-start hover:border-[#30323a] hover:bg-[#1d1e24]"
    >
      <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3">
          <span className="truncate text-[14px] font-medium text-[#f7f7fa]">
            {run.promptSnippet || run.botName}
          </span>
          <span className="shrink-0 text-[12px] text-[#777984]">{formatDate(run.updatedAt)}</span>
        </span>
        <span className="mt-1 block text-[12.5px] capitalize text-[#8c8e98]">
          {run.status.replaceAll("_", " ")}
        </span>
      </span>
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[#34363f] px-4 py-6 text-center text-[13px] text-[#777984]">
      {text}
    </div>
  );
}

function statusLabel(status: string) {
  if (status === "working" || status === "running") return "Working";
  if (status === "sleeping" || status === "suspended") return "Sleeping";
  if (status === "error" || status === "failed") return "Needs attention";
  if (status === "paused") return "Paused";
  return "Ready";
}

function computerStateLabel(state?: string) {
  if (state === "running") return "Running";
  if (state === "suspended") return "Sleeping";
  if (state === "booting") return "Waking up";
  if (state === "error") return "Needs attention";
  return "Stopped";
}

function computerDetail(computer: ComputerStatus | null) {
  if (!computer) return "Status unavailable";
  if (computer.state === "suspended" && computer.lastScreenshotAt) {
    return `Last active ${formatDate(computer.lastScreenshotAt)}`;
  }
  if (computer.controlActorName) return `Controlled by ${computer.controlActorName}`;
  return computer.state === "running" ? "Available for work" : "Wakes when needed";
}

function formatDate(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function brandwellNotificationDestination(
  notice: BrandwellClientNotification,
  fallbackBotId: string,
) {
  const botId = notice.botId || fallbackBotId;
  const target = notice.actionTarget || "";
  if (target.startsWith("/computer")) return `/app/${botId}?view=computer`;
  if (target.startsWith("/integrations")) return `/app/${botId}?view=integrations`;
  if (target.startsWith("/settings")) return `/app/${botId}?view=account`;
  return `/app/${botId}`;
}
