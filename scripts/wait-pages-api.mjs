// Publishing a mirror must wait until its independent API supports signup.
const endpoint='https://d5dbsbpos3rfligv4k7h.nnekmrav.apigw.yandexcloud.net/api/transport';
const deadline=Date.now()+9*60_000;
while(Date.now()<deadline){
 try{const response=await fetch(endpoint,{signal:AbortSignal.timeout(10000)}),value=await response.json();if(response.ok&&value.ok&&value.data?.capabilities?.includes('registration')){console.log('Independent API supports registration.');process.exit(0);}}catch{}
 await new Promise(resolve=>setTimeout(resolve,10000));
}
throw Error('Independent registration API is not ready; mirror was not published.');
