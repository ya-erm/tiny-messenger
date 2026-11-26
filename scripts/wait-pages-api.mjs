// Publishing a mirror must wait until its independent API supports signup.
const origin=process.env.NEXT_PUBLIC_CLOUD_API_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:')throw Error('Configure the independent API origin before publishing');
const endpoint=new URL('/api/transport',origin);
const deadline=Date.now()+9*60_000;
while(Date.now()<deadline){
 try{const response=await fetch(endpoint,{signal:AbortSignal.timeout(10000)}),value=await response.json();if(response.ok&&value.ok&&['registration','token-rotation','profile-write','device-telemetry','yandex-login','image-thumbnails','admin-charts-v2'].every(capability=>value.data?.capabilities?.includes(capability))){console.log('Independent account API is ready.');process.exit(0);}}catch{}
 await new Promise(resolve=>setTimeout(resolve,10000));
}
throw Error('Independent account API is not ready; mirror was not published.');
