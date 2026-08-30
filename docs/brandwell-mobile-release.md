# BrandWell AIMEE mobile release runbook

The BrandWell mobile app is a branded client of the managed AIMEE control plane. Production builds
use `https://ai.brandwell.ai`; clients do not choose an arbitrary Rakazo server.

## Distribution decision

Use one BrandWell-owned iOS application for the initial launch. Apply account and agency branding
inside the authenticated experience through trusted tenant configuration. This keeps one bundle ID,
one signing identity, one notification entitlement, one review history, and one update channel.

A fully separate white-label app for each reseller is a separate release product. Each variant needs
its own bundle ID, Expo project, App Store Connect record, signing setup, notification credentials,
privacy metadata, screenshots, review, and ongoing update process. Runtime branding does not change
the app icon or store listing after installation.

## TestFlight limitations

TestFlight is appropriate for a controlled beta, not indefinite customer distribution:

- A build can be tested for up to 90 days.
- Apple permits up to 10,000 external testers per app.
- The first external build requires TestFlight App Review; later builds might also be reviewed.
- Testers must install TestFlight and accept an email or public-link invitation.
- Each expiring build must be replaced and redistributed.
- Public-link testers can be anonymous in App Store Connect.

Apple's current official references:

- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)

Use TestFlight to prove the product with invited customers. Move to normal App Store distribution
when AIMEE is offered as an ongoing customer application.

## Private configuration

The repository includes the BrandWell name, assets, scheme, and bundle/package identifiers. Keep
these values in private Expo, Apple, and Google configuration:

- Expo project ID and owner
- Apple team, issuer, key, and App Store Connect application IDs
- iOS distribution certificates and provisioning profiles
- Android upload and app-signing credentials
- APNs and FCM credentials
- review account credentials

Never commit them.

Production EAS must set:

```text
EXPO_PUBLIC_API_URL=https://ai.brandwell.ai
```

The production app config rejects non-HTTPS API URLs and embeds the official BrandWell endpoint.

## Build preparation

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @rakazo/mobile exec expo install --check
pnpm --filter @rakazo/mobile check
pnpm --filter @rakazo/mobile test
```

From `apps/mobile`, after linking the BrandWell-owned Expo project:

```sh
eas env:create --environment production --name EXPO_PUBLIC_API_URL \
  --value https://ai.brandwell.ai --visibility plaintext
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

Do not submit until the target API revision is deployed and accepted.

## Physical iPhone acceptance

Use an invited client-admin test account and a separate BrandWell operator account.

1. Install the TestFlight build and sign in.
2. Confirm the AIMEE home, chat, activity, computer, and settings navigation.
3. Send ordinary chat and confirm the computer stays asleep.
4. Trigger a computer task and confirm wake-on-demand.
5. Open read-only preview and verify it is marked live.
6. Suspend the computer and verify the last screenshot is clearly marked stale.
7. Take control, complete a test login or MFA challenge, tap Done, and confirm AIMEE resumes.
8. Trigger `LOGIN_REQUIRED`, `APPROVAL_REQUIRED`, `RUN_FAILED`, and connector notifications. Confirm
   their deep links open the correct screen.
9. Confirm competing client and BrandWell takeovers are rejected and all control sessions are
   audited.
10. Confirm attachments, microphone permissions, background/resume, session expiry, sign out, and
    account deletion paths.
11. Verify VoiceOver labels, Dynamic Type, contrast, keyboard behavior, and common iPhone sizes.
12. Confirm no provider name, raw key, internal job ID, or another tenant's data appears.

## Release evidence

Record the build number, API revision, tester account IDs, tested devices and iOS versions, push
results, deep-link results, computer provider, model, run IDs, screenshots, and all known issues.
Keep customer passwords and secret material out of the evidence bundle.
