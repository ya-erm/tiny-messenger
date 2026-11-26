import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { serviceAccountCredentials, cloudApi } from "./yandex-auth.mjs";

const directory = new URL("../.secrets/yandex-cloud/", import.meta.url);
const stateFile = new URL("deployment.json", directory);
const state = JSON.parse(await readFile(stateFile, "utf8"));
const replication = JSON.parse(await readFile(new URL("replication.json", directory), "utf8").catch(() => "null"));
const localEnvironment = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const attachmentEnvironment = Object.fromEntries(Object.entries(localEnvironment).filter(([key]) => /^ATTACHMENTS_(?:S3_|MAX_|USER_|UPLOAD_|DOWNLOAD_|UNATTACHED_|DELETE_|CLEANUP_)/.test(key)));
const eventBus = JSON.parse(await readFile(new URL("bus.json", directory), "utf8").catch(() => "null"));
const cloudBus = eventBus?.queues?.["yandex-1"] ? { ...eventBus, installationId: "yandex-1", inboxArn: eventBus.queues["yandex-1"].arn,
  targets: [{ installationId: "vps-1", address: eventBus.queues["vps-1"].url }] } : undefined;
const api = cloudApi(serviceAccountCredentials(new URL("service-account.json", directory)));
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
async function complete(value) {
  if (!("done" in value) && !value.metadata && !value.response && !value.error) return value;
  const started = Date.now();
  while (!value.done) {
    if (Date.now() - started > 600_000) throw Error(`Cloud operation ${value.id} is still running; inspect it before retrying`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    value = await api("https://operation.api.cloud.yandex.net/operations/" + value.id);
  }
  if (value.error) throw Error(`Cloud operation failed: ${value.error.message}`);
  return value.response;
}

if (!state.functionId) {
  const list = await api(`https://serverless-functions.api.cloud.yandex.net/functions/v1/functions?folderId=${state.folderId}`);
  const resource = list.functions?.find((item) => item.name === "tm-prototype-api") || await complete(await api("https://serverless-functions.api.cloud.yandex.net/functions/v1/functions", {
    method: "POST", body: { folderId: state.folderId, name: "tm-prototype-api", description: "Independent Tiny Messenger API prototype", labels: { app: "tiny-messenger", purpose: "prototype" } },
  }));
  state.functionId = resource.id; await save();
}
await api(`https://serverless-functions.api.cloud.yandex.net/functions/v1/functions/${state.functionId}:updateAccessBindings`, {
  method: "POST", body: { accessBindingDeltas: [{ action: "ADD", accessBinding: { roleId: "serverless.functions.invoker", subject: { id: state.runtimeServiceAccountId, type: "serviceAccount" } } }] },
});
const content = await readFile(new URL("../cloud/yandex/dist/function.zip", import.meta.url));
const version = await complete(await api("https://serverless-functions.api.cloud.yandex.net/functions/v1/versions", { method: "POST", body: {
  functionId: state.functionId, runtime: "nodejs22", entrypoint: "index.handler", resources: { memory: "268435456" },
  executionTimeout: "15s", serviceAccountId: state.runtimeServiceAccountId, content: content.toString("base64"),
  environment: { ...(cloudBus ? { TM_BUS_CONFIG: JSON.stringify(cloudBus) } : {}), ...attachmentEnvironment, YDB_CONNECTION_STRING: state.databaseConnectionString, TM_INSTALLATION_ID: "yandex-1",
    TM_ALLOWED_ORIGINS: "https://tm.ya-erm.ru,https://gh.tm.ya-erm.ru,https://vm.tm.ya-erm.ru",
    ...(replication ? { TM_REPLICATION_SECRET: replication.secret, TM_REPLICATION_PEER: replication.installationId } : {}) },
  tag: ["prototype"], concurrency: "1", logOptions: { folderId: state.folderId, minLevel: "WARN" },
} }));
state.functionVersionId = version.id; await save();
await complete(await api(`https://serverless-functions.api.cloud.yandex.net/functions/v1/functions/${state.functionId}:setScalingPolicy`, {
  method: "POST", body: { tag: "prototype", provisionedInstancesCount: "0", zoneInstancesLimit: "1", zoneRequestsLimit: "1" },
}));
const integration = { type: "cloud_functions", function_id: state.functionId, tag: "prototype", service_account_id: state.runtimeServiceAccountId };
const specification = { openapi: "3.0.0", info: { title: "Tiny Messenger prototype", version: "0.1.0" },
  paths: { "/": { "x-yc-apigateway-any-method": { "x-yc-apigateway-integration": integration } },
    "/{path+}": { parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
      "x-yc-apigateway-any-method": { "x-yc-apigateway-integration": integration } } } };
if (!state.gatewayId) {
  const list = await api(`https://serverless-apigateway.api.cloud.yandex.net/apigateways/v1/apigateways?folderId=${state.folderId}`);
  const existing = (list.apiGateways || []).find((item) => item.name === "tm-prototype-api");
  const resource = existing || await complete(await api("https://serverless-apigateway.api.cloud.yandex.net/apigateways/v1/apigateways", {
    method: "POST", body: { folderId: state.folderId, name: "tm-prototype-api", description: "Independent Tiny Messenger channel",
      labels: { app: "tiny-messenger", purpose: "prototype" }, openapiSpec: JSON.stringify(specification), executionTimeout: "15s",
      logOptions: { folderId: state.folderId, minLevel: "WARN" } },
  }));
  state.gatewayId = resource.id; state.gatewayUrl = "https://" + resource.domain.replace(/^https?:\/\//, ""); await save();
}
console.log(JSON.stringify({ functionId: state.functionId, versionId: state.functionVersionId, gatewayId: state.gatewayId, gatewayUrl: state.gatewayUrl, memoryMiB: 256, provisionedInstances: 0 }));
