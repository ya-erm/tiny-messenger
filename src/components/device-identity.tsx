const platforms:Record<string,string>={Android:'android',iOS:'apple',macOS:'apple',Windows:'windows',Linux:'linux'};
const browsers:Record<string,string>={Chrome:'chrome',Firefox:'firefox-browser',Safari:'safari',Edge:'edge'};
function Icon({name}:{name?:string}) {
 return name?<img className="device-brand-icon" src={'/vendor/device-icons/'+name+'.svg'} width="14" height="14" alt=""/>:<svg className="device-brand-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="2" y="2" width="12" height="9" rx="2"/><path d="M5 14h6M8 11v3"/></svg>;
}
export function DeviceIdentity({platform,browser,detail}:{platform:string;browser:string;detail?:string}) {
 const prefix=platform+' · '+browser,suffix=detail?.startsWith(prefix)?detail.slice(prefix.length):'';
 return <span className="device-identity"><Icon name={platforms[platform]}/><span>{platform||'ОС неизвестна'}</span><span aria-hidden="true">·</span><Icon name={browsers[browser]}/><span>{browser||'Браузер неизвестен'}{suffix}</span></span>;
}
