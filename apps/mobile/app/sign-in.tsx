import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import { Redirect, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { loadValidatedSession, signIn } from "../lib/api";

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const emailInput = useRef<TextInput>(null);

  useEffect(() => {
    void loadValidatedSession().then((session) => {
      setHasSession(Boolean(session.token));
      if (session.error) setError(session.error);
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
              Sign in with your BrandWell account to chat with AIMEE, review activity, and open your
              computer.
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
});
