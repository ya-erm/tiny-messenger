import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
export function testDirectory(){
 const configured=process.env.TM_CLOUD_TEST_CONFIG_DIR;
 if(!configured)throw Error('Set TM_CLOUD_TEST_CONFIG_DIR to an isolated remote test configuration directory');
 return pathToFileURL(resolve(configured)+sep);
}
export async function readTestConfiguration(){
 const directory=testDirectory();
 return {directory,deployment:JSON.parse(await readFile(new URL('deployment.json',directory),'utf8')),users:JSON.parse(await readFile(new URL('test-users.json',directory),'utf8'))};
}
export function testOrigin(name){
 const value=process.env[name];if(!value)throw Error('Set '+name+' explicitly for remote checks');
 const url=new URL(value);if(url.protocol!=='https:')throw Error(name+' must use HTTPS');return url.origin;
}
