const mobileLayout=window.matchMedia('(max-width: 750px)');
const campaignParams=new URLSearchParams(location.search);
let funnelSession;
try{funnelSession=sessionStorage.getItem('safekeep-session');if(!funnelSession){funnelSession=crypto.randomUUID();sessionStorage.setItem('safekeep-session',funnelSession)}}catch{funnelSession=crypto.randomUUID();}
const campaignAttribution={sessionId:funnelSession,audience:document.body.dataset.audience||'self',device:mobileLayout.matches?'mobile':'desktop',source:campaignParams.get('utm_source'),medium:campaignParams.get('utm_medium'),campaign:campaignParams.get('utm_campaign'),content:campaignParams.get('utm_content'),term:campaignParams.get('utm_term')};
// Signup details go to Formspree (static hosting has no /api backend); payment happens on Stripe.
const FORMSPREE_ENDPOINT='https://formspree.io/f/mbgdkpww';
function submitToFormspree(fields){const a=campaignAttribution;return fetch(FORMSPREE_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({_subject:'Safekeep signup: '+(fields.step||'signup'),...fields,page:location.pathname,device:a.device,sessionId:a.sessionId,utm_source:a.source,utm_medium:a.medium,utm_campaign:a.campaign,utm_content:a.content,utm_term:a.term})});}
function formspreeError(result,fallback){return (result&&result.errors&&result.errors[0]&&result.errors[0].message)||fallback;}
// Google Ads conversion ("Submit lead form") for a completed signup contact step (step 1); nothing is reported if the label is blank.
const GOOGLE_ADS_ID='AW-18507631033',GOOGLE_ADS_SIGNUP_LABEL='ryTyCOacx5kdELmTkPlE';
function signupConversion(){try{if(window.gtag&&GOOGLE_ADS_SIGNUP_LABEL)window.gtag('event','conversion',{send_to:GOOGLE_ADS_ID+'/'+GOOGLE_ADS_SIGNUP_LABEL,value:1.0,currency:'USD'});if(window.fbq)window.fbq('track','Lead');}catch{}}
// Funnel events go to the Google tag as custom events (page_view, form_open, then one per sign-up stage: contact, plan,
// account_created, verified). Checkout and payment events are reported from /account/, so the whole funnel is one series.
function trackFunnel(event){try{if(window.gtag)window.gtag('event','signup_'+event,{event_category:'signup',session_id:campaignAttribution.sessionId,non_interaction:event==='page_view'});}catch{}}
// Payment now happens from /account/ after the account is created and verified; the Stripe Payment Links live in
// netlify/functions/account.mjs (checkout action) until /api/billing/checkout replaces them.
async function accountApi(body){
 const response=await fetch('/api/account',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
 if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Accounts aren’t available right now. Please try again in a few minutes.');
 const data=await response.json();if(!response.ok)throw new Error(data.error||'Something went wrong. Please try again.');return data;
}
trackFunnel('page_view');
function toggleTextSize(){const active=document.documentElement.classList.toggle('large-text');const top=document.querySelector('#text-size');top.setAttribute('aria-pressed',active);top.querySelector('span').textContent=active?'Standard text':'Larger text';document.querySelector('[data-text-size]').textContent=active?'Use standard text':'Make text larger';}document.querySelector('#text-size').onclick=toggleTextSize;document.querySelector('[data-text-size]').onclick=toggleTextSize;
const modal=document.querySelector('#modal');function showModal(html){document.querySelector('#modal-content').innerHTML=html;modal.showModal()}modal.querySelector('.close').onclick=()=>modal.close();modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close()}});
document.querySelectorAll('[data-help]').forEach(b=>b.onclick=()=>showModal(`<div class="eyebrow">Your next step</div><h2>Start here.<br>You’re not alone.</h2><p>If you think something is wrong, stop communicating with the person. Don’t send more money or codes.</p><ol><li><strong>Paid money?</strong> Contact your bank or payment provider using a trusted number. Explain what happened and ask whether the payment can be reversed.</li><li><strong>Shared a password?</strong> Change it on the real website and anywhere you reused it. Turn on two-factor authentication.</li><li><strong>Shared personal information?</strong> Visit <a href="https://www.identitytheft.gov/" target="_blank" rel="noopener noreferrer">IdentityTheft.gov ↗</a> for a recovery plan.</li><li><strong>Talk to someone you trust.</strong> Save messages and receipts. Report the incident at <a href="https://reportfraud.ftc.gov/" target="_blank" rel="noopener noreferrer">ReportFraud.ftc.gov ↗</a>.</li></ol><p class="small">U.S. resources. For immediate physical danger, call 911. Money recovery is not guaranteed.</p><a href="https://consumer.ftc.gov/articles/what-do-if-you-were-scammed" target="_blank" rel="noopener noreferrer">Read the FTC’s full recovery guide ↗</a>`));
const familyStart=document.querySelector('#family-start');if(familyStart)familyStart.onclick=()=>showModal(`<div class="eyebrow">Start a conversation</div><h2>Try opening with this.</h2><div class="sample">“I found a few examples of the kinds of scams going around. Some are really convincing. Want to look at a few together?”</div><p>Ask first. Let them choose which examples to read. Compare what stood out to each of you, and agree on a familiar number to call if a request ever feels unusual.</p><p><strong>A simple family habit:</strong> check unexpected requests for money through a separate, trusted way of reaching each other.</p><button class="button" id="together">See the examples together <span>→</span></button>`);document.querySelector('#modal-content').addEventListener('click',e=>{if(e.target.closest('#together')){modal.close();document.querySelector('#examples').scrollIntoView();document.querySelector('#examples h2').setAttribute('tabindex','-1');document.querySelector('#examples h2').focus({preventScroll:true})}});
function showPrivacy(){showModal(`<div class="eyebrow">Your privacy</div><h2>About your details.</h2><p>If you sign up, we save your first name, email address, whether you want help for yourself or someone else, any first name, email, or phone number you optionally provide for that person, your optional phone number, the plan and billing period you choose, signup time, and the contact notice shown when you join using our form provider, Formspree, which stores them and emails them to the Safekeep team. Only the Safekeep team uses these details, to set up and run your subscription.</p><p>When you create an account, your email address, your password, and your acceptance of the Terms of Service and Privacy Policy are stored by our account provider, Supabase. Your password is never visible to the Safekeep team. Payments are handled by Stripe, which collects your card details on its own secure checkout page. Safekeep never sees your full card number. We’ll use your email to set up your subscription and send account updates. Signing up does not start automated calls or text messages until the participant consents. You can ask us to delete your details by replying to any Safekeep email.</p><p>Your submission also includes the campaign tags from the link you followed, your device category, and a random session identifier, so we can see which ads lead to signups. This site uses the Google tag to measure how our Google ads perform: Google receives information about your visit, and when you sign up we tell Google that a signup happened. We don’t send Google your name, email address, or phone number. This page does not add Meta or TikTok tracking pixels. Hosting providers may process ordinary request logs, and fonts load from Google Fonts.</p>`)}
document.querySelector('#privacy').onclick=showPrivacy;
document.querySelectorAll('[data-privacy]').forEach(b=>b.onclick=showPrivacy);



const waitlistDialog=document.querySelector('#waitlist-dialog');
const signupTitle=document.querySelector('#waitlist-title'),signupStatus=document.querySelector('#signup-status'),signupPrimary=document.querySelector('#signup-primary');
let signupStage='contact',savedSignup=null,signupFirstName='',signupPhone='',signupEmail='',helpFor=null,accountEmail='';
// What the dialog learned before account creation. It rides along on the signup call as the "intent" and is kept in
// session storage so /account/ can offer the same plan if the person signs in instead of creating an account.
const signupIntent={plan:null,billing:null,help_for:null,invitee_name:null,invitee_email:null,invitee_phone:null,lead_session_id:campaignAttribution.sessionId};
function rememberIntent(){try{sessionStorage.setItem('safekeep-intent',JSON.stringify({...signupIntent,saved_at:new Date().toISOString()}));}catch{}}
function showSignupStage(stage){
 signupStage=stage;signupStatus.textContent='';signupPrimary.disabled=false;
 const copy={contact:['','Your contact details','Start with your details. You’ll choose a plan next.','Continue','waitlist-form'],audience:['Optional','Who is the help for?','Your details are saved. Help us understand what you need.','Continue','audience-form'],recipient:['Optional',helpFor==='other'?'Their contact details':'Add your phone number',helpFor==='other'?'Tell us who you’d like scam help for.':'You left this blank earlier. Would you like to add it?' ,'Save details','recipient-form'],plan:['','Choose your plan','You can change or cancel your plan later.','Continue','plan-form'],account:['','Create your account','Choose a password to protect your account. You’ll pay after confirming your email.','Create account','account-form'],verify:['','Check your email','If '+accountEmail+' can be registered, a 6-digit code is on its way to it. Enter the code below, or open the link in that email on this phone. Already have an account with this address? Sign in instead.','Verify','verify-form'],complete:['You’re all set','Thank you for signing up','','Done',null]}[stage];
 const stepLabel=document.querySelector('#signup-step');stepLabel.textContent=copy[0];stepLabel.hidden=!copy[0];signupTitle.textContent=copy[1];const description=document.querySelector('#signup-description');description.textContent=copy[2];description.hidden=!copy[2];
 for(const [id,key] of [['waitlist-form','contact'],['audience-form','audience'],['recipient-form','recipient'],['plan-form','plan'],['account-form','account'],['verify-form','verify'],['signup-complete','complete']])document.getElementById(id).hidden=stage!==key;
 signupPrimary.textContent=copy[3];signupPrimary.type=copy[4]?'submit':'button';if(copy[4])signupPrimary.setAttribute('form',copy[4]);else signupPrimary.removeAttribute('form');
 document.querySelector('#signup-consent').hidden=stage!=='contact';document.querySelector('#signup-skip').hidden=!['audience','recipient'].includes(stage);
 if(stage==='account')ensureTurnstile();
 document.querySelector('.signup-body').scrollTop=0;signupTitle.focus({preventScroll:true});
}
// Cloudflare Turnstile on the account-creation step only, and only when a site key is set on the dialog
// (data-turnstile-site-key). The contact step stays untouched so the ads conversion is unaffected.
let turnstileToken='',turnstileLoading=false;
function ensureTurnstile(){
 const key=waitlistDialog.dataset.turnstileSiteKey,slot=document.querySelector('#turnstile');if(!key||!slot||slot.dataset.rendered)return;
 const render=()=>{if(slot.dataset.rendered||!window.turnstile)return;slot.dataset.rendered='1';window.turnstile.render(slot,{sitekey:key,callback:t=>{turnstileToken=t;},'expired-callback':()=>{turnstileToken='';},'error-callback':()=>{turnstileToken='';}});};
 if(window.turnstile)return render();if(turnstileLoading)return;turnstileLoading=true;
 window.onSafekeepTurnstile=render;const s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSafekeepTurnstile';s.async=true;s.defer=true;document.head.append(s);
}
function preselectPlan(plan){const form=document.querySelector('#plan-form');if(plan&&form.elements.plan)form.querySelector(`[name=plan][value="${plan}"]`).checked=true;const billing=document.querySelector('[data-billing][aria-pressed="true"]')?.dataset.billing||'monthly';form.querySelector(`[name=billing][value="${billing}"]`).checked=true;}
function openWaitlist(e){preselectPlan(e?.currentTarget?.dataset.openWaitlist);if(!waitlistDialog.open){waitlistDialog.showModal();fitSignupToViewport();signupTitle.focus({preventScroll:true});trackFunnel('form_open');}}
document.querySelectorAll('[data-open-waitlist]').forEach(b=>b.addEventListener('click',openWaitlist));
document.querySelectorAll('[data-close-waitlist]').forEach(b=>b.addEventListener('click',()=>waitlistDialog.close()));
waitlistDialog.addEventListener('click',e=>{if(e.target===waitlistDialog){const r=waitlistDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)waitlistDialog.close();}});
if(location.hash==='#waitlist')history.replaceState(null,'',location.pathname+location.search);
const mobileSignup=document.querySelector('.mobile-signup');
if('IntersectionObserver' in window)new IntersectionObserver(entries=>{mobileSignup.hidden=entries[0].isIntersecting;},{threshold:0}).observe(document.querySelector('.hero-copy'));
document.querySelector('#waitlist-form').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget;validatePhoneInput(document.querySelector('#signup-phone'));if(!form.reportValidity())return;const data=new FormData(form);signupPrimary.disabled=true;signupPrimary.textContent='Saving…';signupStatus.textContent='';
 try{const response=await submitToFormspree({step:'contact',firstName:data.get('firstName'),email:data.get('email'),phone:data.get('phone'),_gotcha:data.get('website')});const result=await readResult(response);if(!response.ok)throw new Error(formspreeError(result,'Could not save. Please try again.'));signupFirstName=String(data.get('firstName')||'');signupPhone=String(data.get('phone')||'').trim();signupEmail=String(data.get('email')||'');savedSignup={email:signupEmail,firstName:String(data.get('firstName')||'')};signupConversion();trackFunnel('contact');form.reset();showSignupStage(savedSignup?'audience':'complete');}
 catch(error){signupStatus.textContent=error.message==='Failed to fetch'?'Please check your connection and try again.':error.message;signupPrimary.textContent='Continue';signupPrimary.disabled=false;}
});
async function readResult(response){try{return await response.json();}catch{return {};}}
function phoneDigits(value){const digits=value.replace(/\D/g,'');return digits.length===11&&digits[0]==='1'?digits.slice(1):digits;}
function formatPhoneInput(input){const value=input.value;if(!/^[+\d\s().-]*$/.test(value))return;const digits=phoneDigits(value);if(digits.length>10)return;input.value=digits.length>6?digits.slice(0,3)+'-'+digits.slice(3,6)+'-'+digits.slice(6):digits.length>3?digits.slice(0,3)+'-'+digits.slice(3):digits;}
function validatePhoneInput(input){const value=input.value.trim(),digits=phoneDigits(value);input.setCustomValidity(!value||(/^[+\d\s().-]+$/.test(value)&&digits.length===10)?'':'Please enter all 10 digits, including the area code. For example: 212-555-1234. You can also leave this optional field blank.');}
for(const id of ['signup-phone','recipient-phone']){const input=document.getElementById(id);input.addEventListener('input',()=>{if(input.selectionStart===input.value.length)formatPhoneInput(input);validatePhoneInput(input);});input.addEventListener('blur',()=>{formatPhoneInput(input);validatePhoneInput(input);});}
async function saveRecipient(payload,retryLabel){
 signupPrimary.disabled=true;signupPrimary.textContent='Saving…';signupStatus.textContent='';
 try{const response=await submitToFormspree({step:'details',...savedSignup,...payload});const result=await readResult(response);if(!response.ok)throw new Error(formspreeError(result,'Could not save these details.'));savedSignup=null;showSignupStage('plan');}
 catch(error){signupStatus.textContent=error.message==='Failed to fetch'?'Your contact details are saved. Check your connection or select Skip.':error.message;signupPrimary.disabled=false;signupPrimary.textContent=retryLabel;}
}
document.querySelector('#audience-form').addEventListener('submit',async e=>{
 e.preventDefault();if(!e.currentTarget.reportValidity())return;helpFor=new FormData(e.currentTarget).get('helpFor');signupIntent.help_for=helpFor;
 if(helpFor==='self'&&signupPhone){await saveRecipient({helpFor:'self',step:'audience',finish:true},'Continue');return;}
 signupPrimary.disabled=true;signupPrimary.textContent='Saving…';signupStatus.textContent='';
 const self=helpFor==='self';
 document.querySelector('#other-person-fields').hidden=self;for(const id of ['recipient-name','recipient-email'])document.getElementById(id).disabled=self;
 document.querySelector('#recipient-name').value='';document.querySelector('#recipient-email').value='';document.querySelector('#recipient-phone').value='';document.querySelector('#recipient-phone').setCustomValidity('');
 document.querySelector('#recipient-phone-label').textContent=self?'Your phone number':'Their phone number';document.querySelector('#recipient-note').textContent=self?'Optional. This won’t start automated texts or calls.':'Share their details only with permission. We won’t contact them automatically.';showSignupStage('recipient');
});
document.querySelector('#signup-skip').onclick=()=>{if(savedSignup&&helpFor){submitToFormspree({step:'details',...savedSignup,helpFor}).catch(()=>{});savedSignup=null;}showSignupStage('plan');};
function showSignupComplete(copy,next){document.querySelector('#signup-complete-copy').textContent=copy;document.querySelector('#signup-complete-next').textContent=next;showSignupStage('complete');}
document.querySelector('#plan-form').addEventListener('submit',async e=>{
 e.preventDefault();if(!e.currentTarget.reportValidity())return;const data=new FormData(e.currentTarget),plan=data.get('plan'),billing=data.get('billing');
 signupPrimary.disabled=true;signupPrimary.textContent='Saving…';signupStatus.textContent='';
 // Best effort: record the choice so abandoned sign-ups can be followed up. Don't block the next step on it.
 await submitToFormspree({step:'plan',email:signupEmail,firstName:signupFirstName,plan,billing}).catch(()=>{});
 signupIntent.plan=plan;signupIntent.billing=billing;rememberIntent();trackFunnel('plan');
 const emailInput=document.querySelector('#account-email');if(!emailInput.value)emailInput.value=signupEmail;
 showSignupStage('account');
});
// Create your account: password, adult attestation and the terms, with the email from step 1 shown and editable.
// The server's reply is the same whether or not the address is already registered, so the next screen always
// offers "Sign in" as well.
document.querySelector('#account-form').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget;if(!form.reportValidity())return;const data=new FormData(form);
 if(waitlistDialog.dataset.turnstileSiteKey&&!turnstileToken){signupStatus.textContent='Please complete the security check, then select Create account.';return;}
 signupPrimary.disabled=true;signupPrimary.textContent='Creating your account…';signupStatus.textContent='';
 try{
  accountEmail=String(data.get('email')||'').trim();
  await accountApi({action:'signup',email:accountEmail,password:data.get('password'),adult_confirmed:form.elements.adult_confirmed.checked,terms_accepted:form.elements.terms_accepted.checked,first_name:signupFirstName,website:data.get('website'),intent:signupIntent,turnstile_token:turnstileToken||undefined});
  trackFunnel('account_created');form.elements.password.value='';showSignupStage('verify');document.querySelector('#verify-code').focus({preventScroll:true});
 }catch(error){signupStatus.textContent=error.message==='Failed to fetch'?'Please check your connection and try again.':error.message;signupPrimary.textContent='Create account';signupPrimary.disabled=false;if(window.turnstile&&turnstileToken){turnstileToken='';try{window.turnstile.reset();}catch{}}}
});
document.querySelector('#verify-form').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget;if(!form.reportValidity())return;
 signupPrimary.disabled=true;signupPrimary.textContent='Checking…';signupStatus.textContent='';
 try{await accountApi({action:'verify_code',email:accountEmail,code:new FormData(form).get('code')});trackFunnel('verified');try{sessionStorage.removeItem('safekeep-intent');}catch{}signupPrimary.textContent='Opening your account…';location.href='/account/';}
 catch(error){signupStatus.textContent=error.message==='Failed to fetch'?'Please check your connection and try again.':error.message;signupPrimary.textContent='Verify';signupPrimary.disabled=false;}
});
document.querySelector('#verify-resend').onclick=async()=>{signupStatus.textContent='';try{const result=await accountApi({action:'resend',email:accountEmail});signupStatus.textContent=result.message||'Sent. Give it a minute, and check your spam folder.';}catch(error){signupStatus.textContent=error.message;}};
document.querySelector('#verify-back').onclick=()=>{document.querySelector('#account-email').value=accountEmail;showSignupStage('account');};
signupPrimary.addEventListener('click',()=>{if(signupStage==='complete')waitlistDialog.close();});
document.querySelector('#recipient-form').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget;validatePhoneInput(document.querySelector('#recipient-phone'));if(!form.reportValidity()||!savedSignup)return;const data=new FormData(form);
 const payload=helpFor==='self'?{helpFor,phone:data.get('recipientPhone')}:{helpFor,recipientFirstName:data.get('recipientFirstName'),recipientEmail:data.get('recipientEmail'),recipientPhone:data.get('recipientPhone')};
 if(helpFor==='other'){signupIntent.invitee_name=String(data.get('recipientFirstName')||'').trim()||null;signupIntent.invitee_email=String(data.get('recipientEmail')||'').trim()||null;signupIntent.invitee_phone=String(data.get('recipientPhone')||'').trim()||null;}
 await saveRecipient(payload,'Save details');
});
const viewport=window.visualViewport;
function fitSignupToViewport(){const height=viewport?.height||innerHeight;waitlistDialog.style.setProperty('--signup-available-height',Math.round(height-24)+'px');waitlistDialog.style.setProperty('--signup-offset',Math.round((viewport?.offsetTop||0)+12)+'px');}
if(viewport){viewport.addEventListener('resize',fitSignupToViewport);viewport.addEventListener('scroll',fitSignupToViewport);}window.addEventListener('resize',fitSignupToViewport);fitSignupToViewport();
// Payment success now returns to /account/. This keeps any Payment Link whose "After payment" redirect still points
// at /?signup=complete working until the Stripe dashboard is updated.
if(campaignParams.get('signup')==='complete')location.replace('/account/?checkout=success');
// Coming back with the browser's Back button can restore the page mid-save.
window.addEventListener('pageshow',e=>{if(e.persisted&&['plan','account','verify'].includes(signupStage))showSignupStage(signupStage);});
const heroVideo=document.querySelector('#hero-video');
const motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
let videoPlaysCompleted=0,videoStarted=false;
if(heroVideo){
heroVideo.loop=false;
heroVideo.addEventListener('ended',()=>{videoPlaysCompleted+=1;if(videoPlaysCompleted<2&&!motionPreference.matches){heroVideo.currentTime=0;heroVideo.play().catch(()=>{});}});
function startHeroVideo(){if(videoStarted||motionPreference.matches||navigator.connection?.saveData)return;videoStarted=true;heroVideo.play().catch(()=>{});}
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{if(entries[0].isIntersecting){startHeroVideo();observer.disconnect();}},{threshold:0.15});observer.observe(heroVideo);}else{startHeroVideo();}
motionPreference.addEventListener('change',e=>{if(e.matches)heroVideo.pause();});

}

const billingButtons=document.querySelectorAll('[data-billing]');
for(const button of billingButtons)button.addEventListener('click',()=>{
 const period=button.dataset.billing;
 for(const item of document.querySelectorAll('[data-annual][data-monthly]'))item.textContent=item.dataset[period];
 for(const toggle of billingButtons)toggle.setAttribute('aria-pressed',String(toggle===button));
 document.querySelector('#billing-note').textContent=period==='annual'?'Save with annual Pairs and Family plans.':'Billed monthly. Cancel anytime.';
 document.querySelector('#billing-status').textContent=period==='annual'?'Annual billing: Individual $60, Pairs $96, Family $168 per year.':'Monthly billing: Individual $5, Pairs $9, Family $16 per month.';
});
