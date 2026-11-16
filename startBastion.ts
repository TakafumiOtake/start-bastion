import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  waitUntilInstanceRunning,
} from "@aws-sdk/client-ec2";
import {
  ConnectionStatus,
  GetConnectionStatusCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

let forwardingProcess: ChildProcess | undefined;
let shutdownRequested = false;

const reconnectDelayMs = 2000;
const minimumStableSessionMs = 10000;
const ssmReadyTimeoutMs = 60000;
const ssmReadyPollIntervalMs = 3000;
const useProcessGroup = process.platform !== "win32";

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownRequested) {
    return;
  }

  shutdownRequested = true;
  console.log(`Received ${signal}. Stopping SSM port forwarding session...`);

  if (
    forwardingProcess &&
    forwardingProcess.exitCode == null &&
    forwardingProcess.signalCode == null
  ) {
    if (useProcessGroup && forwardingProcess.pid) {
      // AWS CLIと、その子プロセスのSession Manager pluginをまとめて終了する。
      try {
        process.kill(-forwardingProcess.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    } else {
      forwardingProcess.kill(signal);
    }
    return;
  }

  process.exit(0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSsmConnection(
  instanceId: string,
  ssm: SSMClient
): Promise<void> {
  console.log(
    `Waiting for instance ${instanceId} to accept SSM connections...`
  );
  const deadline = Date.now() + ssmReadyTimeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    try {
      const { Status } = await ssm.send(
        new GetConnectionStatusCommand({ Target: instanceId }),
        {
          abortSignal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        }
      );
      lastStatus = Status ?? "unknown";
      if (lastStatus === ConnectionStatus.CONNECTED && Date.now() < deadline) {
        console.log(`Instance ${instanceId} is ready for SSM connections.`);
        return;
      }
    } catch (error) {
      if (Date.now() < deadline) {
        throw error;
      }
      break;
    }

    await delay(
      Math.max(0, Math.min(ssmReadyPollIntervalMs, deadline - Date.now()))
    );
  }

  throw new Error(
    `Timed out after ${ssmReadyTimeoutMs / 1000}s waiting for SSM connection to ${instanceId}. Last status: ${lastStatus}.`
  );
}

function startForwardingSession({
  instanceId,
  documentName,
  parameters,
}: {
  instanceId: string;
  documentName: string;
  parameters: string;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  ranMs: number;
}> {
  console.log("Starting SSM port forwarding session to DB endpoint...");

  const args = [
    "ssm",
    "start-session",
    "--target",
    instanceId,
    "--document-name",
    documentName,
    "--parameters",
    parameters,
  ];

  const startedAt = Date.now();
  const child = spawn("aws", args, {
    detached: useProcessGroup,
    stdio: "inherit",
  });

  forwardingProcess = child;

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      forwardingProcess = undefined;
      resolve({ code, signal, ranMs: Date.now() - startedAt });
    });
  });
}

async function main(): Promise<void> {
  const instanceName = process.env.BASTION_INSTANCE_NAME;
  const configuredInstanceId = instanceName ? undefined : process.env.BASTION_INSTANCE_ID;
  if (!instanceName && !configuredInstanceId) {
    throw new Error("Missing required env: BASTION_INSTANCE_NAME");
  }
  const instanceSelector = configuredInstanceId
    ? `EC2 ID: ${configuredInstanceId}`
    : `EC2 Name: ${instanceName}`;
  const localDbPort = Number(process.env.LOCAL_DB_PORT ?? "5432");
  if (
    !Number.isInteger(localDbPort) ||
    localDbPort < 1 ||
    localDbPort > 65535
  ) {
    console.error("LOCAL_DB_PORT must be an integer between 1 and 65535");
    process.exit(1);
  }
  const remoteHostDocument = "AWS-StartPortForwardingSessionToRemoteHost";
  const documentName =
    process.env.SSM_DOCUMENT_NAME?.trim() || remoteHostDocument;
  const parameters = JSON.stringify({
    localPortNumber: [String(localDbPort)],
    ...(documentName === remoteHostDocument
      ? { host: [mustGetEnv("RDB_ENDPOINT")], portNumber: ["5432"] }
      : {}),
  });
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    console.error("Missing required env: AWS_REGION (or AWS_DEFAULT_REGION)");
    process.exit(1);
  }

  const ec2 = new EC2Client({
    region,
  });

  const describe = await ec2.send(
    new DescribeInstancesCommand({
      InstanceIds: configuredInstanceId ? [configuredInstanceId] : undefined,
      Filters: [
        ...(instanceName ? [{ Name: "tag:Name", Values: [instanceName] }] : []),
        {
          Name: "instance-state-name",
          Values: ["pending", "running", "stopping", "stopped"],
        },
      ],
    })
  );

  const instances = (describe.Reservations ?? []).flatMap(
    (r) => r.Instances ?? []
  );
  if (instances.length === 0) {
    console.error(`Instance not found for ${instanceSelector}`);
    process.exit(1);
  }
  if (instances.length > 1) {
    console.error(
      `Multiple instances found for ${instanceSelector}. Use a unique Name tag.`
    );
    process.exit(1);
  }
  const instance = instances[0];
  const instanceId = instance.InstanceId;
  if (!instanceId) {
    console.error(
      `Resolved instance is missing InstanceId for ${instanceSelector}`
    );
    process.exit(1);
  }

  const state = instance.State?.Name;

  if (state !== "running") {
    console.log(
      `Starting instance ${instanceId} (current: ${state ?? "unknown"})...`
    );
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));

    console.log("Waiting for instance to be running...");
    await waitUntilInstanceRunning(
      { client: ec2, maxWaitTime: 300 },
      { InstanceIds: [instanceId] }
    );
  } else {
    console.log(`Instance ${instanceId} is already running.`);
  }

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  const ssm = new SSMClient({ region });
  try {
    await waitForSsmConnection(instanceId, ssm);
  } finally {
    ssm.destroy();
  }

  while (true) {
    const result = await startForwardingSession({
      instanceId,
      documentName,
      parameters,
    });

    if (shutdownRequested) {
      console.log("SSM port forwarding session stopped.");
      process.exit(0);
    }

    if (
      result.signal ||
      (result.code !== 0 && result.ranMs < minimumStableSessionMs)
    ) {
      console.error(
        `SSM port forwarding session exited before it became stable. Exit code: ${
          result.code ?? "none"
        }, signal: ${result.signal ?? "none"}.`
      );
      process.exit(1);
    }

    console.log(
      `SSM port forwarding session ended after ${Math.round(
        result.ranMs / 1000
      )}s. Reconnecting in ${reconnectDelayMs / 1000}s...`
    );
    await delay(reconnectDelayMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
