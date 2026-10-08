import test from "node:test";
import assert from "node:assert/strict";
import { createEnrollmentClient, EnrollmentError } from "../src/enrollment.mjs";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { once } from "node:events";

const secret="test-long-private-enrollment-service-key";
function config(env={}) {return loadConfig({ADAPTER_SERVICE_TOKEN:secret,META_GRAPH_VERSION:"v23.0",META_ACCESS_TOKEN:"private-meta-token",EVOLUTION_BASE_URL:"https://evolution.example",EVOLUTION_API_KEY:"private-evolution-key",...env});}
async function withApi(c,fn,overrides={}){
 const srv=createApp(c,overrides);srv.listen(0,"127.0.0.1");await once(srv,"listening");
 try{await fn("http://127.0.0.1:"+srv.address().port);} finally{srv.close();await once(srv,"close");}
}
test("enrollment endpoint requires service key and defaults to effects OFF",async()=>{
 await withApi(config(),async base=>{
  let r=await fetch(base+"/internal/v1/whatsapp/enrollment/health");
  assert.equal(r.status,401);
  r=await fetch(base+"/internal/v1/whatsapp/enrollment/health",{headers:{"x-enrollment-service-key":secret}});
  assert.equal(r.status,200);assert.equal((await r.json()).enrollment_enabled,false);
  r=await fetch(base+"/internal/v1/whatsapp/enrollment/execute",{method:"POST",headers:{"content-type":"application/json","x-enrollment-service-key":secret},body:JSON.stringify({action:"meta.request-code",input:{phone_number_id:"123456",method:"SMS",language:"en_US"}})});
  assert.equal(r.status,423);assert.equal((await r.json()).error.code,"provider_enrollment_disabled");
 });
});
test("Meta code request, verification and registration have exact fields and redact tokens",async()=>{
 const calls=[];
 const mocked=async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>({success:true})};};
 const client=createEnrollmentClient(config({PROVIDER_ENROLLMENT_ENABLED:"true"}),mocked);
 const params={phone_number_id:"12345678901"};
 assert.deepEqual(await client.execute("meta.request-code",{...params,method:"SMS",language:"en_US"}),{accepted:true});
 assert.deepEqual(await client.execute("meta.verify-code",{...params,code:"123456"}),{accepted:true});
 assert.deepEqual(await client.execute("meta.register",{...params,pin:"654321"}),{accepted:true});
 assert.deepEqual(calls.map(x=>new URL(x.url).pathname),["/v23.0/12345678901/request_code","/v23.0/12345678901/verify_code","/v23.0/12345678901/register"]);
 assert.deepEqual(calls.map(x=>JSON.parse(x.init.body)),[{code_method:"SMS",language:"en_US"},{code:"123456"},{messaging_product:"whatsapp",pin:"654321"}]);
 assert.equal(calls[0].init.headers.authorization,"Bearer private-meta-token");
 assert.ok(!JSON.stringify(await client.execute("meta.request-code",{...params,method:"VOICE",language:"en_US"})).includes("private-meta"));
});
test("Evolution instance create, QR and state normalize responses without leaking keys",async()=>{
 const calls=[];
 const mocked=async(url,init)=>{
   calls.push({url,init});
   if(url.endsWith("/instance/create"))return {ok:true,json:async()=>({instance:{instanceName:"sales-dominicana"},hash:{apikey:"never-expose"}})};
   if(url.includes("/instance/connect/"))return {ok:true,json:async()=>({base64:"data:image/png;base64,"+"A".repeat(220),code:"private-pair-token"})};
   return {ok:true,json:async()=>({instance:{state:"open"},apikey:"never-expose"})};
 };
 const client=createEnrollmentClient(config({PROVIDER_ENROLLMENT_ENABLED:"true"}),mocked);
 const input={instance_name:"sales-dominicana"};
 assert.equal((await client.execute("evolution.create",input)).created,true);
 const qr=await client.execute("evolution.qr",input);
 assert.ok(qr.qr_image.startsWith("data:image/png;base64,"));
 assert.equal((await client.execute("evolution.status",input)).state,"open");
 assert.deepEqual(calls.map(x=>new URL(x.url).pathname),["/instance/create","/instance/connect/sales-dominicana","/instance/connectionState/sales-dominicana"]);
 assert.equal(calls[0].init.headers.apikey,"private-evolution-key");
 assert.equal(JSON.stringify(qr).includes("private-pair-token"),false);
});
test("reject invalid user controlled IDs and never fetch when enrollment disabled",async()=>{
 let calls=0;const client=createEnrollmentClient(config(),async()=>{calls++;throw Error("never");});
 await assert.rejects(client.execute("meta.register",{phone_number_id:"12345",pin:"12"}),e=>e.code==="invalid_registration_pin");
 await assert.rejects(client.execute("evolution.qr",{instance_name:"http://169.254.169.254"}),e=>e.code==="invalid_instance_name");
 await assert.rejects(client.execute("meta.request-code",{phone_number_id:"123456",method:"SMS",language:"en_US"}),e=>e.code==="provider_enrollment_disabled");
 assert.equal(calls,0);
});

test("bare base64 image from Evolution is normalized for QR display",async()=>{
 const client=createEnrollmentClient(config({PROVIDER_ENROLLMENT_ENABLED:"true"}),async()=>({ok:true,json:async()=>({base64:"B".repeat(180)})}));
 const qr=await client.execute("evolution.qr",{instance_name:"test-instance"});
 assert.equal(qr.qr_image,"data:image/png;base64,"+"B".repeat(180));
});
