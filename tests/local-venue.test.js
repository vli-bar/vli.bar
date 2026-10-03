import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverLocalVenue, isLocalVenueHost} from '../src/local-venue.js';

test('public preview never probes the Internet or an invented local relay',async()=>{
  let requests=0;
  for (const origin of ['https://vli.bar','https://example.com','https://192.168.1.10.example.com']) {
    assert.equal(await discoverLocalVenue({origin,fetchImpl:()=>{requests++;throw new Error('unexpected request');}}),null);
  }
  assert.equal(requests,0);
  assert.equal(isLocalVenueHost('172.31.1.1'),true);
  assert.equal(isLocalVenueHost('172.32.1.1'),false);
  assert.equal(isLocalVenueHost('venue.local'),true);
});
test('venue configuration must come from the page origin and cannot redirect to a cloud relay',async()=>{
  const origin='https://192.168.1.10:8443';
  const fetchImpl=async(url,options)=>{
    assert.equal(url.href,origin+'/lan-config.json');assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({local:true,origin,protocol:1})};
  };
  assert.deepEqual(await discoverLocalVenue({origin,fetchImpl}),{origin});
  for(const config of [{local:true,origin:'https://vli.bar',protocol:1},{local:false,origin,protocol:1},{local:true,origin,protocol:2}]) {
    assert.equal(await discoverLocalVenue({origin,fetchImpl:async()=>({ok:true,json:async()=>config})}),null);
  }
});
test('missing or failed local server configuration leaves live joining disabled',async()=>{
  for (const fetchImpl of [async()=>({ok:false}),async()=>{throw new Error('offline');},async()=>({ok:true,json:async()=>{throw new Error('html');}})]) {
    assert.equal(await discoverLocalVenue({origin:'http://localhost:8080',fetchImpl}),null);
  }
});
