import { createServer, request } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../server/index.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dist=resolve(root,'dist');
if(!existsSync(resolve(dist,'release.json')))throw new Error('请先运行 npm run build');
const release=JSON.parse(readFileSync(resolve(dist,'release.json'),'utf8'));
const bridge=createBridge();
bridge.server.on('error',error=>{console.error('Codex bridge: '+error.message);process.exitCode=1;web.close();});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.wasm':'application/wasm','.webmanifest':'application/manifest+json','.png':'image/png','.woff2':'font/woff2'};
const web=createServer((req,res)=>{
  const host=req.headers.host;
  if(!['127.0.0.1:4318','localhost:4318'].includes(host)){res.writeHead(403).end('Local access only');return;}
  let path;try{path=decodeURIComponent(new URL(req.url,'http://127.0.0.1:4318').pathname);}catch{res.writeHead(400).end();return;}
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  if(path.startsWith('/api/')){
    const upstream=request({hostname:'127.0.0.1',port:4319,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:4319'}},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'本机 Codex 服务不可用，请重新启动听澜。'}));});
    res.on('close',()=>upstream.destroy());req.pipe(upstream);return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
  if(path==='/__health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:true,...release,root}));return;}
  const file=resolve(dist,'.'+(path==='/'?'/index.html':path));
  if(!file.startsWith(dist+sep)||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found');return;}
  const type=types[extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'Content-Length':statSync(file).size,'Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});
  if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
});
web.headersTimeout=10000;web.requestTimeout=300000;
web.on('error',error=>{console.error('Website: '+error.message);bridge.close();process.exitCode=1;});
await bridge.listen();
web.listen(4318,'127.0.0.1',()=>console.log('Tinglan '+release.version+' '+release.commit+' at http://127.0.0.1:4318/'));
const close=()=>{web.close();bridge.close();};
process.on('SIGINT',close);process.on('SIGTERM',close);
