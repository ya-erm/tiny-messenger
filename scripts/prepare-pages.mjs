// Build input allow-list: no .env, database, credentials or server routes.
import {cp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),stage=path.join(root,'.pages-build');
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
for(const file of ['package.json','tsconfig.json','next-env.d.ts','public','src'])await cp(path.join(root,file),path.join(stage,file),{recursive:true});
await rm(path.join(stage,'src/app'),{recursive:true});await rm(path.join(stage,'src/proxy.ts'),{force:true});await mkdir(path.join(stage,'src/app'),{recursive:true});
for(const file of ['layout.tsx','globals.css','manifest.ts'])await cp(path.join(root,'src/app',file),path.join(stage,'src/app',file));
await mkdir(path.join(stage,'src/app/auth/yandex/callback'),{recursive:true});
await cp(path.join(root,'src/app/auth/yandex/callback/page.tsx'),path.join(stage,'src/app/auth/yandex/callback/page.tsx'));
await mkdir(path.join(stage,'src/app/admin'),{recursive:true});
await cp(path.join(root,'src/app/admin/page.tsx'),path.join(stage,'src/app/admin/page.tsx'));
await writeFile(path.join(stage,'src/app/page.tsx'),`"use client";
import {useEffect,useState} from "react";
import {MessengerApp} from "@/components/messenger-app";
export default function Home(){
 const [contact,setContact]=useState("");
 useEffect(()=>{const url=new URL(window.location.href);const value=url.searchParams.get("contact")||decodeURIComponent(url.pathname.replace(/^\\/|\\/$/g,""));if(/^@[a-z0-9_.-]{1,32}$/.test(value)||/^[0-9a-f-]{36}$/.test(value))setContact(value);},[]);
 return <MessengerApp sharedIdentifier={contact} sharedLabel={contact}/>;
}
`);
await writeFile(path.join(stage,'next.config.ts'),`import {createRequire} from 'node:module';
const {version}=createRequire(import.meta.url)('./package.json');
export default {output:'export',trailingSlash:true,images:{unoptimized:true},experimental:{cpus:1},env:{NEXT_PUBLIC_APP_VERSION:version,NEXT_PUBLIC_STATIC_CLIENT:'1',NEXT_PUBLIC_VPS_MIRROR_HOST:process.env.NEXT_PUBLIC_VPS_MIRROR_HOST||'',NEXT_PUBLIC_CLOUD_API_ORIGIN:process.env.NEXT_PUBLIC_CLOUD_API_ORIGIN||''}};
`);
await writeFile(path.join(stage,'src/app/manifest.ts'),(await readFile(path.join(stage,'src/app/manifest.ts'),'utf8'))+"\nexport const dynamic='force-static';\n");
const config=JSON.parse(await readFile(path.join(stage,'tsconfig.json'),'utf8'));config.include=['next-env.d.ts','src/app/**/*.ts','src/app/**/*.tsx','.next/types/**/*.ts'];await writeFile(path.join(stage,'tsconfig.json'),JSON.stringify(config,null,2));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
await writeFile(path.join(stage,'public/version.json'),JSON.stringify({ok:true,data:{version}}));
if(process.env.TM_PAGES_DOMAIN){const domain=process.env.TM_PAGES_DOMAIN;if(!/^[a-z0-9.-]+$/.test(domain))throw Error('Invalid Pages domain');await writeFile(path.join(stage,'public/CNAME'),domain+'\n');}await writeFile(path.join(stage,'public/.nojekyll'),'');
await symlink(path.join(root,'node_modules'),path.join(stage,'node_modules'),'dir');
console.log('Static client prepared; only public assets and client sources copied.');
