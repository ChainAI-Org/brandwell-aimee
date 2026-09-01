import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("managed AIMEE dashboard fits desktop, tablet, and mobile widths", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `managed-responsive-${stamp}@rakazo.test`, "password12", "Managed User");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await rpc(page, "bots/update", { botId, name: "AIMEE" });
  for (const [index, name] of [
    "Check weekly content performance",
    "Review high-intent visitors",
    "Prepare campaign recommendations",
    "Check upcoming sales follow-ups",
  ].entries()) {
    await rpc(page, "routines/create", {
      botId,
      name,
      prompt: `Run managed routine ${index + 1}`,
      crons: [`${index} 9 * * 1`],
      timezone: "America/Phoenix",
      notify: true,
      active: false,
    });
  }

  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json?: {
        me?: Record<string, unknown>;
      };
    };
    if (body.json?.me) {
      body.json.me.brandwell = {
        plan: "aimee",
        subscriptionStatus: "active",
        provisioningStatus: "ready",
        primaryBotId: botId,
      };
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });

  await page.goto("/app/dashboard");
  await expect(page.getByTestId("aimee-dashboard")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AIMEE", exact: true })).toBeVisible();
  await expect(page.getByText("Check weekly content performance")).toBeVisible();

  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "compact-desktop", width: 1100, height: 800 },
    { name: "tablet", width: 768, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.getByTestId("aimee-dashboard-scroll")).toBeVisible();

    const overflow = await page.getByTestId("aimee-dashboard-scroll").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(
      overflow.scrollWidth,
      `${viewport.name} dashboard should not scroll horizontally`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);

    const activity = await page.getByTestId("aimee-activity-card").boundingBox();
    const routines = await page.getByTestId("aimee-routines-card").boundingBox();
    const intro = await page.getByTestId("aimee-dashboard-intro").boundingBox();
    expect(activity).not.toBeNull();
    expect(routines).not.toBeNull();
    expect(intro).not.toBeNull();
    expect(intro?.width ?? 0).toBeGreaterThanOrEqual(300);
    expect((activity?.x ?? 0) + (activity?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
    expect((routines?.x ?? 0) + (routines?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);

    if (viewport.width >= 1000) {
      expect(Math.abs((activity?.width ?? 0) - (routines?.width ?? 0))).toBeLessThanOrEqual(2);
      expect(Math.abs((activity?.y ?? 0) - (routines?.y ?? 0))).toBeLessThanOrEqual(2);
    } else {
      expect(routines?.y ?? 0).toBeGreaterThan((activity?.y ?? 0) + (activity?.height ?? 0));
    }

    await captureScreenshot(page, testInfo, `managed-dashboard-${viewport.name}`);
  }
});
