import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import * as Notifications from "expo-notifications";
import { DarkTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AvatarStyleProvider } from "../components/avatar-style";
import { loadApiBase } from "../lib/api";
import { pushNotificationDestination } from "../lib/push-destination";
import { applyMobileUiDirection } from "../lib/ui-direction";

applyMobileUiDirection();

export default function Layout() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadApiBase().finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    const open = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data ?? {};
      router.push(pushNotificationDestination(data) as never);
      void Notifications.clearLastNotificationResponseAsync();
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response);
    });
    return () => subscription.remove();
  }, [ready, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {ready ? (
        <AvatarStyleProvider>
          <ThemeProvider value={DarkTheme}>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: BRANDWELL_BRAND.colors.background },
                headerTintColor: BRANDWELL_BRAND.colors.text,
                headerShadowVisible: false,
                headerBackButtonDisplayMode: "minimal",
                contentStyle: { backgroundColor: BRANDWELL_BRAND.colors.background },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false, title: "AIMEE" }} />
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              <Stack.Screen name="account" options={{ title: "Account" }} />
              <Stack.Screen name="models" options={{ title: "Models" }} />
              <Stack.Screen name="voice" options={{ title: "Voice" }} />
              <Stack.Screen name="integrations" options={{ title: "Integrations" }} />
              <Stack.Screen
                name="new"
                options={{
                  title: "New AI employee",
                  presentation: "modal",
                  gestureEnabled: true,
                  headerBackVisible: false,
                }}
              />
              <Stack.Screen
                name="new-group"
                options={{
                  title: "New group",
                  presentation: "modal",
                  gestureEnabled: true,
                }}
              />
              <Stack.Screen name="group-thread" options={{ title: "Group" }} />
              <Stack.Screen name="group-settings" options={{ title: "Group settings" }} />
              <Stack.Screen name="bot-settings" options={{ title: "AIMEE settings" }} />
              <Stack.Screen name="thread" options={{ title: "Chat" }} />
              <Stack.Screen name="routine" options={{ title: "Routine" }} />
              <Stack.Screen name="computer" options={{ title: "Computer" }} />
            </Stack>
          </ThemeProvider>
        </AvatarStyleProvider>
      ) : (
        <View style={{ flex: 1, backgroundColor: BRANDWELL_BRAND.colors.background }} />
      )}
    </GestureHandlerRootView>
  );
}
