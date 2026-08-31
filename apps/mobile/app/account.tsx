import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import type { AvatarStyle } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAvatarStyle } from "../components/avatar-style";
import { BotAvatar } from "../components/bot-avatar";
import { NativeSymbol } from "../components/native-symbol";
import type { MobileBot } from "../lib/api";
import { type MobileMe, rpc, signOut } from "../lib/api";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { native } from "../lib/native";

export default function Account() {
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [pending, setPending] = useState(false);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [archivedBots, setArchivedBots] = useState<MobileBot[]>([]);
  const [usage, setUsage] = useState<{
    runs: number;
    inputTokens: number;
    outputTokens: number;
  } | null>(null);
  const { avatarStyle, updateAvatarStyle } = useAvatarStyle();

  useEffect(() => {
    void rpc<MobileMe>("me")
      .then(setMe)
      .catch(() => undefined);
    void rpc<MobileBot[]>("bots/listArchived")
      .then(setArchivedBots)
      .catch(() => undefined);
    void rpc<{ runs: number; inputTokens: number; outputTokens: number }>("usage/summary")
      .then(setUsage)
      .catch(() => undefined);
  }, []);

  const usageBlock = (
    <View accessibilityLabel="Usage" style={styles.profile}>
      <Text style={styles.settingsTitle}>Usage</Text>
      {usage ? (
        <Text style={styles.email}>
          {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
        </Text>
      ) : null}
      <Text style={styles.settingsExplanation}>Model spend uses your provider keys.</Text>
    </View>
  );

  async function restoreBot(botId: string) {
    try {
      await rpc("bots/restore", { botId });
      setArchivedBots((bots) => bots.filter((bot) => bot.id !== botId));
    } catch (restoreError) {
      Alert.alert(
        "Could not restore bot",
        restoreError instanceof Error ? restoreError.message : "Try again.",
      );
    }
  }

  async function selectAvatarStyle(next: AvatarStyle) {
    if (next === avatarStyle) return;
    setAvatarPending(true);
    setAvatarError(null);
    try {
      await updateAvatarStyle(next);
    } catch {
      setAvatarError("Couldn't update avatars");
    } finally {
      setAvatarPending(false);
    }
  }

  async function handleSignOut() {
    setPending(true);
    await signOut();
    router.dismissAll();
    router.replace("/sign-in");
  }

  if (!me) {
    return (
      <View style={[styles.screen, styles.loading]}>
        <ActivityIndicator color={BRANDWELL_BRAND.colors.accent} />
      </View>
    );
  }

  if (me.brandwell) {
    const primaryBotId = me.brandwell.primaryBotId;
    return (
      <SafeAreaView edges={["bottom"]} style={styles.managedScreen}>
        <ScrollView contentContainerStyle={styles.managedContent}>
          <View style={styles.managedProfile}>
            <View style={styles.managedAvatar}>
              <Text style={styles.managedAvatarText}>{accountInitials(me.name)}</Text>
            </View>
            <View style={styles.managedProfileText}>
              <Text style={styles.managedName}>{me.name || "Your account"}</Text>
              <Text style={styles.managedEmail}>{me.email}</Text>
            </View>
          </View>

          <View style={styles.managedPlan}>
            <View style={styles.managedPlanTop}>
              <View>
                <Text style={styles.managedEyebrow}>BRANDWELL AIMEE</Text>
                <Text style={styles.managedPlanTitle}>{planLabel(me.brandwell.plan)}</Text>
              </View>
              <Text style={styles.managedPlanStatus}>
                {statusLabel(me.brandwell.subscriptionStatus)}
              </Text>
            </View>
            <Text style={styles.managedPlanCopy}>
              Your models, memory, routines, and computer are securely managed by BrandWell.
            </Text>
          </View>

          <Text style={styles.managedSectionLabel}>WORKSPACE</Text>
          <ManagedSettingRow
            icon={{ ios: "link", android: "link" }}
            title="Connected apps"
            detail="Connect email, calendar, CRM, and work apps"
            onPress={() => router.push("/integrations")}
          />
          {primaryBotId ? (
            <ManagedSettingRow
              icon={{ ios: "clock.arrow.circlepath", android: "time-outline" }}
              title="Routines"
              detail="Review AIMEE's recurring responsibilities"
              onPress={() =>
                router.push({ pathname: "/bot-settings", params: { botId: primaryBotId } })
              }
            />
          ) : null}
          <ManagedSettingRow
            icon={{ ios: "creditcard", android: "card-outline" }}
            title="Subscription and billing"
            detail="Manage your BrandWell account and invoices"
            onPress={() => void Linking.openURL(BRANDWELL_BRAND.portalUrl)}
          />
          <ManagedSettingRow
            icon={{ ios: "questionmark.circle", android: "help-circle-outline" }}
            title="BrandWell support"
            detail={BRANDWELL_BRAND.supportEmail}
            onPress={() => void Linking.openURL(`mailto:${BRANDWELL_BRAND.supportEmail}`)}
          />

          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => void handleSignOut()}
            style={({ pressed }) => [styles.managedSignOut, pressed && styles.pressed]}
          >
            <NativeSymbol
              ios="rectangle.portrait.and.arrow.right"
              android="log-out-outline"
              size={18}
              color={BRANDWELL_BRAND.colors.text}
            />
            <Text style={styles.managedSignOutText}>{pending ? "Signing out..." : "Sign out"}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {focus === "usage" ? usageBlock : null}
        <View style={styles.profile}>
          <Text style={styles.name}>{me?.name || "Your account"}</Text>
          {me?.email ? <Text style={styles.email}>{me.email}</Text> : null}
        </View>
        {focus !== "usage" ? usageBlock : null}

        <View accessibilityLabel="Avatar style" style={styles.avatarSection}>
          <Text style={styles.settingsTitle}>Avatars</Text>
          <View style={styles.avatarOptions}>
            {(["robot", "organic"] as const).map((style) => {
              const selected = avatarStyle === style;
              return (
                <Pressable
                  key={style}
                  accessibilityLabel={`${style === "robot" ? "Robot" : "Organic"} avatars`}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: avatarPending }}
                  disabled={avatarPending}
                  onPress={() => void selectAvatarStyle(style)}
                  style={({ pressed }) => [
                    styles.avatarOption,
                    selected && styles.avatarOptionSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <BotAvatar
                    color={style === "robot" ? "#8B5CF6" : "#D62F8B"}
                    identity="avatar-preview"
                    size={42}
                    variant={style}
                  />
                  <Text style={styles.avatarLabel}>{style === "robot" ? "Robot" : "Organic"}</Text>
                </Pressable>
              );
            })}
          </View>
          {avatarError ? <Text style={styles.error}>{avatarError}</Text> : null}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/models")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Models</Text>
            <Text style={styles.settingsExplanation}>Choose your provider and active model</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/voice")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Voice</Text>
            <Text style={styles.settingsExplanation}>
              Speak replies aloud with ElevenLabs, OpenAI, or Cartesia
            </Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/integrations")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Integrations</Text>
            <Text style={styles.settingsExplanation}>Connect apps.</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void handleSignOut()}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonLabel}>Sign out</Text>
        </Pressable>

        {archivedBots.length > 0 ? (
          <View style={styles.archivedSection}>
            <Text style={styles.sectionTitle}>Archived bots</Text>
            {archivedBots.map((bot) => (
              <View key={bot.id} style={styles.archivedRow}>
                <Text numberOfLines={1} style={styles.archivedName}>
                  {bot.name}
                </Text>
                <Pressable onPress={() => void restoreBot(bot.id)} hitSlop={8}>
                  <Text style={styles.restoreLabel}>Restore</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    confirmDeleteBot(bot, () =>
                      setArchivedBots((bots) => bots.filter((item) => item.id !== bot.id)),
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={styles.archivedDeleteLabel}>Delete</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.dangerZone}>
          <Text style={styles.dangerTitle}>BrandWell account access</Text>
          <Text style={styles.explanation}>
            Your company administrator manages this user, AIMEE access, and paid Sidekick seats in
            BrandWell.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ManagedSettingRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: { ios: string; android: "link" | "time-outline" | "card-outline" | "help-circle-outline" };
  title: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.managedRow, pressed && styles.pressed]}
    >
      <View style={styles.managedRowIcon}>
        <NativeSymbol {...icon} size={19} color={BRANDWELL_BRAND.colors.accent} />
      </View>
      <View style={styles.managedProfileText}>
        <Text style={styles.managedRowTitle}>{title}</Text>
        <Text style={styles.managedRowDetail}>{detail}</Text>
      </View>
      <NativeSymbol ios="chevron.right" android="chevron-forward" size={18} color="#777985" />
    </Pressable>
  );
}

function accountInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "B"}${parts[1]?.[0] ?? ""}`;
}

function planLabel(plan: string) {
  if (plan.toLowerCase().includes("scale")) return "Scale plan";
  if (plan.toLowerCase().includes("grow")) return "Grow plan";
  if (plan.toLowerCase().includes("employee")) return "AI Employee plan";
  return plan || "Managed plan";
}

function statusLabel(status: string) {
  if (status === "active") return "Active";
  if (status === "canceling") return "Canceling";
  if (status === "canceled") return "Canceled";
  return status;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: native.page,
  },
  loading: { alignItems: "center", justifyContent: "center" },
  managedScreen: { flex: 1, backgroundColor: BRANDWELL_BRAND.colors.background },
  managedContent: { padding: 18, paddingBottom: 34, gap: 12 },
  managedProfile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    paddingVertical: 8,
    marginBottom: 4,
  },
  managedAvatar: {
    width: 50,
    height: 50,
    borderRadius: 16,
    backgroundColor: BRANDWELL_BRAND.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  managedAvatarText: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  managedProfileText: { flex: 1, minWidth: 0 },
  managedName: { color: BRANDWELL_BRAND.colors.text, fontSize: 21, fontWeight: "800" },
  managedEmail: { color: BRANDWELL_BRAND.colors.muted, fontSize: 14, marginTop: 4 },
  managedPlan: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#343540",
    backgroundColor: BRANDWELL_BRAND.colors.surface,
    padding: 18,
    gap: 13,
    marginBottom: 8,
  },
  managedPlanTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  managedEyebrow: {
    color: BRANDWELL_BRAND.colors.accent,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.25,
  },
  managedPlanTitle: {
    color: BRANDWELL_BRAND.colors.text,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 5,
  },
  managedPlanStatus: { color: "#56D8A2", fontSize: 12, fontWeight: "800", marginTop: 2 },
  managedPlanCopy: { color: BRANDWELL_BRAND.colors.muted, fontSize: 14, lineHeight: 21 },
  managedSectionLabel: {
    color: "#777985",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginTop: 8,
    marginBottom: 2,
  },
  managedRow: {
    minHeight: 70,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#2D2E36",
    backgroundColor: BRANDWELL_BRAND.colors.surface,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  managedRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: "#2A1C35",
    alignItems: "center",
    justifyContent: "center",
  },
  managedRowTitle: { color: BRANDWELL_BRAND.colors.text, fontSize: 15, fontWeight: "700" },
  managedRowDetail: {
    color: BRANDWELL_BRAND.colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  managedSignOut: {
    minHeight: 52,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "#3A3B45",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 10,
  },
  managedSignOutText: { color: BRANDWELL_BRAND.colors.text, fontSize: 15, fontWeight: "700" },
  content: {
    flexGrow: 1,
    padding: 20,
    gap: 20,
  },
  profile: {
    borderRadius: 16,
    backgroundColor: native.fill,
    padding: 18,
    gap: 4,
  },
  name: {
    color: native.label,
    fontSize: 20,
    fontWeight: "600",
  },
  email: {
    color: native.secondaryLabel,
    fontSize: 15,
  },
  button: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: native.fill,
  },
  buttonLabel: {
    color: native.label,
    fontSize: 17,
    fontWeight: "600",
  },
  archivedSection: {
    borderRadius: 16,
    backgroundColor: native.fill,
    padding: 18,
    gap: 14,
  },
  sectionTitle: {
    color: native.secondaryLabel,
    fontSize: 14,
    fontWeight: "600",
  },
  archivedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  archivedName: {
    flex: 1,
    color: native.label,
    fontSize: 16,
  },
  restoreLabel: {
    color: native.label,
    fontSize: 14,
    fontWeight: "600",
  },
  archivedDeleteLabel: {
    color: "#FF6961",
    fontSize: 14,
  },
  settingsButton: {
    minHeight: 62,
    borderRadius: 14,
    backgroundColor: native.fill,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  avatarSection: {
    borderRadius: 16,
    backgroundColor: native.fill,
    padding: 18,
    gap: 14,
  },
  avatarOptions: {
    flexDirection: "row",
    gap: 12,
  },
  avatarOption: {
    flex: 1,
    minHeight: 86,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: native.tertiaryLabel,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  avatarOptionSelected: {
    borderColor: native.label,
    backgroundColor: native.fillPressed,
  },
  avatarLabel: {
    color: native.label,
    fontSize: 14,
    fontWeight: "600",
  },
  settingsTitle: {
    color: native.label,
    fontSize: 17,
    fontWeight: "600",
  },
  settingsExplanation: {
    color: native.secondaryLabel,
    fontSize: 13,
    marginTop: 3,
  },
  chevron: {
    color: native.secondaryLabel,
    fontSize: 28,
    fontWeight: "300",
  },
  dangerZone: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#5A2426",
    padding: 18,
  },
  dangerTitle: {
    color: "#FF6961",
    fontSize: 17,
    fontWeight: "600",
  },
  explanation: {
    color: native.secondaryLabel,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  password: {
    height: 48,
    borderRadius: 12,
    backgroundColor: native.fill,
    color: native.label,
    paddingHorizontal: 14,
    marginTop: 16,
    fontSize: 16,
  },
  error: {
    color: "#FF6961",
    fontSize: 14,
    marginTop: 10,
  },
  deleteButton: {
    minHeight: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#C9363E",
    marginTop: 14,
  },
  deleteLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
});
