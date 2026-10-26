/* GameBull integration boundary. Demo balances are browser-local, never real GameBull lives. */
class GameBullDemoAdapter {
 constructor(config,levels,Engine,storage){this.config=config;this.levels=levels;this.Engine=Engine;this.storage=storage;this.key='gamebull-demo:v1:'+config.companyId+':'+config.levelSetVersion;}
 fresh(){return {schema:1,companyId:this.config.companyId,levelSetVersion:this.config.levelSetVersion,balance:this.config.demoInitialLives,unlocked:1,clears:{},attempt:null,revision:0,appliedOperations:[]};}
 read(){let raw=this.storage.getItem(this.key);if(raw===null)return this.fresh();let s=JSON.parse(raw);if(s.schema!==1||s.companyId!==this.config.companyId||s.levelSetVersion!==this.config.levelSetVersion||!Number.isInteger(s.balance)||s.balance<0||!Number.isInteger(s.unlocked)||s.unlocked<1)throw Error('テスト記録を読み込めません。');return s;}
 async initialize(){return this.read();}
 engine(attempt){let level=this.levels[attempt.levelId-1];let g=new this.Engine({...level,map:attempt.map||level.previousMap||level.map});Object.assign(g,JSON.parse(JSON.stringify(attempt.engine)));g.history=attempt.history.slice();return g;}
 pack(g,id){return {id,levelId:g.id,map:g.map,engine:JSON.parse(g.snapshot()),history:g.history.slice()};}
 reduce(state,request){let s=JSON.parse(JSON.stringify(state));if(!request.operationId)throw Error('操作IDが必要です。');if(s.appliedOperations.includes(request.operationId))return s;if(request.revision!==s.revision)throw Error('別の画面で更新されています。読み込み直してください。');
 const charge=()=>{if(s.balance<1)throw Error('ライフが足りません。');s.balance--;};
 if(request.action==='enter'){let n=request.levelId;if(!Number.isInteger(n)||n<1||n>this.levels.length)throw Error('ステージがありません。');if(n>s.unlocked)throw Error('前のステージをクリアしてください。');charge();s.attempt=this.pack(new this.Engine(this.levels[n-1]),request.operationId);}
 else if(request.action==='refill-demo'){s.balance+=5;}
 else{if(!s.attempt||request.attemptId!==s.attempt.id)throw Error('参加中のステージが変わりました。');if(request.revision!==s.revision)throw Error('別の画面で更新されています。読み込み直してください。');let g=this.engine(s.attempt);if(g.won)throw Error('クリア済みです。次のステージに参加してください。');
 if(request.action==='move'){let d=request.direction;if(!Array.isArray(d)||d.length!==2||![[1,0],[-1,0],[0,1],[0,-1]].some(x=>x[0]===d[0]&&x[1]===d[1]))throw Error('移動方向が正しくありません。');if(!g.move(...d))return s;}
 else if(request.action==='undo'){if(!g.history.length)throw Error('戻せる手がありません。');charge();g.undo();}
 else if(request.action==='restart'){charge();g=new this.Engine(this.levels[s.attempt.levelId-1]);}
 else throw Error('対応していない操作です。');
 if(g.won){let old=s.clears[g.id];s.clears[g.id]={moves:Math.min(old?.moves??Infinity,g.moves),stars:Math.max(old?.stars??0,g.collected)};s.unlocked=Math.max(s.unlocked,Math.min(this.levels.length,g.id+1));}s.attempt=this.pack(g,s.attempt.id);}
 s.revision++;s.appliedOperations.push(request.operationId);s.appliedOperations=s.appliedOperations.slice(-200);return s;}
 async transact(request){let run=()=>{let next=this.reduce(this.read(),request);this.storage.setItem(this.key,JSON.stringify(next));return next;};if(typeof window!=='undefined'&&typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request(this.key,run);return run();}
}
async function createGameBullAdapter(config,levels,Engine,storage){if(config.adapterMode==='demo')return new GameBullDemoAdapter(config,levels,Engine,storage);if(config.adapterMode==='host'&&typeof window!=='undefined'&&typeof window.GameBullAdapterFactory==='function')return window.GameBullAdapterFactory({companyId:config.companyId,levelSetVersion:config.levelSetVersion});throw Error('GameBull接続が設定されていません。');}
if(typeof module!=='undefined')module.exports={GameBullDemoAdapter,createGameBullAdapter};

