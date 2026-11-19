import { readFile, writeFile } from "node:fs/promises";
import { serviceAccountCredentials, cloudApi } from "./yandex-auth.mjs";

const directory = new URL("../.secrets/yandex-cloud/", import.meta.url);
const target = JSON.parse(await readFile(new URL("target.json", directory), "utf8"));
const api = cloudApi(serviceAccountCredentials(new URL("service-account.json", directory)));
const stateFile = new URL("deployment.json", directory);
let state;
try { state = JSON.parse(await readFile(stateFile, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; state = { ...target }; }
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

async function operation(endpoint, value) {
  const started = Date.now();
  while (!value.done) {
    if (Date.now() - started > 180_000) throw Error(`Operation ${value.id} is still running; inspect existing resources before retrying`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    value = await api(endpoint + value.id);
  }
  if (value.error) throw Error(`Operation failed: ${value.error.message}`);
  return value.response;
}

if (!state.runtimeServiceAccountId) {
  const list = await api(`https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts?folderId=${target.folderId}`);
  const account = list.serviceAccounts?.find((item) => item.name === "tm-prototype-runtime") || await operation("https://operation.api.cloud.yandex.net/operations/", await api("https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts", {
    method: "POST", body: { folderId: target.folderId, name: "tm-prototype-runtime", description: "Tiny Messenger prototype function runtime" },
  }));
  state.runtimeServiceAccountId = account.id;
  await save();
}
await api(`https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders/${target.folderId}:updateAccessBindings`, {
  method: "POST", body: { accessBindingDeltas: [{ action: "ADD", accessBinding: { roleId: "ydb.editor", subject: { id: state.runtimeServiceAccountId, type: "serviceAccount" } } }] },
});
if (!state.databaseId) {
  const list = await api(`https://ydb.api.cloud.yandex.net/ydb/v1/databases?folderId=${target.folderId}`);
  let database = list.databases?.find((item) => item.name === "tm-prototype");
  if (!database) {
    console.log("Creating YDB Serverless: 0 provisioned RU/s, 100 RU/s throttle, 1 GiB storage cap");
    database = await operation("https://operation.api.cloud.yandex.net/operations/", await api("https://ydb.api.cloud.yandex.net/ydb/v1/databases", { method: "POST", body: {
      folderId: target.folderId, name: "tm-prototype", description: "Independent Tiny Messenger prototype",
      locationId: "ru-central1", serverlessDatabase: { enableThrottlingRcuLimit: true, throttlingRcuLimit: "100",
        storageSizeLimit: "1073741824", provisionedRcuLimit: "0" }, labels: { app: "tiny-messenger", purpose: "prototype" }, deletionProtection: true,
    } }));
  }
  state.databaseId = database.id;
  await save();
}
const database = await api(`https://ydb.api.cloud.yandex.net/ydb/v1/databases/${state.databaseId}`);
if (!database.serverlessDatabase) throw Error("Refusing a non-serverless database");
state.databaseConnectionString = database.endpoint;
await save();
console.log(JSON.stringify({ folder: target.folderName, databaseId: state.databaseId, status: database.status,
  endpoint: database.endpoint, runtimeServiceAccountId: state.runtimeServiceAccountId, provisionedCapacity: database.serverlessDatabase.provisionedRcuLimit || "0" }));
