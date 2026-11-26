import { createHash, createHmac } from "node:crypto";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const hmac = (key, text) => createHmac("sha256", key).update(text).digest();
export function decodeXml(value) { return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, code) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[code] || String.fromCodePoint(code.startsWith("#x") ? parseInt(code.slice(2),16) : Number(code.slice(1))))); }
export function xmlValue(xml, tag) { const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return match ? decodeXml(match[1]) : undefined; }
export function createYmqTransport(config, fetcher = fetch) {
  const endpoint = new URL(config.endpoint || "https://message-queue.api.cloud.yandex.net");
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error("Invalid queue endpoint");
  const region = config.region || "ru-central1";
  async function request(action, parameters = {}, signal, timeout = 8000) {
    const data = new URLSearchParams({ Action: action, Version: "2012-11-05", ...parameters });
    const body = data.toString(), date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0,8);
    const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8", "host": endpoint.host, "x-amz-date": date };
    const signed = "content-type;host;x-amz-date";
    const canonical = ["POST", endpoint.pathname || "/", "", Object.entries(headers).map(([key,value])=>key+":"+value+"\n").join(""), signed, sha(body)].join("\n");
    const scope = day + "/" + region + "/sqs/aws4_request";
    const key = hmac(hmac(hmac(hmac("AWS4"+config.credentials.secretAccessKey, day),region),"sqs"),"aws4_request");
    const signature = createHmac("sha256",key).update("AWS4-HMAC-SHA256\n"+date+"\n"+scope+"\n"+sha(canonical)).digest("hex");
    const response = await fetcher(endpoint, { method: "POST", headers: { ...headers, authorization: "AWS4-HMAC-SHA256 Credential="+config.credentials.accessKeyId+"/"+scope+", SignedHeaders="+signed+", Signature="+signature }, body,
      signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: "error" });
    const text = await response.text();
    if (Buffer.byteLength(text) > 3 * 1024 * 1024) throw Error("Queue response too large");
    if (!response.ok) throw Error("Queue " + action + " HTTP " + response.status + " " + (xmlValue(text,"Code") || "unavailable"));
    return text;
  }
  return {
    provider: "ymq", request,
    async publish(queueUrl, frames) {
      if (!frames.length || frames.length > 10) throw Error("Invalid queue batch");
      if (frames.length > 1 && frames.reduce((size,frame)=>size+Buffer.byteLength(JSON.stringify(frame)),0)>128*1024) {
        const middle=Math.ceil(frames.length/2);
        await this.publish(queueUrl,frames.slice(0,middle));await this.publish(queueUrl,frames.slice(middle));return;
      }
      const fields = { QueueUrl: queueUrl };
      frames.forEach((frame,index)=>{fields[`SendMessageBatchRequestEntry.${index+1}.Id`]=String(index);fields[`SendMessageBatchRequestEntry.${index+1}.MessageBody`]=JSON.stringify(frame);});
      const result = await request("SendMessageBatch",fields);
      if (result.includes("<BatchResultErrorEntry>")) throw Error("Queue batch not fully accepted");
    },
    async receive(queueUrl, signal) {
      const text = await request("ReceiveMessage",{QueueUrl:queueUrl,WaitTimeSeconds:"20",MaxNumberOfMessages:"5",VisibilityTimeout:"60"},signal,26000);
      return [...text.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map(([,entry])=>({id:xmlValue(entry,"MessageId"),handle:xmlValue(entry,"ReceiptHandle"),body:xmlValue(entry,"Body")}));
    },
    async acknowledge(queueUrl, messages) {
      if (!messages.length) return;
      const fields={QueueUrl:queueUrl};messages.forEach((message,index)=>{fields[`DeleteMessageBatchRequestEntry.${index+1}.Id`]=String(index);fields[`DeleteMessageBatchRequestEntry.${index+1}.ReceiptHandle`]=message.handle;});
      const result=await request("DeleteMessageBatch",fields);
      if(result.includes("<BatchResultErrorEntry>"))throw Error("Queue acknowledgement incomplete");
    },
  };
}
