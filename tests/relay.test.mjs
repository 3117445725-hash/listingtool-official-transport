import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRelay,ORIGIN,VERSION,PUBLISH,LIMIT} from '../relay.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
const address=p=>'https://owned-relay.example'+p;
function signed(body=Buffer.from('patch')) {
  const query=new URLSearchParams({patch_version:'R254-v1',app_version:'R254',notes:'locked candidate'});
  const headers={'content-type':'application/zip','x-listingtool-key-id':'test','x-listingtool-timestamp':'1',
    'x-listingtool-nonce':'nonce','x-listingtool-sha256':digest(body),'x-listingtool-size':String(body.length),
    'x-listingtool-notes-sha256':digest('locked candidate'),'x-listingtool-signature':'test-signature'};
  return new Request(address(PUBLISH+'?'+query),{method:'POST',headers,body});
}
test('health and default-off POST never call upstream',async()=>{
  let calls=0;const relay=createRelay({fetchImpl:async()=>{calls++;throw Error();}});
  assert.equal((await relay(signed())).status,503);
  assert.equal((await (await relay(new Request(address('/health')))).json()).publish_enabled,false);
  assert.equal(calls,0);
});
test('official GET exact bytes and credentials never forwarded',async()=>{
  const body=Buffer.from('immutable bytes');let call;
  const relay=createRelay({fetchImpl:async(...args)=>{call=args;return new Response(body,{headers:{'set-cookie':'secret'}});}});
  const response=await relay(new Request(address(VERSION),{headers:{'x-extra-secret':'private'}}));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
  assert.equal(call[0],ORIGIN+VERSION);assert.equal(call[1].redirect,'manual');
  assert.equal(call[1].headers.has('x-extra-secret'),false);assert.equal(response.headers.has('set-cookie'),false);
});
test('credentials, foreign target query, traversal and inventory routes stop before network',async()=>{
  let count=0; const relay=createRelay({fetchImpl:async()=>{count++;return new Response('bad');}});
  for(const path of ['/api/inventory/submit',VERSION+'?target=https://evil.example','/api/v1/code-update/download/a/b','/api/v1/code-update/download/%2e%2e','/anything'])
    assert.equal((await relay(new Request(address(path)))).status,404);
  for(const header of ['cookie','authorization','proxy-authorization','x-listingtool-signature'])
    assert.equal((await relay(new Request(address(VERSION),{headers:{[header]:'private'}}))).status,400);
  assert.equal(count,0);
});
test('only exact signed query/body forwarded once without secrets or signature changes',async()=>{
  let calls=[];const relay=createRelay({publishEnabled:true,fetchImpl:async(...x)=>{calls.push(x);return Response.json({ok:true});}});
  const req=signed();const signature=req.headers.get('x-listingtool-signature');
  assert.equal((await relay(req)).status,200);assert.equal(calls.length,1);
  assert.ok(calls[0][0].startsWith(ORIGIN+PUBLISH+'?'));
  assert.equal(calls[0][1].headers.get('x-listingtool-signature'),signature);
  assert.equal(digest(calls[0][1].body),digest('patch'));
});
test('damaged body, notes, missing headers and extra query rejected before publish',async()=>{
  let count=0;const relay=createRelay({publishEnabled:true,fetchImpl:async()=>{count++;return new Response('bad');}});
  for(const variant of ['body','notes','header','query']) {
    const valid=signed();const headers=new Headers(valid.headers);let url=valid.url;let body=await valid.arrayBuffer();
    if(variant==='body')body=Buffer.from('other');
    if(variant==='notes')url=url.replace('locked+candidate','damaged');
    if(variant==='header')headers.delete('x-listingtool-signature');
    if(variant==='query')url+='&target=evil';
    assert.equal((await relay(new Request(url,{method:'POST',headers,body}))).status,400);
  }assert.equal(count,0);
});
test('upstream redirects cannot move signed request to another origin',async()=>{
  let count=0;const relay=createRelay({publishEnabled:true,fetchImpl:async()=>{count++;return new Response(null,{status:307,headers:{location:'https://evil.example'}});}});
  assert.equal((await relay(signed())).status,502);assert.equal(count,1);
});
test('late POST failure is unresolved and never automatically retried',async()=>{
  let count=0;const relay=createRelay({publishEnabled:true,fetchImpl:async()=>{count++;throw Error('late timeout');}});
  const response=await relay(signed());assert.equal(response.status,502);
  assert.match((await response.json()).error,/unresolved.*reconciliation/);assert.equal(count,1);
});
test('bounded stream closes on oversized upstream download',async()=>{
  let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(LIMIT+1));},cancel(){cancelled=true;}});
  const relay=createRelay({fetchImpl:async()=>new Response(stream)});
  assert.equal((await relay(new Request(address(VERSION)))).status,502);assert.equal(cancelled,true);
});
test('immutable ranges return exact bytes and identity without forwarding Range upstream',async()=>{
  const body=Buffer.from('immutable file');let call;
  const relay=createRelay({fetchImpl:async(...x)=>{call=x;return new Response(body);}});
  const response=await relay(new Request(address('/api/v1/code-update/download/R254'),{headers:{Range:'bytes=2-6'}}));
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 2-6/14');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),body.subarray(2,7));assert.equal(call[1].headers.has('range'),false);
});
test('invalid, oversized or out-of-file ranges fail closed',async()=>{
  const relay=createRelay({fetchImpl:async()=>new Response(new Uint8Array(200*1024))});
  for(const range of ['bytes=0-','bytes=10-2','bytes=0-200000','bytes=204800-204801'])
    assert.equal((await relay(new Request(address('/api/v1/code-update/download/R254'),{headers:{Range:range}}))).status,416);
});
