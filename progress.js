function remapProgress(records,selected,mapping){let next={};for(let [id,value]of Object.entries(records)){let mapped=mapping[id];if(mapped&&value&&typeof value==='object')next[mapped]={...value};}return {records:next,selected:mapping[selected]||1};}
if(typeof module!=='undefined')module.exports=remapProgress;
