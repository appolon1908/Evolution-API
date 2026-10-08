import { timingSafeEqual } from "node:crypto";

export class EnrollmentError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
export function sameSecret(actual,expected) {
  const a=Buffer.from(String(actual??"")),b=Buffer.from(String(expected??""));
  return b.length>=24&&a.length===b.length&&timingSafeEqual(a,b);
}
export const validDigits=(value)=>typeof value==="string"&&/^\d{5,32}$/.test(value);
export const validInstance=(value)=>typeof value==="string"&&/^[a-z0-9][a-z0-9_-]{2,62}$/.test(value);
function allowUrl(value) {
  let u;
  try{u=new URL(value);}catch{throw new EnrollmentError("provider_url_not_configured",503);}
  if(u.protocol!=="https:"&&!(u.protocol==="http:"&&["127.0.0.1","localhost"].includes(u.hostname)))
    throw new EnrollmentError("provider_https_required",503);
  if(u.username||u.password||u.search||u.hash)throw new EnrollmentError("provider_url_invalid",503);
  return u;
}
function validateResponse(obj) {
  if(!obj||typeof obj!=="object"||Array.isArray(obj))throw new EnrollmentError("provider_response_invalid",502);
  return obj;
}
export function createEnrollmentClient(config,fetcher=fetch) {
  const enabled=config.enrollmentEnabled===true;
  function ensureEnabled(){if(!enabled)throw new EnrollmentError("provider_enrollment_disabled",423);}
  async function send(url,token,method,body,style) {
    if(!token)throw new EnrollmentError("provider_credentials_missing",503);
    const headers={accept:"application/json",...(style==="meta"?{authorization:"Bearer "+token}:{apikey:token})};
    if(method==="POST")headers["content-type"]="application/json";
    let response;
    try{
      response=await fetcher(url.toString(),{method,headers,...(method==="POST"?{body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(9000)});
    }catch{throw new EnrollmentError("provider_unreachable",502);}
    if(!response.ok)throw new EnrollmentError("provider_operation_failed",502);
    let data;try{data=await response.json();}catch{throw new EnrollmentError("provider_response_invalid",502);}
    return validateResponse(data);
  }
  function graph(id,endpoint) {
    if(!validDigits(id))throw new EnrollmentError("invalid_meta_resource_id");
    const version=config.metaGraphVersion;
    if(!/^v\d+\.\d+$/.test(String(version||"")))throw new EnrollmentError("meta_graph_version_missing",503);
    return new URL("https://graph.facebook.com/"+version+"/"+id+"/"+endpoint);
  }
  function evo(path) {
    const root=allowUrl(config.evolutionBaseUrl);
    if(root.pathname!=="/"&&root.pathname!=="")throw new EnrollmentError("provider_base_path_invalid",503);
    return new URL(path,root);
  }
  async function execute(action,input={}) {
    const args=validateResponse(input);
    const metaId=args.phone_number_id;
    if(action==="meta.phone-numbers"){
      if(!validDigits(args.waba_id))throw new EnrollmentError("invalid_waba_id");
      ensureEnabled();
      const info=await send(graph(args.waba_id,"phone_numbers"),config.metaAccessToken,"GET",null,"meta");
      return {numbers:(Array.isArray(info.data)?info.data:[]).slice(0,100).map(x=>({id:String(x.id||""),display_phone_number:String(x.display_phone_number||""),verified_name:String(x.verified_name||""),quality_rating:String(x.quality_rating||"")}))};
    }
    if(["meta.request-code","meta.verify-code","meta.register"].includes(action)){
      if(!validDigits(metaId))throw new EnrollmentError("invalid_phone_number_id");
      if(action==="meta.request-code"&&(!["SMS","VOICE"].includes(args.method)|| !/^[a-z]{2}_[A-Z]{2}$/.test(String(args.language||""))))
        throw new EnrollmentError("invalid_verification_method");
      if(action==="meta.verify-code"&&!/^\d{4,8}$/.test(String(args.code||"")))throw new EnrollmentError("invalid_verification_code");
      if(action==="meta.register"&&!/^\d{6}$/.test(String(args.pin||"")))throw new EnrollmentError("invalid_registration_pin");
      ensureEnabled();
      const endpoint={"meta.request-code":"request_code","meta.verify-code":"verify_code","meta.register":"register"}[action];
      const body=action==="meta.request-code"?{code_method:args.method,language:args.language}:action==="meta.verify-code"?{code:args.code}:{messaging_product:"whatsapp",pin:args.pin};
      const info=await send(graph(metaId,endpoint),config.metaAccessToken,"POST",body,"meta");
      return {accepted:info.success===true||info.success==="true"};
    }
    if(action==="evolution.create"){
      if(!validInstance(args.instance_name))throw new EnrollmentError("invalid_instance_name");
      ensureEnabled();
      const info=await send(evo("/instance/create"),config.evolutionApiKey,"POST",{instanceName:args.instance_name,qrcode:true,integration:"WHATSAPP-BAILEYS"},"evolution");
      return {created:Boolean(info.instance||info.instanceName||info.hash),instance_name:args.instance_name};
    }
    if(action==="evolution.qr"){
      if(!validInstance(args.instance_name))throw new EnrollmentError("invalid_instance_name");
      ensureEnabled();
      const info=await send(evo("/instance/connect/"+encodeURIComponent(args.instance_name)),config.evolutionApiKey,"GET",null,"evolution");
      const code=info.base64||info.qrcode?.base64||info.qrcode?.base64Img||"";
      // Return image only, never the raw pairing secret or upstream apikey.
      return {instance_name:args.instance_name,qr_image:typeof code==="string"&&/^data:image\/png;base64,[A-Za-z0-9+/=]{100,400000}$/.test(code)?code:null,state:"awaiting_scan"};
    }
    if(action==="evolution.status"){
      if(!validInstance(args.instance_name))throw new EnrollmentError("invalid_instance_name");
      // Even a read requires configured credentials and private service auth.
      const info=await send(evo("/instance/connectionState/"+encodeURIComponent(args.instance_name)),config.evolutionApiKey,"GET",null,"evolution");
      const state=String(info.instance?.state||info.state||"unknown");
      return {instance_name:args.instance_name,state:["open","close","connecting","refused"].includes(state)?state:"unknown"};
    }
    throw new EnrollmentError("unknown_enrollment_action",404);
  }
  return {execute};
}
