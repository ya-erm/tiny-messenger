import assert from "node:assert/strict";
import {readFile}from"node:fs/promises";
import{prisma,write}from"../src/lib/db";
import{prepareRowHistory}from"../src/lib/replication/history";
import{ingestLocalRows,materializeRows}from"../src/lib/replication/row-store";
import{ROW_TABLES}from"../src/lib/replication/rows";
if(!process.env.DATABASE_URL?.includes("extended-dryrun"))throw Error("Only a disposable database is allowed");
try{
 const snapshot=JSON.parse(await readFile(process.env.TM_HISTORY_SNAPSHOT!,"utf8"));
 const result=await write(async tx=>{
  const load=async()=>{const result={};for(const [table,definition]of Object.entries(ROW_TABLES))result[table]=await tx.$queryRawUnsafe(`SELECT * FROM "${table}" ORDER BY ${definition.keys.map(key=>'"'+key+'"').join(',')}`);return result;};
  const before=await load();await prepareRowHistory(tx,snapshot);
  while(!await ingestLocalRows(tx,"vps-1")){}
  await materializeRows(tx);assert.deepEqual(await load(),before,"Initial enrollment must preserve all user tables");
  return{changes:await tx.replicaChange.count(),rows:await tx.replicaRow.count(),pending:await tx.replicaRow.count({where:{pending:true}})};
 },{timeout:60000});console.log(JSON.stringify({...result,userTablesUnchanged:true}));
}finally{await prisma.$disconnect();}
