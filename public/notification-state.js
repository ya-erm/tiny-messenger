/* Shared by the worker and isolated tests; never holds authentication tokens. */
(() => {
  let database;
  let work = Promise.resolve();
  const serial = (run) => { const next = work.catch(() => {}).then(run); work = next; return next; };
  async function db() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('tiny-messenger-notifications', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }
  async function get(key) {
    try { const store = (await db()).transaction('state').objectStore('state'); return await new Promise((resolve,reject) => { const q=store.get(key);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error); }); }
    catch { return undefined; }
  }
  async function put(key,value) {
    try { const transaction=(await db()).transaction('state','readwrite');transaction.objectStore('state').put(value,key);await new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);}); } catch { /* Fall back to the live tray if storage is unavailable. */ }
  }
  const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
  const valid = p => p?.kind === 'message_summary' && uuid(p.userId) && Number.isSafeInteger(p.revision) && p.revision >= 0 && Number.isSafeInteger(p.unreadCount) && p.unreadCount >= 0
    && (p.messages === undefined || (Array.isArray(p.messages) && p.messages.length <= 12 && p.messages.every(m => uuid(m.id) && typeof m.title === 'string' && typeof m.body === 'string' && typeof m.url === 'string')));
  const isMessage = n => ['message_summary','message'].includes(n.data?.kind) || /^(?:group-)?message-/.test(n.tag);
  const notifications = async () => { try { return await self.registration.getNotifications(); } catch { return []; } };
  const close = n => { try { n.close(); } catch {} };
  const safeTitle = title => title && title !== 'Tiny Messenger' ? title : 'Новое сообщение';
  const cards = p => p.unreadCount ? (p.messages || [{id:`legacy-${p.revision}`,title:safeTitle(p.title),body:p.body || 'Новое сообщение',url:p.url || '/',alert:!p.silent}]) : [];
  async function showCard(p, message, silent) {
    // Explicitly close the same card as well as using a stable tag. Some PWA
    // notification centres otherwise retain an earlier version of a tagged card.
    for (const n of await notifications()) if (isMessage(n) && n.data?.userId === p.userId && n.data?.messageId === message.id) close(n);
    await self.registration.showNotification(safeTitle(message.title), {
      body:message.body,icon:'/icon-192.png',badge:'/icon-192.png',tag:`message-${message.id}`,silent,renotify:!silent,
      data:{kind:'message',userId:p.userId,messageId:message.id,revision:p.revision,url:message.url || '/'},
    });
  }
  async function showStatus(p) {
    for (const n of await notifications()) if (isMessage(n) && n.data?.userId === p.userId) close(n);
    await self.registration.showNotification(p.unreadCount ? safeTitle(p.title) : 'Сообщения прочитаны', {
      body:p.unreadCount ? p.body : '',icon:'/icon-192.png',badge:'/icon-192.png',tag:`tm-messages-${p.userId}`,silent:true,renotify:false,
      data:{kind:'message_summary',userId:p.userId,revision:p.revision,unreadCount:p.unreadCount,url:p.url || '/'},
    });
  }
  async function current(p) {
    let saved = await get(p.userId);
    if (!saved) {
      const tray = (await notifications()).find(n => n.data?.kind === 'message_summary' && n.data?.userId === p.userId && n.data.revision > p.revision);
      if (tray) saved={payload:{...tray.data,body:tray.body,title:tray.title},shownRevision:tray.data.revision};
    }
    return { saved, payload: saved?.payload?.revision > p.revision ? saved.payload : p };
  }
  async function reconcile(payload, saved, remote, silent) {
    const desired=cards(payload),wanted=new Set(desired.map(m=>m.id));
    const tray=await notifications();
    const own=tray.filter(n=>isMessage(n)&&(!n.data?.userId||n.data.userId===payload.userId));
    const migrated=own.some(n=>n.data?.kind!=='message');
    const seen=new Set(saved?.shownIds || own.map(n=>n.data?.messageId).filter(Boolean));
    for(const n of own) if(n.data?.kind!=='message'||!wanted.has(n.data.messageId)) close(n);
    let shown=false;
    for(const message of desired) {
      const existing=own.find(n=>n.data?.messageId===message.id);
      const changed=existing&&(existing.title!==safeTitle(message.title)||existing.body!==message.body);
      if((remote&&!seen.has(message.id))||changed) {
        await showCard(payload,message,Boolean(silent||!message.alert||seen.has(message.id)));
        seen.add(message.id);shown=true;
      }
    }
    if(remote&&!shown) {
      // A remote event must stay user-visible. Reconcile all-read as one quiet
      // status, or quietly refresh a remaining individual unread card.
      if(desired.length) { const last=desired.at(-1);await showCard(payload,last,true);seen.add(last.id); }
      else await showStatus(payload);
      shown=true;
    } else if(!remote&&desired.length&&migrated&&own.length&&!shown) {
      // Upgrade a legacy aggregate quietly, without creating cards just because
      // a user opens the app with no existing notification.
      const last=desired.at(-1);await showCard(payload,last,true);seen.add(last.id);shown=true;
    } else if(!remote&&!desired.length&&own.length) {
      const remaining=(await notifications()).some(n=>isMessage(n)&&(!n.data?.userId||n.data.userId===payload.userId));
      if(remaining) await showStatus(payload);
    }
    await put(payload.userId,{payload,shownIds:[...seen].slice(-256),shownRevision:shown?payload.revision:saved?.shownRevision});
  }
  self.TMNotificationState = {
    push: incoming => serial(async () => {
      if (!valid(incoming)) return false;
      const bound = await get('account');
      if (bound !== undefined && bound !== incoming.userId) {
        await self.registration.showNotification('Уведомления обновлены',{tag:'tm-account-state',silent:true,renotify:false});
        return true;
      }
      const {saved,payload}=await current(incoming);
      const silent=Boolean(incoming.silent||payload.revision!==incoming.revision||(saved?.shownRevision??-1)>=payload.revision);
      await reconcile(payload,saved,true,silent);
      return true;
    }),
    sync: incoming => serial(async () => {
      if (!valid(incoming)) return;
      await put('account',incoming.userId);
      const {saved,payload}=await current(incoming);
      for(const n of await notifications()) if(isMessage(n)&&n.data?.userId&&n.data.userId!==incoming.userId) close(n);
      await reconcile(payload,saved,false,true);
    }),
    logout: userId => serial(async () => {
      const bound=await get('account');
      if (bound !== undefined && bound !== userId) return;
      await put('account','');
      for(const n of await notifications()) if(isMessage(n)) close(n);
    }),
  };
})();
