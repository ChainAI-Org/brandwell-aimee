import { BRANDWELL_BRAND, brandwellOutreachNotificationUrl } from "@brandwell/aimee/brand-config";
import type {
  BrandwellClientNotification,
  ComputerStatus,
  Routine,
  RunActivityRow,
} from "@rakazo/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  activityStatusLabel,
  fetchWorkspaceActivity,
  formatActivityRelativeTime,
} from "../lib/activity";
import type { MobileBot, MobileMe } from "../lib/api";
import { rpc } from "../lib/api";
import { NativeSymbol } from "./native-symbol";

type ManagedPanel = "home" | "activity";
type ManagedIcon = {
  ios: string;
  android: Parameters<typeof NativeSymbol>[0]["android"];
};

export function BrandwellHome({ me, bots }: { me: MobileMe; bots: MobileBot[] }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<ManagedPanel>("home");
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [notifications, setNotifications] = useState<BrandwellClientNotification[]>([]);
  const [activity, setActivity] = useState<{ active: RunActivityRow[]; recent: RunActivityRow[] }>({
    active: [],
    recent: [],
  });
  const [refreshing, setRefreshing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bot = useMemo(() => {
    const primaryId = me.brandwell?.primaryBotId;
    return (
      bots.find((candidate) => candidate.id === primaryId) ??
      bots.find((candidate) => candidate.managedByBrandWell) ??
      bots[0] ??
      null
    );
  }, [bots, me.brandwell?.primaryBotId]);

  const load = useCallback(async () => {
    if (!bot) {
      setReady(true);
      return;
    }
    setError(null);
    try {
      const [nextRoutines, nextComputer, nextActivity, nextNotifications] = await Promise.all([
        rpc<Routine[]>("routines/list", { botId: bot.id }),
        rpc<ComputerStatus>("computer/status", { botId: bot.id }).catch(() => null),
        fetchWorkspaceActivity(),
        rpc<BrandwellClientNotification[]>("notifications/list", { includeResolved: false }),
      ]);
      setRoutines(nextRoutines);
      setComputer(nextComputer);
      setActivity(nextActivity);
      setNotifications(nextNotifications);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AIMEE could not refresh right now.");
    } finally {
      setReady(true);
    }
  }, [bot]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const nextRoutine = routines
    .filter((routine) => routine.active && routine.nextRunAt)
    .sort((left, right) => String(left.nextRunAt).localeCompare(String(right.nextRunAt)))[0];
  const attentionRuns = activity.active.filter((run) =>
    ["waiting_input", "waiting_takeover", "failed"].includes(run.status),
  );
  const attentionCount =
    notifications.filter((notice) => notice.requiresAction).length + attentionRuns.length;
  const completedToday = activity.recent.filter(
    (run) => run.status === "completed" && isToday(run.updatedAt),
  ).length;

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={BRANDWELL_BRAND.colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 14) }]}>
      <View style={styles.header}>
        <Image
          accessibilityLabel="BrandWell"
          resizeMode="contain"
          source={require("../assets/brandwell-wordmark.png")}
          style={styles.logo}
        />
        <Pressable
          accessibilityLabel="Account settings"
          accessibilityRole="button"
          onPress={() => router.push("/account")}
          style={styles.accountButton}
        >
          <Text style={styles.accountInitials}>{initials(me.name)}</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={BRANDWELL_BRAND.colors.muted}
          />
        }
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!bot ? (
          <View style={styles.heroCard}>
            <Text style={styles.eyebrow}>SETTING UP AIMEE</Text>
            <Text style={styles.heroTitle}>Your AI employee is being prepared.</Text>
            <Text style={styles.heroCopy}>
              BrandWell is finishing your workspace, computer, routines, and connections.
            </Text>
          </View>
        ) : panel === "activity" ? (
          <ActivityPanel activity={activity} onOpen={(run) => openRun(router, run)} />
        ) : (
          <>
            <View style={styles.heroCard}>
              <View style={styles.heroTopRow}>
                <View style={styles.heroIdentity}>
                  <View style={styles.employeeMark}>
                    <Text style={styles.employeeMarkText}>A</Text>
                  </View>
                  <View style={styles.grow}>
                    <Text style={styles.eyebrow}>YOUR AI GTM EMPLOYEE</Text>
                    <Text style={styles.heroTitle}>{bot.name || "AIMEE"}</Text>
                  </View>
                </View>
                <StatusPill label={employeeStatus(activity, bot.managedStatus)} />
              </View>
              <Text style={styles.heroCopy}>
                Chat with AIMEE, review completed work, or open the computer when a login or
                approval needs you.
              </Text>
              <View style={styles.heroActions}>
                <PrimaryAction
                  icon={{ ios: "message.fill", android: "chatbubble" }}
                  label="Chat"
                  onPress={() =>
                    router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } })
                  }
                />
                <SecondaryAction
                  icon={{ ios: "rectangle.on.rectangle", android: "desktop-outline" }}
                  label="View computer"
                  onPress={() =>
                    router.push({
                      pathname: "/computer",
                      params: { botId: bot.id, name: bot.name },
                    })
                  }
                />
              </View>
            </View>

            <View style={styles.metricsRow}>
              <MetricCard
                label="Next scheduled task"
                value={nextRoutine ? formatFutureTime(nextRoutine.nextRunAt) : "No active routine"}
                detail={nextRoutine?.name ?? "Add or enable a routine in Settings"}
              />
              <MetricCard
                label="Completed today"
                value={String(completedToday)}
                detail={completedToday === 1 ? "successful run" : "successful runs"}
              />
            </View>

            <View style={styles.sectionCard}>
              <SectionHeader
                title="Needs attention"
                action={attentionCount ? `${attentionCount}` : "All clear"}
              />
              {notifications.map((notice) => (
                <ClientNotificationRow
                  key={notice.id}
                  notice={notice}
                  onPress={() => void openClientNotification(router, notice, bot.id)}
                />
              ))}
              {attentionRuns.length ? (
                attentionRuns
                  .slice(0, 3)
                  .map((run) => (
                    <ActivityRow key={run.runId} run={run} onPress={() => openRun(router, run)} />
                  ))
              ) : notifications.length === 0 ? (
                <Text style={styles.emptyCopy}>
                  AIMEE does not need anything from you right now.
                </Text>
              ) : null}
            </View>

            <View style={styles.sectionCard}>
              <SectionHeader title="Recent work" action={`${activity.recent.length}`} />
              {activity.recent.length ? (
                activity.recent
                  .slice(0, 5)
                  .map((run) => (
                    <ActivityRow key={run.runId} run={run} onPress={() => openRun(router, run)} />
                  ))
              ) : (
                <Text style={styles.emptyCopy}>Completed work will appear here.</Text>
              )}
            </View>

            <View style={styles.sectionCard}>
              <SectionHeader
                title="Routines"
                action={`${routines.filter((item) => item.active).length} active`}
              />
              {routines.slice(0, 4).map((routine) => (
                <Pressable
                  accessibilityRole="button"
                  key={routine.id}
                  onPress={() =>
                    router.push({
                      pathname: "/routine",
                      params: { routineId: routine.id, botId: bot.id },
                    })
                  }
                  style={styles.listRow}
                >
                  <View style={[styles.statusDot, !routine.active && styles.statusDotMuted]} />
                  <View style={styles.grow}>
                    <Text style={styles.rowTitle}>{routine.name}</Text>
                    <Text style={styles.rowMeta}>
                      {routine.active ? formatFutureTime(routine.nextRunAt) : "Paused"}
                    </Text>
                  </View>
                  <NativeSymbol
                    ios="chevron.right"
                    android="chevron-forward"
                    size={18}
                    color="#777985"
                  />
                </Pressable>
              ))}
            </View>

            <View style={styles.sectionCard}>
              <SectionHeader title="Computer" action={computerLabel(computer)} />
              <Text style={styles.emptyCopy}>{computerDescription(computer)}</Text>
            </View>
          </>
        )}
      </ScrollView>

      {bot ? (
        <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <TabButton
            active={panel === "home"}
            icon={{ ios: "house.fill", android: "home" }}
            label="Home"
            onPress={() => setPanel("home")}
          />
          <TabButton
            icon={{ ios: "message.fill", android: "chatbubble" }}
            label="Chat"
            onPress={() =>
              router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } })
            }
          />
          <TabButton
            active={panel === "activity"}
            icon={{ ios: "clock.fill", android: "time" }}
            label="Activity"
            onPress={() => setPanel("activity")}
          />
          <TabButton
            icon={{ ios: "rectangle.on.rectangle", android: "desktop-outline" }}
            label="Computer"
            onPress={() =>
              router.push({ pathname: "/computer", params: { botId: bot.id, name: bot.name } })
            }
          />
          <TabButton
            icon={{ ios: "gearshape.fill", android: "settings" }}
            label="Settings"
            onPress={() => router.push("/account")}
          />
        </View>
      ) : null}
    </View>
  );
}

function ActivityPanel({
  activity,
  onOpen,
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  onOpen: (run: RunActivityRow) => void;
}) {
  return (
    <>
      <View style={styles.pageHeading}>
        <Text style={styles.eyebrow}>AIMEE ACTIVITY</Text>
        <Text style={styles.pageTitle}>What AIMEE has been working on</Text>
        <Text style={styles.heroCopy}>Open any run to review the conversation and result.</Text>
      </View>
      <View style={styles.sectionCard}>
        <SectionHeader title="In progress" action={`${activity.active.length}`} />
        {activity.active.length ? (
          activity.active.map((run) => (
            <ActivityRow key={run.runId} run={run} onPress={() => onOpen(run)} />
          ))
        ) : (
          <Text style={styles.emptyCopy}>No work is running right now.</Text>
        )}
      </View>
      <View style={styles.sectionCard}>
        <SectionHeader title="Recent" action={`${activity.recent.length}`} />
        {activity.recent.length ? (
          activity.recent.map((run) => (
            <ActivityRow key={run.runId} run={run} onPress={() => onOpen(run)} />
          ))
        ) : (
          <Text style={styles.emptyCopy}>Completed work will appear here.</Text>
        )}
      </View>
    </>
  );
}

function ActivityRow({ run, onPress }: { run: RunActivityRow; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.listRow}>
      <View style={styles.activityIcon}>
        <NativeSymbol
          ios="sparkles"
          android="sparkles"
          size={17}
          color={BRANDWELL_BRAND.colors.accent}
        />
      </View>
      <View style={styles.grow}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {run.promptSnippet || run.botName}
        </Text>
        <Text style={styles.rowMeta}>
          {activityStatusLabel(run.status)} · {formatActivityRelativeTime(run.updatedAt)}
        </Text>
      </View>
      <NativeSymbol ios="chevron.right" android="chevron-forward" size={18} color="#777985" />
    </Pressable>
  );
}

function ClientNotificationRow({
  notice,
  onPress,
}: {
  notice: BrandwellClientNotification;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.listRow}>
      <View style={styles.notificationIcon}>
        <NativeSymbol ios="exclamationmark" android="alert" size={17} color="#FFC46B" />
      </View>
      <View style={styles.grow}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {notice.title}
        </Text>
        <Text numberOfLines={2} style={styles.notificationCopy}>
          {notice.body}
        </Text>
      </View>
      <NativeSymbol ios="chevron.right" android="chevron-forward" size={18} color="#777985" />
    </Pressable>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text numberOfLines={2} style={styles.metricValue}>
        {value}
      </Text>
      <Text numberOfLines={2} style={styles.metricDetail}>
        {detail}
      </Text>
    </View>
  );
}

function SectionHeader({ title, action }: { title: string; action: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionAction}>{action}</Text>
    </View>
  );
}

function StatusPill({ label }: { label: string }) {
  return (
    <View style={styles.statusPill}>
      <View style={styles.statusDot} />
      <Text style={styles.statusPillText}>{label}</Text>
    </View>
  );
}

function PrimaryAction({
  icon,
  label,
  onPress,
}: {
  icon: ManagedIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.primaryAction}>
      <NativeSymbol {...icon} size={18} color="#FFFFFF" />
      <Text style={styles.primaryActionText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryAction({
  icon,
  label,
  onPress,
}: {
  icon: ManagedIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.secondaryAction}>
      <NativeSymbol {...icon} size={18} color={BRANDWELL_BRAND.colors.text} />
      <Text style={styles.secondaryActionText}>{label}</Text>
    </Pressable>
  );
}

function TabButton({
  active = false,
  icon,
  label,
  onPress,
}: {
  active?: boolean;
  icon: ManagedIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.tabButton}>
      <NativeSymbol
        {...icon}
        size={20}
        color={active ? BRANDWELL_BRAND.colors.accent : "#7E808B"}
      />
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function openRun(router: ReturnType<typeof useRouter>, run: RunActivityRow) {
  router.push({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
}

async function openClientNotification(
  router: ReturnType<typeof useRouter>,
  notice: BrandwellClientNotification,
  fallbackBotId: string,
) {
  if (!notice.readAt) {
    await rpc<BrandwellClientNotification>("notifications/markRead", {
      notificationId: notice.id,
    }).catch(() => undefined);
  }
  const botId = notice.botId || fallbackBotId;
  const target = notice.actionTarget || "";
  const outreachUrl = brandwellOutreachNotificationUrl(target);
  if (outreachUrl) {
    await Linking.openURL(outreachUrl);
    return;
  }
  if (target.startsWith("/computer")) {
    router.push({ pathname: "/computer", params: { botId } });
    return;
  }
  if (target.startsWith("/integrations")) {
    router.push("/integrations");
    return;
  }
  router.push({ pathname: "/thread", params: { botId } });
}

function employeeStatus(
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] },
  managedStatus: string,
) {
  if (activity.active.some((run) => run.status === "waiting_takeover")) return "Needs you";
  if (activity.active.some((run) => run.status === "waiting_input")) return "Needs input";
  if (activity.active.some((run) => run.status === "running" || run.status === "leased")) {
    return "Working";
  }
  if (managedStatus === "paused") return "Paused";
  if (managedStatus === "error") return "Needs help";
  return "Working normally";
}

function computerLabel(computer: ComputerStatus | null) {
  if (!computer) return "Unavailable";
  if (computer.state === "suspended") return "Sleeping";
  if (computer.state === "running" && computer.controlActorName) {
    return `Controlled by ${computer.controlActorName}`;
  }
  if (computer.state === "running") return "Running";
  if (computer.state === "booting") return "Booting";
  if (computer.state === "error") return "Needs help";
  return "Stopped";
}

function computerDescription(computer: ComputerStatus | null) {
  if (!computer) return "Computer status will appear after provisioning is complete.";
  if (computer.state === "suspended" && computer.lastScreenshotAt) {
    return `Computer currently asleep. Last computer view ${formatActivityRelativeTime(computer.lastScreenshotAt)}.`;
  }
  if (computer.state === "suspended") {
    return "Computer currently asleep. It will wake automatically when AIMEE needs it.";
  }
  if (computer.state === "running" && computer.controlActorName) {
    return `${computer.controlActorName} currently has control.`;
  }
  if (computer.state === "running") return "The live computer is available to preview or control.";
  if (computer.state === "booting") return "AIMEE's computer is waking up.";
  if (computer.state === "error") return "BrandWell has been notified about a computer issue.";
  return "The computer will wake automatically when AIMEE needs it.";
}

function formatFutureTime(value: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Scheduled";
  return date.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isToday(value: string) {
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "B") + (parts[1]?.[0] ?? "");
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BRANDWELL_BRAND.colors.background },
  centered: { justifyContent: "center", alignItems: "center" },
  header: {
    minHeight: 58,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#24252C",
  },
  logo: { width: 142, height: 32 },
  accountButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#262730",
  },
  accountInitials: { color: BRANDWELL_BRAND.colors.text, fontSize: 12, fontWeight: "800" },
  content: { padding: 16, paddingBottom: 34, gap: 14 },
  error: { color: "#FF7A8F", fontSize: 14, lineHeight: 20 },
  heroCard: {
    padding: 20,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#343540",
    backgroundColor: BRANDWELL_BRAND.colors.surface,
    gap: 16,
  },
  heroTopRow: { gap: 14 },
  heroIdentity: { flexDirection: "row", alignItems: "center", gap: 12 },
  employeeMark: {
    width: 48,
    height: 48,
    borderRadius: 15,
    backgroundColor: BRANDWELL_BRAND.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  employeeMarkText: { color: "#FFFFFF", fontSize: 24, fontWeight: "900" },
  grow: { flex: 1, minWidth: 0 },
  eyebrow: {
    color: BRANDWELL_BRAND.colors.accent,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.35,
  },
  heroTitle: { color: BRANDWELL_BRAND.colors.text, fontSize: 28, fontWeight: "800", marginTop: 4 },
  heroCopy: { color: BRANDWELL_BRAND.colors.muted, fontSize: 15, lineHeight: 22 },
  statusPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 999,
    backgroundColor: "#25262E",
    paddingHorizontal: 11,
    minHeight: 30,
  },
  statusPillText: { color: "#D9DAE2", fontSize: 12, fontWeight: "700" },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#3DDC97" },
  statusDotMuted: { backgroundColor: "#646671" },
  heroActions: { flexDirection: "row", gap: 10 },
  primaryAction: {
    minHeight: 48,
    flex: 1,
    borderRadius: 14,
    backgroundColor: BRANDWELL_BRAND.colors.accent,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryActionText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  secondaryAction: {
    minHeight: 48,
    flex: 1.25,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#3A3B45",
    backgroundColor: "#24252C",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  secondaryActionText: { color: BRANDWELL_BRAND.colors.text, fontSize: 15, fontWeight: "700" },
  metricsRow: { flexDirection: "row", gap: 12 },
  metricCard: {
    flex: 1,
    minHeight: 138,
    padding: 16,
    borderRadius: 18,
    backgroundColor: BRANDWELL_BRAND.colors.surface,
    borderWidth: 1,
    borderColor: "#2D2E36",
  },
  metricLabel: { color: BRANDWELL_BRAND.colors.muted, fontSize: 12, fontWeight: "700" },
  metricValue: {
    color: BRANDWELL_BRAND.colors.text,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 14,
  },
  metricDetail: { color: "#858792", fontSize: 12, lineHeight: 17, marginTop: 7 },
  sectionCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#2D2E36",
    backgroundColor: BRANDWELL_BRAND.colors.surface,
    padding: 16,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionTitle: { color: BRANDWELL_BRAND.colors.text, fontSize: 17, fontWeight: "800" },
  sectionAction: { color: BRANDWELL_BRAND.colors.muted, fontSize: 12, fontWeight: "700" },
  emptyCopy: {
    color: BRANDWELL_BRAND.colors.muted,
    fontSize: 14,
    lineHeight: 21,
    paddingVertical: 10,
  },
  listRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderTopWidth: 1,
    borderTopColor: "#2B2C34",
    paddingVertical: 11,
  },
  activityIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: "#2A1C35",
    alignItems: "center",
    justifyContent: "center",
  },
  notificationIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: "#3A2B19",
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: BRANDWELL_BRAND.colors.text, fontSize: 14, fontWeight: "700" },
  rowMeta: { color: BRANDWELL_BRAND.colors.muted, fontSize: 12, marginTop: 4 },
  notificationCopy: {
    color: BRANDWELL_BRAND.colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  pageHeading: { padding: 4, gap: 8, marginBottom: 2 },
  pageTitle: { color: BRANDWELL_BRAND.colors.text, fontSize: 28, fontWeight: "800" },
  tabBar: {
    minHeight: 66,
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#292A31",
    backgroundColor: "#15161A",
    paddingTop: 8,
  },
  tabButton: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  tabLabel: { color: "#7E808B", fontSize: 10, fontWeight: "700" },
  tabLabelActive: { color: BRANDWELL_BRAND.colors.accent },
});
