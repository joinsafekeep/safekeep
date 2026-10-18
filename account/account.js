const $=id=>document.getElementById(id);
let state, code=new URL(location.href).searchParams.get('code');
const recovery=new URL(location.href).searchParams.get('flow')==='recovery';
// Remove auth codes from the address bar before any further navigation.
if(location.search || location.hash) history.replaceState({},'',location.pathname);
const message=(text,error=false)=>{ $('status').textContent=text; $('status').classList.toggle('error',error); };
async function api(body) {
 const response=await fetch('/api/account',{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 if(!response.headers.get('content-type')?.includes('application/json')) throw new Error('The account service is not available yet. Please try again later.');
 const data=await response.json();
 if(!response.ok && !(response.status===401 && data.signed_in===false)) throw new Error(data.error || 'Please sign in again.');
 return data;
}
const fields=form=>Object.fromEntries(new FormData(form));
function fill(form,data){for(const [key,value] of Object.entries(data||{})){const input=form.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=Boolean(value);else input.value=value??'';}}}
async function refresh(){
 state=await api();
 $('signed-out').hidden=state.signed_in || !!code;
 $('signed-in').hidden=!state.signed_in || !!code;
 $('confirmation').hidden=!code;
 if(code){$('recovery-fields').hidden=!recovery;const input=$('confirm-form').elements.new_password;input.required=recovery;$('confirmation').querySelector('h2').textContent=recovery?'Choose a new password':'Confirm your email';return;}
 if(!state.signed_in){message('Sign in or create your Safekeep account.');return;}
 $('account-email').textContent=`Signed in as ${state.email}`;
 fill($('profile-form'),state.profile||{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});
 $('profile-form').elements.adult_confirmed.checked=!!state.profile?.adult_confirmed_at;
 fill($('preferences-form'),state.preferences);
 $('contacts').replaceChildren();
 for(const c of state.contacts){const li=document.createElement('li');li.textContent=`${c.label || c.kind}: ${c.normalized_value}${c.extension?' ext. '+c.extension:''} — ${c.verified_at?'Verified':'Not verified'}`;$('contacts').append(li);}
 const email=state.contacts.find(c=>c.kind==='email' && c.normalized_value===state.email.toLowerCase() && c.verified_at);
 const consent=state.consents.find(c=>c.contact_id===email?.id && c.channel==='email');
 $('consent-form').elements.consent.checked=consent?.action==='grant';
 $('consent-form').querySelector('button').disabled=!email;
 $('consent-state').textContent=consent?.action==='grant'?'Current choice: email practice consent granted.':'Current choice: no email practice consent.';
 message(state.profile?'Your account is ready to manage.':'Email verified. Please finish your profile.');
}
async function run(form,work){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{const result=await work();form?.reset();await refresh();message(result.message||'Saved.');}catch(error){message(error.message,true);}finally{buttons.forEach(b=>b.disabled=false);}}
const zones=Intl.supportedValuesOf?Intl.supportedValuesOf('timeZone'):['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','UTC'];
for(const zone of new Set([...zones,'UTC',Intl.DateTimeFormat().resolvedOptions().timeZone])){const option=document.createElement('option');option.value=zone;option.textContent=zone.replaceAll('_',' ');$('timezone').append(option);}
for(const action of ['signup','login','recover','resend','password'])$(action+'-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;const data=fields(form);if(action==='signup')data.adult_confirmed=form.elements.adult_confirmed.checked;run(form,()=>api({action,...data}));});
$('confirm-form').addEventListener('submit',event=>{event.preventDefault();run(event.currentTarget,async()=>{const result=await api({action:'confirm',code,...(recovery?{new_password:event.currentTarget.elements.new_password.value}:{})});code=null;return result;});});
for(const [id,action] of [['profile','profile'],['phone','add_phone'],['preferences','preferences']])$(id+'-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;const payload=fields(form);if(id==='profile')payload.adult_confirmed=form.elements.adult_confirmed.checked;if(id==='preferences')payload.practice_enabled=form.elements.practice_enabled.checked;run(null,()=>api({action,payload}));});
$('consent-form').addEventListener('submit',event=>{event.preventDefault();const contact=state.contacts.find(c=>c.kind==='email'&&c.normalized_value===state.email.toLowerCase()&&c.verified_at);if(!contact){message('Verify your email first.',true);return;}run(null,()=>api({action:'consent',payload:{contact_id:contact.id,channel:'email',action:event.currentTarget.elements.consent.checked?'grant':'revoke'}}));});
$('logout').addEventListener('click',()=>run(null,()=>api({action:'logout'})));
refresh().catch(error=>message(error.message,true));
