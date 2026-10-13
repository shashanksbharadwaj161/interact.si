import { timingSafeEqual } from 'node:crypto';
export function equal(a,b) {if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function redact(value, secrets=[]) {
  let str=typeof value==='string'?value:JSON.stringify(value);
  for(const secret of secrets) if(secret) str=str.split(secret).join('[REDACTED]');
  return str.replace(/sk-ant-[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/sk-or-v1-[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/(bearer\s+)[\w.-]+/gi,'$1[REDACTED]');
}
export function gate(port, token) {
  const origin=`http://127.0.0.1:${port}`;
  return (req,res,next)=>{
    if(req.headers.host!==`127.0.0.1:${port}`) return res.status(403).json({error:'Untrusted host'});
    if(req.headers.origin && req.headers.origin!==origin) return res.status(403).json({error:'Cross-origin access denied'});
    if(['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) return res.status(403).json({error:'Cross-site access denied'});
    const bearer=req.headers.authorization?.replace(/^Bearer /,'');
    const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('controlroom='))?.slice(12);
    if(req.path==='/') {res.cookie('controlroom',token,{httpOnly:true,sameSite:'strict'}); return next();}
    if(req.path.startsWith('/api/')) {
      if(!equal(bearer,token) && !equal(cookie,token)) return res.status(401).json({error:'Open the dashboard to establish a local session'});
      if(!['GET','HEAD'].includes(req.method) && !equal(bearer,token) && !equal(req.headers['x-control-token'],token)) return res.status(403).json({error:'Missing request token'});
    }
    next();
  };
}
