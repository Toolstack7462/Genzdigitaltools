// Minimal SPA static server: serves frontend/build and falls back to index.html.
const http=require('http'),fs=require('fs'),path=require('path'),url=require('url');
const ROOT=path.resolve(process.argv[2]), PORT=Number(process.argv[3]||4178);
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.map':'application/json','.zip':'application/zip','.txt':'text/plain'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(url.parse(req.url).pathname);
  let f=path.join(ROOT,p);
  f=path.resolve(f);
  if(!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()) f=path.join(ROOT,'index.html');
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});
  fs.createReadStream(f).pipe(res);
}).listen(PORT,()=>console.log('serving '+ROOT+' on '+PORT));
