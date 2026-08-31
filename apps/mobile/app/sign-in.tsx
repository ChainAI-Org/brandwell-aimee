import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import { Redirect, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  allowsCustomApiBase,
  apiBaseWarning,
  currentApiBase,
  defaultApiBase,
  displayApiHost,
  loadSessionToken,
  normalizeApiBase,
  probeApiBase,
  resetApiBase,
  saveApiBase,
  signIn,
  usesCustomApiBase,
} from "../lib/api";

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [serverOpen, setServerOpen] = useState(false);
  const emailInput = useRef<TextInput>(null);

  useEffect(() => {
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (ready && !hasSession) {
      const timer = setTimeout(() => emailInput.current?.focus(), 250);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [hasSession, ready]);

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>Loading...</Text>
      </View>
    );
  }
  if (hasSession) return <Redirect href="/" />;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setPending(false);
    }
  }

  const custom = usesCustomApiBase(apiBase);
  const allowCustomServer = allowsCustomApiBase();

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.formWrap}>
          <Image
            accessibilityLabel="BrandWell"
            resizeMode="contain"
            source={require("../assets/brandwell-wordmark.png")}
            style={styles.logo}
          />
          <View style={styles.card}>
            <Text style={styles.eyebrow}>YOUR AI GTM EMPLOYEE</Text>
            <Text style={styles.heading}>Welcome back</Text>
            <Text style={styles.subheading}>
              Sign in to chat with AIMEE, review activity, and open your computer.
            </Text>
            <TextInput
              ref={emailInput}
              accessibilityLabel="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="you@company.com"
              placeholderTextColor="#747582"
              returnKeyType="next"
              value={email}
              onChangeText={setEmail}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel="Password"
              placeholder="Password"
              placeholderTextColor="#747582"
              returnKeyType="go"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => void submit()}
              style={styles.input}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable
              onPress={() => void submit()}
              disabled={pending || !email.trim() || !password}
              style={({ pressed }) => [
                styles.button,
                (pending || !email.trim() || !password) && styles.buttonDisabled,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.buttonText}>{pending ? "Signing in..." : "Sign in"}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
      {allowCustomServer ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            custom ? `Custom server ${displayApiHost(apiBase)}` : "Use a custom server"
          }
          hitSlop={12}
          onPress={() => setServerOpen(true)}
          style={styles.serverButton}
        >
          {custom ? (
            <>
              <Text style={styles.serverLabel}>Development server</Text>
              <Text style={styles.serverHost}>{displayApiHost(apiBase)}</Text>
            </>
          ) : (
            <Text style={styles.serverLabel}>Use a development server</Text>
          )}
        </Pressable>
      ) : null}
      <ServerSheet
        visible={serverOpen}
        current={apiBase}
        onClose={() => setServerOpen(false)}
        onSaved={(url) => {
          setApiBase(url);
          setServerOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BRANDWELL_BRAND.colors.background },
  centered: { justifyContent: "center", alignItems: "center" },
  keyboard: { flex: 1 },
  formWrap: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  logo: { width: 190, height: 44, alignSelf: "center", marginBottom: 28 },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#30313A",
    backgroundColor: BRANDWELL_BRAND.colors.surface,
    padding: 22,
    gap: 12,
  },
  eyebrow: {
    color: BRANDWELL_BRAND.colors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  heading: { color: BRANDWELL_BRAND.colors.text, fontSize: 30, fontWeight: "800" },
  subheading: {
    color: BRANDWELL_BRAND.colors.muted,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 8,
  },
  input: {
    minHeight: 54,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#343540",
    backgroundColor: "#121318",
    color: BRANDWELL_BRAND.colors.text,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  error: { color: "#FF7A8F", fontSize: 14, lineHeight: 20 },
  button: {
    minHeight: 54,
    borderRadius: 14,
    backgroundColor: BRANDWELL_BRAND.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.78 },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  muted: { color: BRANDWELL_BRAND.colors.muted, textAlign: "center" },
  serverButton: { alignItems: "center", paddingHorizontal: 24, paddingBottom: 12, paddingTop: 8 },
  serverLabel: { color: "#8B8C96", fontSize: 12 },
  serverHost: { color: "#686973", fontSize: 13, marginTop: 2 },
});

function ServerSheet({
  visible,
  current,
  onClose,
  onSaved,
}: {
  visible: boolean;
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft(current);
    setError(null);
    setPending(false);
  }, [visible, current]);

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;

  async function save() {
    setPending(true);
    setError(null);
    try {
      const probed = await probeApiBase(draft);
      if (!probed.ok) {
        setError(probed.error);
        return;
      }
      const saved = await saveApiBase(probed.url);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  async function restoreDefault() {
    setPending(true);
    setError(null);
    try {
      const saved = await resetApiBase();
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: "#F7F7F4" }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SafeAreaView style={{ flex: 1, paddingHorizontal: 24, paddingTop: 12 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={{ color: "#6E6E68", fontSize: 17 }}>Cancel</Text>
            </Pressable>
            <Text style={{ color: "#1B1B1E", fontSize: 17, fontWeight: "600" }}>Server</Text>
            <Pressable onPress={() => void save()} disabled={pending} hitSlop={8}>
              <Text style={{ color: "#1B1B1E", fontSize: 17, fontWeight: "600" }}>
                {pending ? "Checking…" : "Save"}
              </Text>
            </Pressable>
          </View>
          <Text style={{ color: "#6E6E68", marginTop: 28, fontSize: 15, lineHeight: 22 }}>
            Point this app at your AIMEE service, the same HTTPS URL you open in a browser.
          </Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            keyboardType="url"
            textContentType="URL"
            returnKeyType="go"
            onSubmitEditing={() => void save()}
            placeholder={defaultApiBase()}
            placeholderTextColor="#8C8C86"
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            style={{
              marginTop: 20,
              backgroundColor: "#F1F1ED",
              borderRadius: 13,
              padding: 16,
              color: "#1B1B1E",
              fontSize: 16,
            }}
          />
          {warning ? (
            <Text style={{ color: "#8C8C86", marginTop: 12, fontSize: 13 }}>{warning}</Text>
          ) : null}
          {error ? <Text style={{ color: "#C94244", marginTop: 12 }}>{error}</Text> : null}
          {usesCustomApiBase(current) || draft.trim() !== current ? (
            <Pressable
              onPress={() => void restoreDefault()}
              disabled={pending}
              style={{ marginTop: 28, alignItems: "center" }}
            >
              <Text style={{ color: "#6E6E68", fontSize: 15 }}>Use default server</Text>
            </Pressable>
          ) : null}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
