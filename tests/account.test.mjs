import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHandler,checkPassword} from '../netlify/functions/account.mjs';
const origin='https://joinsafekeep.com';
const request=(body,customOrigin=origin)=>new Request(origin+'/api/account',body?{method:'POST',headers:{origin:customOrigin,'content-type':'application/json'},body:JSON.stringify(body)}:{});
function setup(overrides={}) {
 const calls=[];
 const client={auth:{getUser:async()=>({data:{user:{id:'user-a',email:'a@example.com',email_confirmed_at:'2026-01-01'}}}),...overrides},rpc:async(name,args)=>{calls.push({name,args});return {data:{saved:true},error:null};}};
 let options;
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:(_url,_key,opts)=>{options=opts;return client;}});
 return {handler,calls,get options(){return options;}};
}
test('password policy enforces bounds without trimming passwords',()=>{
 assert.throws(()=>checkPassword('short'));assert.throws(()=>checkPassword('a'.repeat(129)));assert.equal(checkPassword('a'.repeat(12)),'a'.repeat(12));
});
test('cross-origin and missing-origin writes are rejected before authentication',async()=>{
 const s=setup();assert.equal((await s.handler(request({action:'login'},'https://evil.example'))).status,403);assert.equal(s.options,undefined);
 const req=new Request(origin+'/api/account',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal((await s.handler(req)).status,403);
});
test('unverified accounts cannot access profiles or perform account actions',async()=>{
 const s=setup({getUser:async()=>({data:{user:{id:'a',email_confirmed_at:null}}})});
 assert.equal((await s.handler(request({action:'profile',payload:{first_name:'A'}}))).status,401);assert.equal(s.calls.length,0);
});
test('verified requests use database account action without trusting a supplied user ID',async()=>{
 const s=setup();const result=await s.handler(request({action:'consent',payload:{user_id:'victim',action:'grant',channel:'email',contact_id:'contact'}}));
 assert.equal(result.status,200);assert.equal(s.calls[0].name,'account_action');assert.equal(s.calls[0].args.action,'consent');
 assert.equal(s.options.cookieOptions.httpOnly,true);assert.equal(s.options.cookieOptions.secure,true);assert.equal(s.options.cookieOptions.sameSite,'lax');assert.equal(result.headers.get('cache-control'),'private, no-store');
});
test('login never returns session tokens in JSON and sets secure cookie options',async()=>{
 const s=setup({signInWithPassword:async()=>({data:{user:{id:'user-a',email_confirmed_at:'yes'},session:{access_token:'DO_NOT_EXPOSE'}}})});
 const response=await s.handler(request({action:'login',email:'a@example.com',password:'secret'}));assert.equal(response.status,200);assert.ok(!(await response.text()).includes('DO_NOT_EXPOSE'));
});
test('password change requires current-password reauthentication',async()=>{
 let updated=false;const s=setup({signInWithPassword:async()=>({error:{message:'bad'}}),updateUser:async()=>{updated=true;}});
 assert.equal((await s.handler(request({action:'password',current_password:'bad',new_password:'long enough password'}))).status,401);assert.equal(updated,false);
});
test('recovery confirmation changes password only for a recovery exchange',async()=>{
 let updated=false;
 const s=setup({exchangeCodeForSession:async()=>({data:{user:{email_confirmed_at:'yes'},redirectType:null}}),signOut:async()=>({}),updateUser:async()=>{updated=true;}});
 assert.equal((await s.handler(request({action:'confirm',code:'code',new_password:'long enough password'}))).status,400);assert.equal(updated,false);
});
test('successful password recovery revokes sessions after updating',async()=>{
 const order=[];const s=setup({exchangeCodeForSession:async()=>({data:{user:{email_confirmed_at:'yes'},redirectType:'recovery'}}),updateUser:async()=>{order.push('update');return {data:{}};},signOut:async({scope})=>{order.push(scope);return {data:{}};}});
 assert.equal((await s.handler(request({action:'confirm',code:'code',new_password:'long enough password'}))).status,200);assert.deepEqual(order,['update','global']);
});
test('reset requests hide account existence and provider errors',async()=>{
 const s=setup({resetPasswordForEmail:async()=>({error:{message:'not found'}})});const r=await s.handler(request({action:'recover',email:'nobody@example.com'}));assert.equal(r.status,200);assert.match((await r.json()).message,/If this account exists/);
});
test('session cookies retain security flags during refresh',async()=>{
 let options;
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:(_url,_key,opts)=>{
  options=opts;return {auth:{getUser:async()=>{
   options.cookies.setAll([{name:'__Host-safekeep-auth',value:'rotated',options:{secure:false,httpOnly:false}}]);
   return {data:{user:null}};
  }}};
 }});
 const response=await handler(request());
 const cookie=response.headers.get('set-cookie');
 assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/i);assert.match(cookie,/SameSite=Lax/i);assert.match(cookie,/Path=\//i);
 assert.equal(response.headers.get('cache-control'),'private, no-store');
});
