import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {HttpError} from './errors.mjs';
import {appendReplication} from './replication.mjs';
import {animalProfileByName,randomAnimalProfile} from '../shared/names.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const clean=value=>typeof value==='string'?value.trim().replace(/\s+/g,' '):'';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function createRegistrationService(database,service,publicUser){
 return {
  async register(body,sourceIp='unknown'){
   const supplied=clean(body.name),animal=supplied?animalProfileByName(supplied):randomAnimalProfile(),name=supplied||animal?.name||randomAnimalProfile().name,nickname=typeof body.nickname==='string'?body.nickname.trim():'';
   if(!name||Array.from(name).length>20)throw new HttpError(422,'invalid_name','Имя должно быть не длиннее 20 символов');
   if(nickname&&!/^[a-z0-9_.-]{1,32}$/.test(nickname))throw new HttpError(422,'invalid_nickname','Ник: до 32 строчных латинских букв, цифр или символов _ . -');
   const stable=body.clientRequestId!==undefined||body.registrationToken!==undefined;
   if(stable&&(!uuid(body.clientRequestId)||!/^msg_[A-Za-z0-9_-]{16}$/.test(body.registrationToken)))throw new HttpError(422,'invalid_registration_request','Некорректный идентификатор регистрации');
   const id=stable?body.clientRequestId:randomUUID(),token=stable?body.registrationToken:'msg_'+randomBytes(12).toString('base64url'),tokenHash=hash(token),fingerprint=hash(JSON.stringify({name:supplied,nickname,tokenHash}));
   return database.transaction(async tx=>{
    const request=stable&&await tx.get('registration-requests',id);
    if(request){const current=await tx.get('users',id);if(request.hash!==fingerprint||!current||current.tokenHash!==tokenHash)throw new HttpError(409,'registration_conflict','ID регистрации уже использован');return{user:publicUser(current),token,replayed:true};}
    if(await tx.get('users',id)||await tx.get('tokens',tokenHash))throw new HttpError(409,'registration_conflict','Идентификатор регистрации уже использован');
    const registry=await tx.scan('users',1001);if(registry.length>=1000)throw new HttpError(503,'registry_capacity','Достигнут лимит пользователей этого контура');
    if(nickname&&registry.some(user=>user.nickname===nickname))throw new HttpError(409,'nickname_taken','Этот ник уже занят');
    const minute=Math.floor(Date.now()/60000);
    for(const[key,limit]of [['all',60],['ip:'+hash(sourceIp),5]]){
     const old=await tx.get('registration-rate',key),count=old?.minute===minute?old.count:0;
     if(count>=limit)throw new HttpError(429,'registration_rate_limited','Слишком много регистраций. Попробуйте через минуту.');
     await tx.put('registration-rate',key,{minute,count:count+1});
    }
    const at=new Date().toISOString(),user={id,name,...(nickname?{nickname}:{}),...(animal?.avatarUrl?{avatarUrl:animal.avatarUrl}:{}),tokenHash,createdAt:at,updatedAt:at};
    await tx.put('users',id,user);await tx.put('tokens',tokenHash,{userId:id});await tx.put('user-state',id,{contacts:[],groups:[],groupMessages:[],hiddenPeerIds:[],readStates:[]});
    if(stable)await tx.put('registration-requests',id,{hash:fingerprint});
    await appendReplication(tx,'user:'+id,{type:'user',user});
    return{user:publicUser(user),token,replayed:false};
   });
  },
  async contact(actor,body,remove=false){
   const identifier=clean(body.identifier),id=clean(body.userId)||(uuid(identifier)?identifier:''),nickname=clean(body.nickname)||(id?'':identifier.replace(/^@/,''));
   if(id&&!uuid(id)||!id&&!/^[a-z0-9_.-]{1,32}$/.test(nickname))throw new HttpError(422,'invalid_contact','Укажите корректный UUID или ник контакта');
   return service.rows.database.transaction(async tx=>{
    const target=id?await tx.get('users',id):(await tx.scan('users',10001)).find(user=>user.nickname===nickname);
    if(!target)throw new HttpError(404,'user_not_found','Пользователь не найден');if(target.id===actor.id)throw new HttpError(422,'self_contact','Себя добавлять не нужно');
    const state=await tx.get('user-state',actor.id)||{},contacts=state.contacts||[],old=contacts.find(item=>item.userId===target.id),at=new Date().toISOString();
    if(remove&&!old)throw new HttpError(404,'contact_not_found','Контакт не найден');
    const contact={userId:target.id,user:publicUser(target),createdAt:old?.createdAt||at,updatedAt:at};
    await tx.put('user-state',actor.id,{...state,contacts:[...contacts.filter(item=>item.userId!==target.id),...(!remove?[contact]:[])]});
    if(!remove)await service.rows.clearConversation(tx,actor.id,target.id);
    const operation={id:randomUUID(),ownerId:actor.id,userId:target.id,at,createdAt:contact.createdAt,deleted:remove};
    await appendReplication(tx,'contact:'+operation.id,{type:'contact',contact:operation});
    await tx.addFeed(actor.id,await tx.nextSequence(),{type:'snapshot.required'});
    return remove?{deleted:true}:{contact};
   });
  },
 };
}
