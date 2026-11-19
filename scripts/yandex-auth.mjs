import { readFile } from "node:fs/promises";
import { constants, sign } from "node:crypto";

// Management credentials stay on the VPS; function archives never contain them.
export function serviceAccountCredentials(keyFile) {
  let cached;
  let pending;
  return { async getToken(force = false) {
    if (!force && cached && cached.expires > Date.now() + 60_000) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      const key = JSON.parse(await readFile(keyFile, "utf8"));
      if (!key.id || !key.service_account_id || !key.private_key) throw Error("Expected an authorized service-account JSON key");
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = encode({ typ: "JWT", alg: "PS256", kid: key.id }) + "." + encode({
        iss: key.service_account_id, aud: "https://iam.api.cloud.yandex.net/iam/v1/tokens", iat: now, exp: now + 3600,
      });
      const signature = sign("sha256", Buffer.from(unsigned), { key: key.private_key,
        padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64url");
      const response = await fetch("https://iam.api.cloud.yandex.net/iam/v1/tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jwt: unsigned + "." + signature }), signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json();
      if (!response.ok || !result.iamToken) throw Error(`IAM authentication failed (${response.status}): ${result.message || "missing token"}`);
      cached = { token: result.iamToken, expires: Date.parse(result.expiresAt) };
      return cached.token;
    })();
    try { return await pending; } finally { pending = undefined; }
  } };
}

export function cloudApi(credentials) {
  return async function request(url, { method = "GET", body } = {}) {
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${await credentials.getToken()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw Error(`Cloud API ${response.status}: ${result.message || result.code || "request failed"}`);
    return result;
  };
}
