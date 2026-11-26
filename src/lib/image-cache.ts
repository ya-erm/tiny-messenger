import type {AttachmentInfo} from "./attachment-types";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Entry = {key: string; userId: string; size: number; usedAt: number; expiresAt: number; epoch:string};
const LIMIT = 100 * 1024 * 1024, MAX_FILE = 20 * 1024 * 1024, LIFETIME = 14 * 86400000;
let database: Promise<IDBDatabase> | undefined;
type CacheState={epoch:string;blocked:boolean};
const states=new Map<string,CacheState>(),pending=new Map<string,Promise<Blob|string>>();
function cacheState(userId:string):CacheState{
 try{const value=JSON.parse(localStorage.getItem("tiny-messenger:v1:media-epoch:"+userId)||"null");if(typeof value?.epoch==="string"&&typeof value.blocked==="boolean")return value;}catch{}
 return states.get(userId)||{epoch:"initial",blocked:false};
}
function setCacheState(userId:string,value:CacheState){states.set(userId,value);try{localStorage.setItem("tiny-messenger:v1:media-epoch:"+userId,JSON.stringify(value));}catch{}}
export function enableImageCache(userId:string){const value=cacheState(userId);if(value.blocked)setCacheState(userId,{...value,blocked:false});else states.set(userId,value);}
function open() {
  return database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tiny-messenger-images-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("blobs", {keyPath: "key"});
      request.result.createObjectStore("entries", {keyPath: "key"}).createIndex("userId", "userId");
    };
    request.onsuccess = () => {request.result.onversionchange = () => {request.result.close(); database = undefined;}; resolve(request.result);};
    request.onerror = request.onblocked = () => {database = undefined; reject(Error("Image cache unavailable"));};
  });
}
const value = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
async function transaction<T>(run: (entries: IDBObjectStore, blobs: IDBObjectStore) => Promise<T>) {
  const db = await open(), tx = db.transaction(["entries", "blobs"], "readwrite");
  const done = new Promise<void>((resolve, reject) => {tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);});
  try {const result = await run(tx.objectStore("entries"), tx.objectStore("blobs")); await done; return result;}
  catch (error) {try {tx.abort();} catch {} await done.catch(() => {}); throw error;}
}
async function cached(key: string): Promise<Blob | undefined> {
  return transaction(async (entries, blobs) => {
    const entry: Entry | undefined = await value(entries.get(key));
    if (!entry) return;
    if (entry.expiresAt < Date.now() || entry.epoch!==cacheState(entry.userId).epoch || cacheState(entry.userId).blocked) {entries.delete(key); blobs.delete(key); return;}
    const stored = await value(blobs.get(key));
    if (!stored?.blob) {entries.delete(key); return;}
    if (Date.now() - entry.usedAt > 60000) entries.put({...entry, usedAt: Date.now()});
    return stored.blob as Blob;
  });
}
async function save(userId: string, key: string, blob: Blob, epoch: string) {
  if (cacheState(userId).blocked || cacheState(userId).epoch !== epoch || blob.size > MAX_FILE || !blob.size) return;
  await transaction(async (entries, blobs) => {
    const rows: Entry[] = await value(entries.getAll());
    let used = rows.filter(row => row.key !== key).reduce((sum, row) => sum + row.size, 0);
    let count=rows.filter(row=>row.key!==key).length;
    for (const row of rows.filter(row => row.key !== key).sort((a, b) => a.usedAt - b.usedAt)) {
      if (row.expiresAt >= Date.now() && used + blob.size <= LIMIT && count < 500) continue;
      entries.delete(row.key); blobs.delete(row.key); used -= row.size;count--;
    }
    // Logout may have happened while the database was opening.
    if (cacheState(userId).blocked || cacheState(userId).epoch !== epoch) return;
    entries.put({key, userId, size: blob.size, usedAt: Date.now(), expiresAt: Date.now() + LIFETIME, epoch} satisfies Entry);
    blobs.put({key, blob});
  });
}
export async function clearImageCache(userId: string) {
  setCacheState(userId,{epoch:crypto.randomUUID(),blocked:true});
  await transaction(async (entries, blobs) => {
    const rows: Entry[] = await value(entries.index("userId").getAll(userId));
    for (const row of rows) {entries.delete(row.key); blobs.delete(row.key);}
  }).catch(() => {});
}
if(typeof window!=="undefined")window.addEventListener("storage",event=>{
 if(event.key===null){for(const userId of states.keys())void clearImageCache(userId);}
});
export async function imageSource(userId: string, file: AttachmentInfo, request: Request, small = false) {
  if(!states.has(userId))states.set(userId,cacheState(userId));
  const variant = small && file.hasThumbnail ? "thumbnail" : "preview", key = userId + ":" + file.id + ":" + variant;
  const epoch = cacheState(userId).epoch, workKey = key + ":" + epoch;
  let job = pending.get(workKey);
  if (!job) {
    job = (async () => {
      const existing = cacheState(userId).blocked?undefined:await cached(key).catch(() => undefined);
      if (existing) return existing;
      const {url} = await request<{url: string}>(`/api/attachments/${file.id}/url?mode=${variant}`);
      if (variant === "preview" && file.size > MAX_FILE) return url;
      try {
        const response = await fetch(url, {credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(25000)});
        if (!response.ok) throw Error("Image unavailable");
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") || !blob.size || blob.size > MAX_FILE) return url;
        await save(userId, key, blob, epoch).catch(() => {});
        return blob;
      } catch {return url;}
    })();
    pending.set(workKey, job);
    const current = job;
    void job.finally(() => {if (pending.get(workKey) === current) pending.delete(workKey);}).catch(() => {});
  }
  const result = await job;
  const url = typeof result === "string" ? result : URL.createObjectURL(result);
  return {url, release: () => {if (typeof result !== "string") URL.revokeObjectURL(url);}};
}
