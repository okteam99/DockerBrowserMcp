export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const style = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151d;color:#e7edf5}*{box-sizing:border-box}[hidden]{display:none!important}body{max-width:1180px;margin:auto;padding:30px 20px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}h1{font-size:25px;margin:0}h2{font-size:19px}p{line-height:1.7;color:#aebdd0}a{color:#88bcff}button,input,select{font:inherit;border:1px solid #3b4a5f;border-radius:8px;padding:10px 14px;background:#202d3e;color:#e7edf5}button{cursor:pointer}button:hover{background:#30455e}input{width:100%;margin:12px 0}section{background:#18212e;border:1px solid #2a384c;border-radius:12px;padding:22px;margin:22px 0}pre{white-space:pre-wrap;word-break:break-word;background:#0c121b;padding:18px;border-radius:8px;font-size:13px;line-height:1.6;max-height:420px;overflow:auto}textarea{width:100%;min-height:300px;background:#0c121b;color:#dce8fa;border:1px solid #3b4a5f;padding:15px;border-radius:8px}small{color:#9eb0c6}.grid{display:grid;grid-template-columns:1fr 1.3fr;gap:22px}.panel{background:#0c121b;border-radius:10px;padding:16px;min-height:240px}#live{display:block;max-width:100%;max-height:480px;margin:10px auto;background:black}video{width:100%;max-height:480px;background:black}.row{border-bottom:1px solid #2a384c;padding:12px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row span{flex:1;font-size:13px;word-break:break-all}.status{color:#8cdeb9}nav{margin:20px 0;display:flex;gap:15px}.login{max-width:420px;margin:12vh auto}#message{color:#ffd38a}@media(max-width:760px){.grid{grid-template-columns:1fr}}`;
const wrap = (title: string, content: string, script = '') =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${style}</style><body>${content}${script ? `<script>${script}</script>` : ''}</body></html>`;
export function loginPage(base: string, error = '') {
  return wrap(
    'DockerBrowserMcp · 登录',
    `<main class="login"><h1>DockerBrowserMcp</h1><p>远程浏览器 · MCP 接入 · 直播与录屏</p><section><h2>输入部署时设置的访问密码</h2><form method="post" action="${escapeHtml(base)}/login"><input name="password" type="password" required autocomplete="current-password" aria-label="访问密码"><button type="submit">登录</button></form><p id="message">${escapeHtml(error)}</p></section></main>`,
  );
}
export function dashboard(base: string, nonce: string) {
  return wrap(
    'DockerBrowserMcp',
    `<header><div><h1>DockerBrowserMcp</h1><p>浏览器由 Agent 操作，你可以在这里查看使用说明和执行过程。</p></div><form method="post" action="${escapeHtml(base)}/logout"><input type="hidden" name="csrf" value="${nonce}"><button>退出</button></form></header><nav><a href="#connect">接入 Agent</a><a href="#instances">实时实例</a><a href="#history">历史录屏</a><a href="${escapeHtml(base)}/docs/README.md">完整使用文档</a><a href="${escapeHtml(base)}/docs/mcp-api.md">MCP 接口</a></nav><p id="message" role="status"></p><section id="connect"><h2>复制给 Agent 即可开始</h2><p>以下内容包含服务地址、鉴权 Token、连接配置和操作约定。仅分享给你信任的 Agent。</p><button id="copy-guide">复制完整 Agent 接入说明</button> <button id="copy-config">复制 MCP 配置</button><pre id="config">正在加载接入配置…</pre><details><summary>查看完整 Agent 接入说明</summary><textarea id="guide" readonly aria-label="Agent 接入说明"></textarea></details></section><section id="instances"><h2>实时实例 <small id="capacity"></small></h2><p>低帧率直播展示当前活动标签页。切换页面后自动跟随；直播只供查看。</p><div class="grid"><div id="active" class="panel">暂无活跃实例</div><div class="panel"><small id="watch-title">选择实例查看直播</small><img id="live" hidden alt="浏览器实例直播"></div></div></section><section id="history"><h2>历史录屏</h2><p>实例关闭后生成 WebM 录像；刷新页面或重启服务后仍可查看，保留时间由部署配置决定。</p><div id="records">正在加载…</div><video id="replay" controls playsinline hidden></video></section>`,
    `
const BASE=${JSON.stringify(base)};
const $=id=>document.getElementById(id);
let connection,watching,recordSignature;
async function api(path){const r=await fetch(BASE+path,{cache:'no-store'});if(r.status===401){location.href=BASE+'/';throw Error('请重新登录');}if(!r.ok)throw Error('请求失败');return r.json();}
function tell(text){$('message').textContent=text;}
async function copy(text){try{await navigator.clipboard.writeText(text);tell('已复制');}catch{const area=document.createElement('textarea');area.value=text;document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();tell(ok?'已复制':'浏览器未允许复制，请从下方文本框手动复制');}}
$('copy-guide').onclick=()=>connection&&copy(connection.agent_instructions);
$('copy-config').onclick=()=>connection&&copy(JSON.stringify(connection.mcp_config,null,2));
function watch(id){watching=id;$('live').hidden=false;$('live').src=BASE+'/api/instances/'+encodeURIComponent(id)+'/live';$('watch-title').textContent=id;}
async function refresh(){try{
 const data=await api('/api/instances');$('capacity').textContent='（'+data.instances.length+' / '+data.max_instances+'）';
 $('active').replaceChildren();if(!data.instances.length)$('active').textContent='暂无活跃实例。让 Agent 创建实例后将在此出现。';
 for(const item of data.instances){const row=document.createElement('div');row.className='row';const text=document.createElement('span');text.textContent=item.instance_id+' · '+item.status+' · '+item.viewport.width+'×'+item.viewport.height;row.append(text);const btn=document.createElement('button');btn.textContent=watching===item.instance_id?'正在观看':'观看';btn.onclick=()=>watch(item.instance_id);row.append(btn);$('active').append(row);}
 if(watching&&!data.instances.some(x=>x.instance_id===watching)){watching=undefined;$('live').removeAttribute('src');$('live').hidden=true;$('watch-title').textContent='实例已结束，可在历史录屏查看';}
 const history=await api('/api/recordings');const signature=JSON.stringify(history);if(signature!==recordSignature){recordSignature=signature;$('records').replaceChildren();if(!history.length)$('records').textContent='暂无录屏';for(const rec of history){const row=document.createElement('div');row.className='row';const text=document.createElement('span');text.textContent=rec.instance_id+' · '+new Date(rec.created_at).toLocaleString()+' · '+rec.status+' · '+rec.frames+' 帧';row.append(text);if(rec.bytes>0&&rec.status!=='recording'){const play=document.createElement('button');play.textContent='播放';play.onclick=()=>{$('replay').hidden=false;$('replay').src=BASE+'/api/recordings/'+encodeURIComponent(rec.id)+'/video';$('replay').play().catch(()=>{});};row.append(play);} $('records').append(row);}}
 }catch(e){tell(e.message);}}
api('/api/connection').then(data=>{connection=data;$('config').textContent=JSON.stringify(data.mcp_config,null,2);$('guide').value=data.agent_instructions;}).catch(e=>tell(e.message));
refresh();setInterval(refresh,3000);
`,
  );
}
