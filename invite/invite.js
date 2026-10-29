const $=id=>document.getElementById(id);
// The token stays in memory only; the address bar loses it before anything else loads.
const token=new URL(location.href).searchParams.get('t')||'';
if(location.search)history.replaceState({},'',location.pathname);
let invitation=null,email='';
const message=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
const show=(...ids)=>{for(const id of ['gone','about','accept-signed-in','create','code','decline','done'])$(id).hidden=!ids.includes(id);};
async function call(url,body){
 const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Safekeep isn’t available right now. Please try again in a few minutes.');
 const data=await response.json();
 if(!response.ok&&!(response.status===401&&data.signed_in===false))throw new Error(data.error||'Something went wrong. Please try again.');
 return data;
}
const account=body=>call('/api/account',body);
async function busy(form,work){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await work();}catch(error){message(error.message,true);}finally{buttons.forEach(b=>b.disabled=false);}}
async function accept(){
 message('Accepting your invitation…');
 await account({action:'accept_invitation',payload:{token}});
 show('done');$('done-title').textContent='Welcome to Safekeep';$('done-copy').textContent='Taking you to your account, where you choose how you’d like to practise…';
 message('You’re in.');setTimeout(()=>location.assign('/account/?welcome=1'),900);
}
async function start(){
 if(!/^[0-9a-f]{64}$/.test(token)){show('gone');message('This link is missing its invitation.',true);return;}
 const found=await call('/api/invites?t='+token);
 if(!found.found){show('gone');message('This invitation can’t be used any more.',true);return;}
 invitation=found.invitation;email=invitation.invitee_email;
 $('title').textContent=`${invitation.sponsor_name} has given you Safekeep`;
 for(const id of ['sponsor-inline','sponsor-decline'])$(id).textContent=invitation.sponsor_name;
 if(invitation.personal_note){$('note').textContent=invitation.personal_note;$('note-wrap').hidden=false;}
 $('signup-form').elements.first_name.value=invitation.invitee_name||'';$('signup-form').elements.email.value=email;$('login-form').elements.email.value=email;$('code-email').textContent=email;
 // Already signed in with the invited address: one button.
 const state=await account().catch(()=>({signed_in:false}));
 if(state.signed_in&&state.email?.toLowerCase()===email.toLowerCase()){show('about','accept-signed-in','decline');$('signed-in-as').textContent=`Signed in as ${state.email}.`;message('Your invitation is ready.');return;}
 show('about','create','decline');
 message(state.signed_in?`You’re signed in as ${state.email}, but this invitation is for ${email}. Create an account for that address, or sign in with it below.`:'Your invitation is ready.');
}
$('signup-form').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;if(!f.reportValidity())return;busy(f,async()=>{
 await account({action:'signup',email,password:f.elements.password.value,first_name:f.elements.first_name.value,adult_confirmed:f.elements.adult_confirmed.checked,terms_accepted:f.elements.terms_accepted.checked,website:f.elements.website.value,intent:{invite_token:token}});
 f.elements.password.value='';show('about','code');message('Check your email for the 6-digit code.');$('code-form').elements.code.focus();
});});
$('code-form').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;if(!f.reportValidity())return;busy(f,async()=>{await account({action:'verify_code',email,code:f.elements.code.value});await accept();});});
$('resend').addEventListener('click',()=>busy(null,async()=>{const r=await account({action:'resend',email});message(r.message||'Sent.');}));
$('login-form').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;busy(f,async()=>{await account({action:'login',email:f.elements.email.value,password:f.elements.password.value});await accept();});});
$('accept-form').addEventListener('submit',event=>{event.preventDefault();busy(event.currentTarget,accept);});
$('decline-form').addEventListener('submit',event=>{event.preventDefault();busy(event.currentTarget,async()=>{const r=await call('/api/invites',{action:'decline',token});show('done');$('done-title').textContent='Thank you for letting us know';$('done-copy').textContent=r.message;message('Done.');});});
start().catch(error=>{show('gone');message(error.message,true);});
