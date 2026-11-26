// Read-only comparison. Source is a private hash-only SQLite export.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectYdb} from '../cloud/yandex/src/store-ydb.mjs';
import {serviceAccountCredentials} from './yandex-auth.mjs';
import {ROW_TABLES,rowIdentity} from '../cloud/yandex/shared/rows.mjs';
const dir=new URL('../.secrets/yandex-cloud/',import.meta.url);
const source=JSON.parse(await readFile(new URL('rich-audit-source.json',dir),'utf8'));
const deployment=JSON.parse(await readFile(new URL('deployment.json',dir),'utf8'));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const db=await connectYdb(deployment.databaseConnectionString,serviceAccountCredentials(new URL('service-account.json',dir)));
try{
 let rowsChecked=0;const mismatchCounts={};
 for(const table of Object.keys(ROW_TABLES)){
  const actual=await db.transaction(tx=>tx.scan('rows:'+table,10001),{readOnly:true});assert.ok(actual.length<10001);
  const expected=Object.entries(source.rows).filter(([id])=>id.startsWith(table+':'));
  const found=new Map(actual.map(row=>[rowIdentity(table,row.key),hash(row)]));
  const mismatches=expected.filter(([id,value])=>found.get(id)!==value).length+actual.filter(row=>!source.rows[rowIdentity(table,row.key)]).length;
  if(mismatches)mismatchCounts[table]=mismatches;
  rowsChecked+=expected.length;
 }
 assert.equal(source.pending,0,'VPS rows still awaiting dependencies');assert.equal(source.suppressed,0,'VPS SQL trigger suppression still enabled');
 assert.deepEqual(mismatchCounts,{},'Replica states have not converged');
 const proof={replicatedRowStatesIdentical:true,rowsChecked,pending:source.pending,completedAt:new Date().toISOString()};
 await writeFile(new URL('rich-audit-proof.json',dir),JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}finally{db.close();}
