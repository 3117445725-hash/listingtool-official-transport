import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {createRelay} from './relay.mjs';
// Off by default. Acceptance and existing production gates precede any enablement.
const relay = createRelay({publishEnabled:process.env.ENABLE_SIGNED_FORWARDING === '1'});
createServer(async (req,res) => {
  try {
    const options = {method:req.method, headers:req.headers};
    if (!['GET','HEAD'].includes(req.method)) { options.body=Readable.toWeb(req); options.duplex='half'; }
    const result = await relay(new Request('https://relay.invalid' + req.url, options));
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch { res.writeHead(400); res.end('invalid request'); }
}).listen(Number(process.env.PORT || 8080),'0.0.0.0');
