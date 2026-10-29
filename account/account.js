const $=id=>document.getElementById(id);
const params=new URL(location.href).searchParams;
let state, code=params.get('code');
const recovery=params.get('flow')==='recovery';
// Returning from Stripe. The Payment Link redirect is not proof of payment; the billing phase confirms it by webhook.
const checkoutReturn=params.get('checkout')==='success';
// Remove auth codes from the address bar before any further navigation.
if(location.search || location.hash) history.replaceState({},'',location.pathname);
const message=(text,error=false)=>{ $('status').textContent=text; $('status').classList.toggle('error',error); };
const track=event=>{try{if(window.gtag)window.gtag('event','signup_'+event,{event_category:'signup'});}catch{}};
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
 const currentTerms=(state.acceptances||[]).some(a=>a.document==='terms'&&a.version===state.policy_version);
 $('terms-section').hidden=currentTerms;
 // A plan chosen in the dialog before signing in, not yet on the account.
 const remembered=storedIntent();
 if(!state.intent?.plan && remembered?.plan && remembered?.billing){try{await api({action:'intent',payload:remembered});sessionStorage.removeItem('safekeep-intent');state=await api();}catch{}}
 const intent=state.intent||{};
 const hasProfile=!!state.profile;
 // Step 1 after verification: the profile. It is the only form between verification and payment.
 fill($('profile-form'),state.profile||{first_name:state.signup?.first_name||'',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});
 const attested=!!state.profile?.adult_confirmed_at || !!state.signup?.adult_confirmed;
 $('profile-form').elements.adult_confirmed.checked=attested;$('profile-form').elements.adult_confirmed.required=!attested;$('adult-check').hidden=attested&&!state.profile;
 $('profile-intro').hidden=hasProfile;$('profile-save').textContent=hasProfile?'Save profile':'Save and continue';
 // Step 2: checkout, shown once the profile exists. One line naming the plan, or the picker when there is none.
 const paid=!!intent.checkout_started_at;
 const showCheckout=hasProfile&&!paid&&!!intent.plan&&!!intent.billing;
 $('checkout-section').hidden=!showCheckout;
 if(showCheckout)$('checkout-summary').textContent=planLine(intent);
 $('plan-section').hidden=!(hasProfile&&!paid&&!showCheckout);
 for(const input of $('plan-form').querySelectorAll('input[type=radio]'))if(intent[input.name]===input.value)input.checked=true;
 // After payment: the next step depends on who the plan is for.
 $('paid-section').hidden=!(hasProfile&&paid);
 if(hasProfile&&paid){
  $('paid-title').textContent=checkoutReturn?'Thank you for subscribing':'Your plan';
  $('paid-copy').textContent=(checkoutReturn?'Stripe will email your receipt. ':'')+planLine(intent)+' Your subscription will appear here once payment confirmation is connected. To cancel or update your card, use Manage subscription at the bottom of any Safekeep page.';
  const forOther=intent.help_for==='other';
  $('invite-next').hidden=!forOther;$('self-next').hidden=forOther;
  if(forOther){$('invitee-name').textContent=intent.invitee_name||'them';$('invitee-details').replaceChildren(...[['Name',intent.invitee_name],['Email',intent.invitee_email],['Phone',intent.invitee_phone]].filter(([,v])=>v).map(([k,v])=>{const li=document.createElement('li');li.textContent=`${k}: ${v}`;return li;}));}
 }
 // The profile form leads only until it is saved; after that it lives with the other settings, below the one
 // thing the person came to do (checkout, or what comes after payment).
 $('settings').classList.toggle('later',hasProfile);
 if(hasProfile)$('settings').prepend($('profile-section'));else $('terms-section').after($('profile-section'));
 if(checkoutReturn&&!paid)track('checkout_returned');
 $('contacts').replaceChildren();
 for(const c of state.contacts){const li=document.createElement('li');li.textContent=`${c.label || c.kind}: ${c.normalized_value}${c.extension?' ext. '+c.extension:''} — ${c.verified_at?'Verified':'Not verified'}`;$('contacts').append(li);}
 fill($('preferences-form'),state.preferences);
 const email=state.contacts.find(c=>c.kind==='email' && c.normalized_value===state.email.toLowerCase() && c.verified_at);
 const consent=state.consents.find(c=>c.contact_id===email?.id && c.channel==='email');
 $('consent-form').elements.consent.checked=consent?.action==='grant';
 $('consent-form').querySelector('button').disabled=!email;
 $('consent-state').textContent=consent?.action==='grant'?'Current choice: email practice consent granted.':'Current choice: no email practice consent.';
 message(!hasProfile?'Email verified. One more step before payment: finish your profile.':paid?(checkoutReturn?'Thank you. Your account is ready.':'Your account is ready to manage.'):'Your profile is saved. Choose your plan to continue to payment.');
}
async function run(form,work){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{const result=await work();form?.reset();await refresh();message(result.message||'Saved.');}catch(error){message(error.message,true);}finally{buttons.forEach(b=>b.disabled=false);}}
const zones=Intl.supportedValuesOf?Intl.supportedValuesOf('timeZone'):['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','UTC'];
for(const zone of new Set([...zones,'UTC',Intl.DateTimeFormat().resolvedOptions().timeZone])){const option=document.createElement('option');option.value=zone;option.textContent=zone.replaceAll('_',' ');$('timezone').append(option);}
for(const action of ['signup','login','recover','resend','password'])$(action+'-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;const data=fields(form);if(action==='signup'){data.adult_confirmed=form.elements.adult_confirmed.checked;data.terms_accepted=form.elements.terms_accepted.checked;const remembered=storedIntent();if(remembered)data.intent=remembered;}run(form,()=>api({action,...data}));});
$('code-form').addEventListener('submit',event=>{event.preventDefault();const data=fields(event.currentTarget);run(event.currentTarget,async()=>{const result=await api({action:'verify_code',...data});track('verified');return result;});});
$('confirm-form').addEventListener('submit',event=>{event.preventDefault();run(event.currentTarget,async()=>{const result=await api({action:'confirm',code,...(recovery?{new_password:event.currentTarget.elements.new_password.value}:{})});code=null;if(!recovery)track('verified');return result;});});
$('terms-form').addEventListener('submit',event=>{event.preventDefault();run(null,()=>api({action:'accept_policies',payload:{source:(state.acceptances||[]).length?'reprompt':'signup'}}));});
for(const [id,action] of [['profile','profile'],['phone','add_phone'],['preferences','preferences']])$(id+'-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const payload=fields(form);if(id==='profile')payload.adult_confirmed=form.elements.adult_confirmed.checked;if(id==='preferences')payload.practice_enabled=form.elements.practice_enabled.checked;const firstSave=id==='profile'&&!state.profile;await run(null,()=>api({action,payload}));
 // First profile save in the sponsor path: move straight on to the plan.
 if(firstSave&&state.profile){const next=!$('checkout-section').hidden?$('checkout-section'):!$('plan-section').hidden?$('plan-section'):null;if(next){message('Your profile is saved. Continue to payment when you’re ready.');window.scrollTo({top:0});next.querySelector('h2').setAttribute('tabindex','-1');next.querySelector('h2').focus({preventScroll:true});}}});
$('consent-form').addEventListener('submit',event=>{event.preventDefault();const contact=state.contacts.find(c=>c.kind==='email'&&c.normalized_value===state.email.toLowerCase()&&c.verified_at);if(!contact){message('Verify your email first.',true);return;}run(null,()=>api({action:'consent',payload:{contact_id:contact.id,channel:'email',action:event.currentTarget.elements.consent.checked?'grant':'revoke'}}));});
// Checkout: the server returns the Stripe URL for the chosen plan, keyed to this account.
async function startCheckout(payload){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{message('Opening secure payment…');const result=await api({action:'checkout',payload});track('checkout_started');location.href=result.url;}catch(error){message(error.message,true);buttons.forEach(b=>b.disabled=false);}}
$('checkout-form').addEventListener('submit',event=>{event.preventDefault();startCheckout({});});
$('change-plan').addEventListener('click',()=>{$('checkout-section').hidden=true;$('plan-section').hidden=false;$('plan-section').scrollIntoView({behavior:'smooth',block:'start'});});
$('plan-form').addEventListener('submit',event=>{event.preventDefault();if(!event.currentTarget.reportValidity())return;startCheckout(fields(event.currentTarget));});
$('logout').addEventListener('click',()=>run(null,()=>api({action:'logout'})));
refresh().catch(error=>message(error.message,true));
