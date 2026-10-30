import { renderCoaching } from '/practice/coaching.js';
import { participantReport, monthName } from '/practice/report.js';
const $=id=>document.getElementById(id);
const params=new URL(location.href).searchParams;
let state, code=params.get('code');
const recovery=params.get('flow')==='recovery';
// Returning from Stripe. The redirect is not proof of payment; until the billing phase confirms it by webhook,
// the page thanks the person and keeps the payment button available in case they didn't finish.
const checkoutReturn=params.get('checkout')==='success';
const welcome=params.get('welcome')==='1';
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
const PLAN_NAMES={individual:'Individual',pairs:'Pairs',family:'Family'};
const LIVE=['trialing','active','past_due'];
const longDate=iso=>iso?new Date(iso).toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'}):'';
async function billingApi(path,body){const response=await fetch('/api/billing/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{}),cache:'no-store'});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Please try again.');return data;}
// The plan chosen in the marketing dialog is kept in session storage for the sign-in path (the dialog cannot tell
// whether an address is already registered, so it sends those people here).
function storedIntent(){try{const raw=sessionStorage.getItem('safekeep-intent');return raw?JSON.parse(raw):null;}catch{return null;}}
function planLine(intent){const plan=state.plans?.[intent.plan];if(!plan||!intent.billing)return '';return `${PLAN_NAMES[intent.plan]} plan for up to ${plan.seats===1?'one person':plan.seats+' people'}, billed ${intent.billing==='annual'?'annually':'monthly'}: ${plan[intent.billing]}.`;}
async function refresh(){
 state=await api();
 $('signed-out').hidden=state.signed_in || !!code;
 $('signed-in').hidden=!state.signed_in || !!code;
 $('confirmation').hidden=!code;
 if(code){$('recovery-fields').hidden=!recovery;const input=$('confirm-form').elements.new_password;input.required=recovery;$('confirmation').querySelector('h2').textContent=recovery?'Choose a new password':'Confirm your email';return;}
 if(!state.signed_in){message('Sign in or create your Safekeep account.');if(storedIntent()?.plan)$('code-details').open=true;return;}
 $('account-email').textContent=`Signed in as ${state.email}`;
 // Terms: anyone whose latest acceptance is older than the current version is asked again before anything else.
 const accepted=doc=>(state.acceptances||[]).some(a=>a.document===doc&&a.version===state.policy_version);
 const termsCurrent=accepted('terms')&&accepted('privacy');
 $('terms-section').hidden=termsCurrent;
 // A plan chosen in the dialog, carried here in session storage for the sign-in path. It wins when it is newer
 // than what the account already holds, and is cleared once posted.
 const remembered=storedIntent();
 if(remembered?.plan&&remembered?.billing&&(!state.intent?.plan||(remembered.saved_at||'')>(state.intent.updated_at||''))){try{await api({action:'intent',payload:remembered});state=await api();}catch{}}
 try{sessionStorage.removeItem('safekeep-intent');}catch{}
 const intent=state.intent||{};
 const hasProfile=!!state.profile;
 // Step 1 after verification: the profile. It is the only form between verification and payment.
 fill($('profile-form'),state.profile||{first_name:state.signup?.first_name||'',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});
 const attested=!!state.profile?.adult_confirmed_at || !!state.signup?.adult_confirmed;
 $('profile-form').elements.adult_confirmed.checked=attested;$('profile-form').elements.adult_confirmed.required=!attested;$('adult-check').hidden=attested&&!state.profile;
 $('profile-intro').hidden=hasProfile;$('profile-save').textContent=hasProfile?'Save profile':'Save and continue';
 // Step 2: checkout, shown once the profile exists and the terms are current. One line naming the plan, or the
 // picker when there is none. There is no subscription record yet, so the button stays until billing can confirm.
 const ready=hasProfile&&termsCurrent;
 // The plan, once Stripe has told us about it. Live plans replace the checkout card; ended plans show what
 // stopped and when, with the picker underneath to start again.
 const sub=state.subscription,live=!!sub&&LIVE.includes(sub.status);
 $('subscription-section').hidden=!sub;
 if(sub){
  const name=sub.plan?PLAN_NAMES[sub.plan]+' plan':'Your plan',seats=sub.seats_used!=null?` ${sub.seats_used} of ${sub.seats} ${sub.seats===1?'seat':'seats'} in use.`:'';
  if(!live)$('subscription-summary').textContent=`${name} ended on ${longDate(sub.ended_at||sub.canceled_at||sub.updated_at)}. Practice has stopped for everyone who was on it.`;
  else if(sub.status==='past_due')$('subscription-summary').textContent=`${name}: the latest payment didn’t go through. Stripe will try again over the next few days; practice pauses after seven days past due. Update your card with Manage subscription.`;
  else if(sub.cancel_at)$('subscription-summary').textContent=`${name}, billed ${sub.billing==='annual'?'annually':'monthly'}, is set to end on ${longDate(sub.cancel_at)}. Practice continues until then.`;
  else $('subscription-summary').textContent=`${name}, billed ${sub.billing==='annual'?'annually':'monthly'}.${sub.current_period_end?` Next payment on ${longDate(sub.current_period_end)}.`:''}`;
  $('subscription-detail').textContent=(live?seats:'')+(sub.refunded_at?` Refunded on ${longDate(sub.refunded_at)}.`:'')+(!live?' Choose a plan below to start again.':'');
  $('portal-form').hidden=!state.billing_portal;
 }
 // Seats: who is on the plan (first name and channel names only), invitations still out, and the invite form.
 renderSeats(live,intent);
 const membership=state.membership;
 $('membership-section').hidden=!membership;
 if(membership){const ends=membership.cancel_at?` It is set to end on ${longDate(membership.cancel_at)}.`:LIVE.includes(membership.status)?'':` That plan has ended, so practice has stopped.`;$('membership-summary').textContent=`You’re on ${membership.sponsor_name}’s ${membership.plan?PLAN_NAMES[membership.plan]+' plan':'plan'}.${ends}`;}
 const showCheckout=ready&&!live&&!!intent.plan&&!!intent.billing;
 $('checkout-section').hidden=!showCheckout;
 if(showCheckout){$('checkout-summary').textContent=planLine(intent);$('checkout-button').textContent=checkoutReturn||intent.checkout_started_at?'Continue to payment (if you didn’t finish)':'Continue to payment';}
 $('plan-section').hidden=!(ready&&!live&&!showCheckout);
 for(const input of $('plan-form').querySelectorAll('input[type=radio]'))if(intent[input.name]===input.value)input.checked=true;
 // Back from Stripe: thank them, say what's next, and leave the payment button in place.
 $('paid-section').hidden=!(ready&&checkoutReturn);
 if(ready&&checkoutReturn){
  $('paid-title').textContent='Thank you for subscribing';
  $('paid-copy').textContent='Stripe will email your receipt. '+(live?'Your plan is active.':planLine(intent)+' It can take a minute for Stripe to confirm the payment; reload this page shortly. If the payment didn’t go through, the button below is still there.');
  const forOther=intent.help_for==='other';
  $('invite-next').hidden=!forOther;$('self-next').hidden=forOther;
  if(forOther)$('invitee-name').textContent=intent.invitee_name||'them';
 }
 // The profile form leads only until it is saved; after that it lives with the other settings, below the one
 // thing the person came to do.
 $('settings').classList.toggle('later',hasProfile);
 if(hasProfile)$('settings').prepend($('profile-section'));else $('terms-section').after($('profile-section'));
 // Practice consent is not offered before payment on the sponsor path. Until a subscription record exists this is
 // a page-level guard: the section appears after the return from Stripe, or once any consent choice exists.
 const hasConsent=(state.consents||[]).length>0;
 $('practice-section').hidden=!(live||(membership&&LIVE.includes(membership.status))||checkoutReturn||hasConsent||!!state.preferences?.practice_enabled);
 // Nothing else is offered while the terms need accepting.
 for(const id of ['checkout-section','plan-section','paid-section','subscription-section','seats-section','membership-section','settings'])if(!termsCurrent)$(id).hidden=true;
 // Pending deletion: one banner, one button to keep the account; everything else waits.
 const deletion=state.deletion;
 $('deletion-section').hidden=!deletion;
 if(deletion){$('deletion-copy').textContent=`You asked us to delete your account. Practice has stopped and your consents are withdrawn. The account and its history will be erased on ${new Date(deletion.delete_after).toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'})} unless you choose to keep it.`;for(const id of ['checkout-section','plan-section','paid-section','subscription-section','seats-section','membership-section','settings'])$(id).hidden=true;}
 renderContacts();
 renderChannels();
 renderHistory(termsCurrent&&!deletion);
 const prefs=state.preferences||{};
 fill($('preferences-form'),{max_practices_per_week:1,email_cap_per_month:4,text_cap_per_month:4,call_cap_per_month:2,quiet_hours_start:'20:00',quiet_hours_end:'09:00',alerts_opt_in:false,...prefs,paused_until:prefs.paused_until||''});
 $('preferences-form').elements.practice_enabled.checked=!!prefs.practice_enabled;
 for(const el of document.querySelectorAll('[data-cap]')){const key={email:'email_cap_per_month',text:'text_cap_per_month',call:'call_cap_per_month'}[el.dataset.cap];el.textContent=prefs[key]??el.textContent;}
 $('preferences-form').elements.paused_until.min=new Date().toISOString().slice(0,10);
 // Family: who pays, and who reads the report.
 $('sponsor-line').textContent=intent.help_for==='other'?'You pay for this plan. The people you invite will see this page for their own account.':'You pay for your own plan. When someone else sponsors your practice, their name will show here.';
 $('recipients').replaceChildren(...(state.report_recipients||[]).map(r=>{const li=document.createElement('li');const span=document.createElement('span');span.textContent=`${r.name} — ${r.email}`;const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Remove';remove.onclick=()=>run(null,()=>api({action:'remove_report_recipient',payload:{recipient_id:r.id}}));li.append(span,remove);return li;}));
 $('recipient-form').querySelector('button').disabled=(state.report_recipients||[]).length>=5;
 message(deletion?'Your account is set to be deleted. Choose "Keep my account" to stay.':!termsCurrent?'Please accept the current terms to continue.':!hasProfile?'Email verified. One more step before payment: finish your profile.':checkoutReturn?'Thank you. Your account is ready.':welcome&&membership?`Welcome. You’re on ${membership.sponsor_name}’s plan. Choose how you’d like to practise below.`:live||membership?'Your account is ready to manage.':sub?'Your plan has ended. Choose a plan to start again.':intent.checkout_started_at?'Your account is ready to manage.':'Your profile is saved. Choose your plan to continue to payment.');
}
async function run(form,work){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{const result=await work();form?.reset();await refresh();message(result.message||'Saved.');}catch(error){message(error.message,true);}finally{buttons.forEach(b=>b.disabled=false);}}
const zones=Intl.supportedValuesOf?Intl.supportedValuesOf('timeZone'):['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','UTC'];
for(const zone of new Set([...zones,'UTC',Intl.DateTimeFormat().resolvedOptions().timeZone])){const option=document.createElement('option');option.value=zone;option.textContent=zone.replaceAll('_',' ');$('timezone').append(option);}
// Cloudflare Turnstile on the standalone sign-up form, when data-turnstile-site-key is set on it (the CSP for
// /account/* allows challenges.cloudflare.com). The dialog on the marketing pages has its own copy of this.
let turnstileToken='';
(function(){const form=$('signup-form'),key=form.dataset.turnstileSiteKey,slot=$('turnstile');if(!key||!slot)return;
 window.onSafekeepTurnstile=()=>window.turnstile.render(slot,{sitekey:key,callback:t=>{turnstileToken=t;},'expired-callback':()=>{turnstileToken='';},'error-callback':()=>{turnstileToken='';}});
 const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSafekeepTurnstile';script.async=true;script.defer=true;document.head.append(script);})();
for(const action of ['signup','login','recover','resend','password'])$(action+'-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;const data=fields(form);
 if(action==='signup'){data.adult_confirmed=form.elements.adult_confirmed.checked;data.terms_accepted=form.elements.terms_accepted.checked;const remembered=storedIntent();if(remembered)data.intent=remembered;if(form.dataset.turnstileSiteKey){if(!turnstileToken){message('Please complete the security check, then select Create account.',true);return;}data.turnstile_token=turnstileToken;}}
 run(form,()=>api({action,...data}));});
$('code-form').addEventListener('submit',event=>{event.preventDefault();const data=fields(event.currentTarget);run(event.currentTarget,()=>api({action:'verify_code',...data}));});
$('confirm-form').addEventListener('submit',async event=>{event.preventDefault();const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{const result=await api({action:'confirm',code,...(recovery?{new_password:event.currentTarget.elements.new_password.value}:{})});code=null;await refresh();message(result.message||'Saved.');}
 catch(error){
  // Usually the link was opened in another browser. Show the signed-out page with the code form open.
  code=null;try{await refresh();}catch{}
  if(!recovery){$('code-details').open=true;$('code-form').elements.email.focus({preventScroll:true});}
  message(error.message,true);
 }finally{buttons.forEach(b=>b.disabled=false);}});
$('terms-form').addEventListener('submit',event=>{event.preventDefault();run(null,()=>api({action:'accept_policies',payload:{source:'reprompt'}}));});
for(const [id,action] of [['profile','profile'],['phone','add_phone'],['preferences','preferences']])$(id+'-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const payload=fields(form);if(id==='profile')payload.adult_confirmed=form.elements.adult_confirmed.checked;if(id==='preferences'){payload.practice_enabled=form.elements.practice_enabled.checked;payload.alerts_opt_in=form.elements.alerts_opt_in.checked;for(const k of ['max_practices_per_week','email_cap_per_month','text_cap_per_month','call_cap_per_month'])payload[k]=Number(payload[k]);if(!payload.paused_until)payload.paused_until=null;}const firstSave=id==='profile'&&!state.profile;await run(id==='phone'?form:null,()=>api({action,payload}));
 // First profile save in the sponsor path: move straight on to the plan.
 if(firstSave&&state.profile){const next=!$('checkout-section').hidden?$('checkout-section'):!$('plan-section').hidden?$('plan-section'):null;if(next){message('Your profile is saved. Continue to payment when you’re ready.');window.scrollTo({top:0});next.querySelector('h2').setAttribute('tabindex','-1');next.querySelector('h2').focus({preventScroll:true});}}});
// --- Contacts: verification by code (text to a cell, automated call to a landline) and removal.
const latestConsent=(contactId,channel)=>(state.consents||[]).find(c=>c.contact_id===contactId&&c.channel===channel);
const phoneLabel=c=>`${c.label||{mobile:'Cell',home:'Home',office:'Office',other:'Other'}[c.kind]||c.kind}: ${c.normalized_value}${c.extension?' ext. '+c.extension:''}`;
let verifying=null; // contact id whose code form is open
function renderContacts(){
 $('contacts').replaceChildren(...state.contacts.filter(c=>!c.suppressed_at).map(c=>{
  const li=document.createElement('li');const span=document.createElement('span');
  const status=document.createElement('span');status.className=c.verified_at?'verified':'unverified';status.textContent=c.verified_at?'Verified':'Not verified';
  span.textContent=(c.kind==='email'?'Email: ':'')+(c.kind==='email'?c.normalized_value:phoneLabel(c))+' — ';span.append(status);li.append(span);
  if(c.kind!=='email'){
   if(!c.verified_at&&state.phone_verification){const b=document.createElement('button');b.type='button';b.textContent=verifying===c.id?'Send a new code':(c.kind==='mobile'?'Text me a code':'Call me with a code');b.onclick=()=>startVerification(c);li.append(b);}
   if(!c.verified_at&&!state.phone_verification){const note=document.createElement('small');note.textContent='Phone verification opens soon.';li.append(note);}
   const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Remove';remove.onclick=()=>{if(confirm('Remove this number? Any text or call practice to it stops.'))run(null,()=>api({action:'remove_phone',payload:{contact_id:c.id}}));};li.append(remove);
   if(verifying===c.id){const form=document.createElement('form');form.innerHTML='<label>6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{4,12}" maxlength="12" required></label><button>Verify</button>';form.onsubmit=e=>{e.preventDefault();run(form,async()=>{const r=await api({action:'phone_verify_check',payload:{contact_id:c.id,code:form.elements.code.value}});verifying=null;return r;});};li.append(form);setTimeout(()=>form.elements.code.focus({preventScroll:true}),0);}
  }
  return li;}));
}
async function startVerification(contact){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{const r=await api({action:'phone_verify_start',payload:{contact_id:contact.id}});verifying=contact.id;renderContacts();message(r.message||'Code sent.');}catch(error){message(error.message,true);}finally{buttons.forEach(b=>b.disabled=false);}}
// --- Channels: one consent per channel on one verified contact; on = grant, off = revoke.
function renderChannels(){
 const email=state.contacts.find(c=>c.kind==='email'&&c.normalized_value===state.email.toLowerCase()&&c.verified_at);
 const emailConsent=email&&latestConsent(email.id,'email');
 $('channel-email-target').textContent=email?`Practice emails would go to ${email.normalized_value}.`:'Verify your login email first.';
 $('channel-email-form').elements.on.checked=emailConsent?.action==='grant';$('channel-email-form').querySelector('button').disabled=!email;
 $('channel-email-state').textContent=emailConsent?.action==='grant'?'Email practice is on.':'Email practice is off.';
 for(const [channel,kinds] of [['text',['mobile']],['phone',['mobile','home','office','other']]]){
  const form=$(`channel-${channel}-form`),select=form.elements.contact_id;
  const options=state.contacts.filter(c=>kinds.includes(c.kind)&&c.verified_at&&!c.suppressed_at);
  const current=options.find(c=>latestConsent(c.id,channel)?.action==='grant')||options[0];
  select.replaceChildren(...options.map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=phoneLabel(c);o.selected=c===current;return o;}));
  select.disabled=!options.length;form.querySelector('button').disabled=!options.length;
  $(`channel-${channel}-note`).textContent=options.length?'':(channel==='text'?'Add and verify a cell number above to practice by text.':'Add and verify a phone number above to practice by phone.');
  const on=current&&latestConsent(current.id,channel)?.action==='grant';
  form.elements.on.checked=!!on;$(`channel-${channel}-state`).textContent=on?`${channel==='text'?'Text':'Call'} practice is on.`:`${channel==='text'?'Text':'Call'} practice is off.`;
 }
}
$('channel-email-form').addEventListener('submit',event=>{event.preventDefault();const contact=state.contacts.find(c=>c.kind==='email'&&c.normalized_value===state.email.toLowerCase()&&c.verified_at);if(!contact){message('Verify your email first.',true);return;}run(null,()=>api({action:'consent',payload:{contact_id:contact.id,channel:'email',action:event.currentTarget.elements.on.checked?'grant':'revoke'}}));});
for(const channel of ['text','phone'])$(`channel-${channel}-form`).addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;const contactId=form.elements.contact_id.value;if(!contactId)return;
 // Switching numbers while on: withdraw the old one's grant first so only one number per channel is live.
 run(null,async()=>{const on=form.elements.on.checked;for(const c of state.contacts){const latest=latestConsent(c.id,channel);if(latest?.action==='grant'&&(c.id!==contactId||!on))await api({action:'consent',payload:{contact_id:c.id,channel,action:'revoke'}});}
  if(on&&latestConsent(contactId,channel)?.action!=='grant')return api({action:'consent',payload:{contact_id:contactId,channel,action:'grant'}});return {message:'Saved.'};});});
// --- Family, data, deletion.
$('recipient-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;run(form,()=>api({action:'add_report_recipient',payload:fields(form)}));});
$('export-form').addEventListener('submit',async event=>{event.preventDefault();const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{const data=await api({action:'export'});const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`safekeep-export-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);message('Your data file is downloading.');}catch(error){message(error.message,true);}finally{buttons.forEach(b=>b.disabled=false);}});
$('delete-form').addEventListener('submit',event=>{event.preventDefault();if(!event.currentTarget.reportValidity())return;run(event.currentTarget,async()=>{const r=await api({action:'request_deletion'});await refresh();return r;});});
$('keep-form').addEventListener('submit',event=>{event.preventDefault();run(null,async()=>{await api({action:'cancel_deletion'});return {message:'Your account is staying. Turn practice channels back on whenever you’re ready.'};});});
// Checkout: the server returns the Stripe URL for the chosen plan, keyed to this account.
async function startCheckout(payload){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{message('Opening secure payment…');const result=await api({action:'checkout',payload});location.href=result.url;}catch(error){message(error.message,true);buttons.forEach(b=>b.disabled=false);}}
$('checkout-form').addEventListener('submit',event=>{event.preventDefault();startCheckout({});});
$('change-plan').addEventListener('click',()=>{$('checkout-section').hidden=true;$('plan-section').hidden=false;$('plan-section').scrollIntoView({behavior:'smooth',block:'start'});});
$('plan-form').addEventListener('submit',event=>{event.preventDefault();if(!event.currentTarget.reportValidity())return;startCheckout(fields(event.currentTarget));});
const CHANNEL_NAMES={email:'email',text:'text',phone:'phone calls'};
function renderSeats(live,intent){
 const sub=state.subscription;$('seats-section').hidden=!live;if(!live)return;
 const seats=state.seats||[],used=seats.length,total=sub.seats||1;
 $('seats-summary').textContent=`${used} of ${total} ${total===1?'seat':'seats'} in use.`;
 $('seats').replaceChildren(...seats.map(seat=>{
  const li=document.createElement('li'),span=document.createElement('span');
  if(seat.kind==='participant'){const ch=(seat.channels||[]).map(c=>CHANNEL_NAMES[c]||c);span.textContent=`${seat.name}: ${ch.length?'practising by '+ch.join(' and '):'joined, hasn’t chosen how to practise yet'}${seat.status==='paused'?' (paused)':''}`;li.append(span);
   const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent='Remove';b.onclick=()=>{if(confirm(`Take ${seat.name} off your plan? Their practice stops and we’ll tell them by email.`))run(null,()=>api({action:'remove_participant',payload:{member_id:seat.id}}));};li.append(b);}
  else{span.textContent=`${seat.name} (${seat.email}): invited, waiting for an answer until ${longDate(seat.expires_at)}`;li.append(span);
   const r=document.createElement('button');r.type='button';r.className='secondary';r.textContent='Resend';r.onclick=()=>run(null,()=>api({action:'resend_invite',payload:{invitation_id:seat.id}}));
   const c=document.createElement('button');c.type='button';c.className='secondary';c.textContent='Cancel invitation';c.onclick=()=>{if(confirm(`Cancel ${seat.name}’s invitation? The link we sent will stop working.`))run(null,()=>api({action:'revoke_invite',payload:{invitation_id:seat.id}}));};li.append(r,c);}
  return li;}));
 const free=used<total;
 $('invite-form').hidden=!free;$('join-form').hidden=!(free&&!state.practising);
 // First visit after paying for someone else: their details from the sign-up dialog are ready to send.
 const f=$('invite-form');if(free&&intent.help_for==='other'&&!f.dataset.prefilled&&!seats.some(s=>s.email&&s.email===intent.invitee_email)){f.dataset.prefilled='1';fill(f,{invitee_name:intent.invitee_name||'',invitee_email:intent.invitee_email||'',invitee_phone:intent.invitee_phone||''});}
}
$('invite-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;run(form,()=>api({action:'invite',payload:fields(form)}));});
$('join-form').addEventListener('submit',event=>{event.preventDefault();run(null,()=>api({action:'join_own_plan'}));});
$('portal-form').addEventListener('submit',async event=>{event.preventDefault();const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{message('Opening your subscription in Stripe…');const r=await billingApi('portal');location.href=r.url;}catch(error){message(error.message,true);buttons.forEach(b=>b.disabled=false);}});
$('leave-form').addEventListener('submit',event=>{event.preventDefault();if(!confirm('Leave this plan? Your practice stops right away and the person paying is told.'))return;run(null,async()=>{await api({action:'leave_subscription'});return {message:'You’ve left the plan. Practice has stopped, and your account is still yours.'};});});
// --- Practice history and "Was this Safekeep?". Outcomes use the words the participant sees everywhere else.
const OUTCOMES={reported:'Spotted it',declined:'Spotted it',engaged:'Practice opportunity',completed:'Practice opportunity',no_observed_engagement:'Ignored it',inconclusive:'No result'};
const CHANNEL_LABEL={email:'Email',text:'Text',phone:'Call'};
function showCoaching(c){
 const panel=$('coaching-panel');
 renderCoaching(panel,c,{answer:async choice=>(await api({action:'practice_answer',payload:{practice_id:c.practice_id,choice}})).result,share:async details=>(await api({action:'practice_share',payload:{practice_id:c.practice_id,...details}})).message});
 panel.scrollIntoView({behavior:'smooth',block:'start'});
}
function showReport(r){
 const {paragraphs,opportunities}=participantReport(r.metrics,{welcome:r.kind==='welcome'});
 const h=document.createElement('h4');h.textContent=r.kind==='welcome'?'How your first practices went':`${monthName(r.month)}`;
 const nodes=[h,...paragraphs.map(t=>{const p=document.createElement('p');p.textContent=t;return p;})];
 if(opportunities.length){const ul=document.createElement('ul');for(const o of opportunities){const li=document.createElement('li'),b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=`${o.name}: see what to look for`;b.onclick=async()=>{try{showCoaching((await api({action:'practice_view',payload:{practice_id:o.practice_id}})).result);}catch(error){message(error.message,true);}};li.append(b);ul.append(li);}nodes.push(ul);}
 $('report-panel').replaceChildren(...nodes);
}
function renderHistory(allowed){
 const history=state.practice_history||[];
 $('history-section').hidden=!allowed||!(state.practising||history.length||(state.reports||[]).length);
 $('history-empty').hidden=history.length>0;
 const reports=state.reports||[];
 $('reports-empty').hidden=reports.length>0;
 $('reports-list').replaceChildren(...reports.map(r=>{const li=document.createElement('li'),b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=r.kind==='welcome'?'Your first practices':monthName(r.month);b.onclick=()=>showReport(r);li.append(b);return li;}));
 if(location.hash==='#reports'&&reports[0]&&!$('report-panel').childElementCount)showReport(reports[0]);
 $('history').replaceChildren(...history.map(p=>{
  const li=document.createElement('li'),span=document.createElement('span');
  span.textContent=`${new Date(p.sent_at).toLocaleDateString(undefined,{month:'long',day:'numeric'})}, ${CHANNEL_LABEL[p.channel]||p.channel}: ${p.name}. ${OUTCOMES[p.result]||''}`;
  const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent='See what to look for';
  b.onclick=async()=>{try{showCoaching((await api({action:'practice_view',payload:{practice_id:p.practice_id}})).result);}catch(error){message(error.message,true);}};
  li.append(span,b);return li;}));
}
$('check-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,out=$('check-result'),button=form.querySelector('button');button.disabled=true;
 try{
  const {result}=await api({action:'was_this_safekeep',payload:fields(form)});
  if(result.ours){out.textContent='';showCoaching(result.coaching);}
  else{out.textContent='We didn’t send anything like that, so treat it as real. Don’t reply, click anything in it, or call a number it gives you. If it’s about your money, call the number on the back of your card. If you’d like a second opinion, show it to someone you trust.';$('coaching-panel').replaceChildren();}
 }catch(error){out.textContent=error.message;}finally{button.disabled=false;}});
$('logout').addEventListener('click',()=>run(null,()=>api({action:'logout'})));
// Back from Stripe: the webhook usually lands within seconds. Poll the account state for up to 40 seconds until the
// plan shows up, so the page can say "your plan is active" instead of asking the person to reload.
async function confirmCheckout(){
 for(let i=0;i<20;i++){
  if(state?.subscription&&LIVE.includes(state.subscription.status)){message('Thank you. Your plan is active.');return;}
  message('Confirming your payment with Stripe…');
  await new Promise(r=>setTimeout(r,2000));
  try{await refresh();}catch{}
 }
 if(!(state?.subscription&&LIVE.includes(state.subscription.status)))message('Stripe hasn’t confirmed the payment yet. It can take a few minutes; this page will show your plan once it does. If you didn’t finish paying, the button below is still there.');
}
refresh().then(()=>{if(checkoutReturn&&state?.signed_in)return confirmCheckout();}).catch(error=>message(error.message,true));
