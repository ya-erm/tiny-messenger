export function russianForm(count:number,forms:readonly[string,string,string]) {
 const value=Math.abs(Math.trunc(count)),tail=value%100,last=value%10;
 return forms[tail>=11&&tail<=14?2:last===1?0:last>=2&&last<=4?1:2];
}
export function countLabel(count:number,forms:readonly[string,string,string]){return count+' '+russianForm(count,forms);}
