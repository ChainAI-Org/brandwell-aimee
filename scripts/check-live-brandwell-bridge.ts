import { createHmac } from "node:crypto";
import { BrandwellNativeConnector } from "../packages/adapters/src/brandwell-native-connector.js";
import { createDb } from "../packages/db/src/client.js";

const databaseUrl = required("DATABASE_URL");
const apiBaseUrl = required("BRANDWELL_PLATFORM_API_URL");
const serviceToken = required("BRANDWELL_PLATFORM_SERVICE_TOKEN");
const customerId = required("BRANDWELL_ACCEPTANCE_CUSTOMER_ID");

const { prisma, pool } = createDb(databaseUrl);

try {
  const mapping = await prisma.brandwellAiWorkspace.findUnique({
    where: { brandwellCustomerId: customerId },
    select: {
      brandwellCustomerId: true,
      rakazoWorkspaceId: true,
      serviceIdentityId: true,
      subscriptionStatus: true,
      provisioningStatus: true,
    },
  });

  if (!mapping?.serviceIdentityId) {
    throw new Error("The requested BrandWell customer is not linked to an AIMEE service identity");
  }

  const connector = new BrandwellNativeConnector(prisma, { apiBaseUrl, serviceToken });
  const executionId = `live-acceptance-${Date.now()}`;
  const context = {
    operationId: executionId,
    traceId: executionId,
    workspaceId: mapping.rakazoWorkspaceId,
    userId: "live-acceptance",
    serviceIdentityId: mapping.serviceIdentityId,
    signal: new AbortController().signal,
  };
  const tools = await connector.discoverTools(context);
  const requestedTool = tools.find((tool) => tool.name === "brandwell_intent_get_daily_buyers");

  if (!requestedTool) {
    throw new Error("The daily buyer tool was not discovered for this workspace");
  }

  const events = [];
  for await (const event of connector.execute(
    { tool: requestedTool.name, args: { limit: 1 }, executionId },
    context,
  )) {
    events.push(
      event.type === "result"
        ? {
            type: event.type,
            resultKeys:
              event.data && typeof event.data === "object" ? Object.keys(event.data).sort() : [],
          }
        : { type: event.type, message: event.message },
    );
  }

  const successful = events.some((event) => event.type === "result");
  const diagnostic = successful
    ? null
    : await diagnosticRequest({
        apiBaseUrl,
        serviceToken,
        customerId: mapping.brandwellCustomerId,
        workspaceId: mapping.rakazoWorkspaceId,
        serviceIdentityId: mapping.serviceIdentityId,
      });
  console.log(
    JSON.stringify({
      successful,
      customerId: mapping.brandwellCustomerId,
      subscriptionStatus: mapping.subscriptionStatus,
      provisioningStatus: mapping.provisioningStatus,
      discoveredToolCount: tools.length,
      requestedTool: requestedTool.name,
      events,
      diagnostic,
    }),
  );
  if (!successful) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}

async function diagnosticRequest(input: {
  apiBaseUrl: string;
  serviceToken: string;
  customerId: string;
  workspaceId: string;
  serviceIdentityId: string;
}) {
  const executionId = `live-diagnostic-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const serialized = JSON.stringify({ limit: 1 });
  const signature = createHmac("sha256", input.serviceToken)
    .update(`${timestamp}.${input.customerId}.${input.workspaceId}.${executionId}.${serialized}`)
    .digest("hex");
  const response = await fetch(
    `${input.apiBaseUrl.replace(/\/$/, "")}/internal/aimee/intent/daily-buyers`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${input.serviceToken}`,
        "content-type": "application/json",
        "x-brandwell-customer-id": input.customerId,
        "x-brandwell-workspace-id": input.workspaceId,
        "x-brandwell-service-identity-id": input.serviceIdentityId,
        "x-brandwell-execution-id": executionId,
        "x-brandwell-timestamp": timestamp,
        "x-brandwell-signature": signature,
      },
      body: serialized,
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    code: typeof body.code === "string" ? body.code : null,
    error: typeof body.error === "string" ? body.error : null,
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
