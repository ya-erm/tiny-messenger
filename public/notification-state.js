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
  const valid = p => p?.kind === 'message_summary' && typeof p.userId === 'string' && /^[a-f0-9-]{36}$/i.test(p.userId) && Number.isSafeInteger(p.revision) && p.revision >= 0 && Number.isSafeInteger(p.unreadCount) && p.unreadCount >= 0;
  const isMessage = n => n.data?.kind === 'message_summary' || /^(?:group-)?message-/.test(n.tag);
  const notifications = async () => { try { return await self.registration.getNotifications(); } catch { return []; } };
  async function show(p, silent) {
    await self.registration.showNotification('Tiny Messenger', {
      body: p.body || (p.unreadCount ? `Непрочитанных сообщений: ${p.unreadCount}` : 'Все сообщения прочитаны'),
      icon:'/icon-192.png',badge:'/icon-192.png',tag:`tm-messages-${p.userId}`,silent,renotify:!silent,
      data:{kind:'message_summary',userId:p.userId,revision:p.revision,unreadCount:p.unreadCount,url:p.url || '/'},
    });
  }
  async function current(p) {
    let saved = await get(p.userId);
    if (!saved) {
      const tray = (await notifications()).find(n => n.data?.userId === p.userId && n.data?.revision > p.revision);
      if (tray) saved={payload:{...tray.data,body:tray.body,title:tray.title},shownRevision:tray.data.revision};
    }
    return { saved, payload: saved?.payload?.revision > p.revision ? saved.payload : p };
  }
  self.TMNotificationState = {
    push: incoming => serial(async () => {
      if (!valid(incoming)) return false;
      const bound = await get('account');
      if (bound !== undefined && bound !== incoming.userId) {
        // A subscription may have changed account while an older push was in
        // flight. Never display the old account's content, even briefly.
        await self.registration.showNotification('Tiny Messenger',{body:'Состояние уведомлений обновлено',tag:'tm-account-state',silent:true,renotify:false});
        return true;
      }
      const {saved,payload}=await current(incoming);
      const silent=Boolean(incoming.silent || payload.revision !== incoming.revision || (saved?.shownRevision ?? -1) >= payload.revision);
      for (const n of await notifications()) if (isMessage(n) && n.data?.kind !== 'message_summary') { try { n.close(); } catch {} }
      // Every remote push remains user-visible, including all-read corrections.
      // No show-then-immediately-close trick that violates userVisibleOnly.
      await show(payload,silent);
      await put(payload.userId,{payload,shownRevision:payload.revision});
      return true;
    }),
    sync: incoming => serial(async () => {
      if (!valid(incoming)) return;
      await put('account',incoming.userId);
      const {saved,payload}=await current(incoming);
      await put(incoming.userId,{payload,shownRevision:saved?.shownRevision});
      const tray=await notifications();
      for (const n of tray) if (n.data?.kind === 'message_summary' && n.data.userId !== incoming.userId) { try { n.close(); } catch {} }
      const own=tray.filter(n=>isMessage(n) && (!n.data?.userId || n.data.userId===incoming.userId));
      if (!own.length) return; // Opening the app never creates a notification.
      if (!payload.unreadCount) {
        for (const n of own) { try { n.close(); } catch {} }
        const remaining=(await notifications()).some(n=>isMessage(n)&&(!n.data?.userId||n.data.userId===incoming.userId));
        if (remaining) await show(payload,true);
      } else if (!saved || saved.payload.revision < incoming.revision || own.some(n=>n.data?.kind!=='message_summary')) {
        for (const n of own) if (n.data?.kind !== 'message_summary') { try { n.close(); } catch {} }
        await show(payload,true);
      }
    }),
    logout: userId => serial(async () => {
      const bound=await get('account');
      if (bound !== undefined && bound !== userId) return;
      await put('account','');
      for(const n of await notifications()) if(isMessage(n)) { try { n.close(); } catch {} }
    }),
  };
})();
