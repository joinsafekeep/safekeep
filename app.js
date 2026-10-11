const mobileLayout=window.matchMedia('(max-width: 750px)');
const campaignParams=new URLSearchParams(location.search);
let funnelSession;
try{funnelSession=sessionStorage.getItem('safekeep-session');if(!funnelSession){funnelSession=crypto.randomUUID();sessionStorage.setItem('safekeep-session',funnelSession)}}catch{funnelSession=crypto.randomUUID();}
const campaignAttribution={sessionId:funnelSession,audience:document.body.dataset.audience||'self',device:mobileLayout.matches?'mobile':'desktop',source:campaignParams.get('utm_source'),medium:campaignParams.get('utm_medium'),campaign:campaignParams.get('utm_campaign'),content:campaignParams.get('utm_content'),term:campaignParams.get('utm_term')};
function trackFunnel(event){fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),event,attribution:campaignAttribution}),keepalive:true}).catch(()=>{});}
trackFunnel('page_view');
function toggleTextSize(){const active=document.documentElement.classList.toggle('large-text');const top=document.querySelector('#text-size');top.setAttribute('aria-pressed',active);top.querySelector('span').textContent=active?'Standard text':'Larger text';document.querySelector('[data-text-size]').textContent=active?'Use standard text':'Make text larger';}document.querySelector('#text-size').onclick=toggleTextSize;document.querySelector('[data-text-size]').onclick=toggleTextSize;
const modal=document.querySelector('#modal');function showModal(html){document.querySelector('#modal-content').innerHTML=html;modal.showModal()}modal.querySelector('.close').onclick=()=>modal.close();modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close()}});
document.querySelectorAll('[data-help]').forEach(b=>b.onclick=()=>showModal(`<div class="eyebrow">Your next step</div><h2>Start here.<br>You’re not alone.</h2><p>If you think something is wrong, stop communicating with the person. Don’t send more money or codes.</p><ol><li><strong>Paid money?</strong> Contact your bank or payment provider using a trusted number. Explain what happened and ask whether the payment can be reversed.</li><li><strong>Shared a password?</strong> Change it on the real website and anywhere you reused it. Turn on two-factor authentication.</li><li><strong>Shared personal information?</strong> Visit <a href="https://www.identitytheft.gov/" target="_blank" rel="noopener noreferrer">IdentityTheft.gov ↗</a> for a recovery plan.</li><li><strong>Talk to someone you trust.</strong> Save messages and receipts. Report the incident at <a href="https://reportfraud.ftc.gov/" target="_blank" rel="noopener noreferrer">ReportFraud.ftc.gov ↗</a>.</li></ol><p class="small">U.S. resources. For immediate physical danger, call 911. Money recovery is not guaranteed.</p><a href="https://consumer.ftc.gov/articles/what-do-if-you-were-scammed" target="_blank" rel="noopener noreferrer">Read the FTC’s full recovery guide ↗</a>`));
const familyStart=document.querySelector('#family-start');if(familyStart)familyStart.onclick=()=>showModal(`<div class="eyebrow">Start a conversation</div><h2>Try opening with this.</h2><div class="sample">“I found a few examples of the kinds of scams going around. Some are really convincing. Want to look at a few together?”</div><p>Ask first. Let them choose which examples to read. Compare what stood out to each of you, and agree on a familiar number to call if a request ever feels unusual.</p><p><strong>A simple family habit:</strong> check unexpected requests for money through a separate, trusted way of reaching each other.</p><button class="button" id="together">See the examples together <span>→</span></button>`);document.querySelector('#modal-content').addEventListener('click',e=>{if(e.target.closest('#together')){modal.close();document.querySelector('#examples').scrollIntoView();document.querySelector('#examples h2').setAttribute('tabindex','-1');document.querySelector('#examples h2').focus({preventScroll:true})}});
function showPrivacy(){showModal(`<div class="eyebrow">Your privacy</div><h2>About your details.</h2><p>If you join the waitlist, we save your first name, email address, whether you want help for yourself or someone else, any first name, email, or phone number you optionally provide for that person, your optional phone number, signup time, and the contact notice shown when you join in Safekeep’s hosted database. Safekeep’s site administrators can access these details to manage the waitlist and plan the service.</p><p>Completed form steps are also shared with the Safekeep team by notification email, using our email delivery provider when configured. We’ll use your email to let you know about the launch. Joining does not enroll you in a paid subscription or start automated calls or text messages. You can ask to be removed by replying to a waitlist email.</p><p>We also record page views, form opens, and successful submissions with campaign tags, audience, device category, and a random session identifier to understand which ads lead to signups. We do not send this information to advertising platforms. This page does not add Meta or TikTok tracking pixels. Hosting providers may process ordinary request logs, and fonts load from Google Fonts.</p>`)}
document.querySelector('#privacy').onclick=showPrivacy;
document.querySelectorAll('[data-privacy]').forEach(b=>b.onclick=showPrivacy);



const waitlistDialog=document.querySelector('#waitlist-dialog');
const signupTitle=document.querySelector('#waitlist-title'),signupStatus=document.querySelector('#signup-status'),signupPrimary=document.querySelector('#signup-primary');
let signupStage='contact',savedSignup=null,signupFirstName='',signupPhone='',helpFor=null;
const recipientDrafts={self:null,other:null};
function showSignupStage(stage){
 signupStage=stage;signupStatus.textContent='';signupPrimary.disabled=false;
 const copy={contact:['Step 1 of 3 · Join the waitlist','Your contact details','We’ll email you when Safekeep is ready.','Join the waitlist','waitlist-form'],audience:['Step 2 of 3 · Optional','Who is the help for?','You’re on the waitlist. Help us understand what you need.','Continue','audience-form'],recipient:['Step 3 of 3 · Optional',helpFor==='other'?'Their contact details':'Add your phone number',helpFor==='other'?'Tell us who you’d like scam help for.':'You left this blank earlier. Would you like to add it?' ,'Save details','recipient-form'],complete:['You’re all set','Thank you for joining','Your place on the waitlist is saved.','Done',null]}[stage];
 document.querySelector('#signup-step').textContent=copy[0];signupTitle.textContent=copy[1];document.querySelector('#signup-description').textContent=copy[2];
 for(const [id,key] of [['waitlist-form','contact'],['audience-form','audience'],['recipient-form','recipient'],['signup-complete','complete']])document.getElementById(id).hidden=stage!==key;
 signupPrimary.textContent=copy[3];signupPrimary.type=copy[4]?'submit':'button';if(copy[4])signupPrimary.setAttribute('form',copy[4]);else signupPrimary.removeAttribute('form');
 document.querySelector('#signup-back').hidden=stage!=='recipient';document.querySelector('#signup-skip').hidden=!['audience','recipient'].includes(stage);
 document.querySelector('.signup-body').scrollTop=0;signupTitle.focus({preventScroll:true});
}
function openWaitlist(){if(!waitlistDialog.open){waitlistDialog.showModal();fitSignupToViewport();signupTitle.focus({preventScroll:true});trackFunnel('form_open');}}
document.querySelectorAll('[data-open-waitlist]').forEach(b=>b.addEventListener('click',openWaitlist));
document.querySelectorAll('[data-close-waitlist]').forEach(b=>b.addEventListener('click',()=>waitlistDialog.close()));
waitlistDialog.addEventListener('click',e=>{if(e.target===waitlistDialog){const r=waitlistDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)waitlistDialog.close();}});
if(location.hash==='#waitlist')history.replaceState(null,'',location.pathname+location.search);
const mobileSignup=document.querySelector('.mobile-signup');
if('IntersectionObserver' in window)new IntersectionObserver(entries=>{mobileSignup.hidden=entries[0].isIntersecting;},{threshold:0}).observe(document.querySelector('.hero-copy'));
document.querySelector('#waitlist-form').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget;validatePhoneInput(document.querySelector('#signup-phone'));if(!form.reportValidity())return;const data=new FormData(form);signupPrimary.disabled=true;signupPrimary.textContent='Saving…';signupStatus.textContent='';
 try{const response=await fetch('/api/waitlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstName:data.get('firstName'),email:data.get('email'),phone:data.get('phone'),website:data.get('website'),attribution:campaignAttribution})});const result=await readResult(response);if(!response.ok||!result.ok)throw new Error(result.error||'Could not save. Please try again.');signupFirstName=String(data.get('firstName')||'');signupPhone=String(data.get('phone')||'').trim();savedSignup=result.id&&result.detailToken?{id:result.id,detailToken:result.detailToken}:null;form.reset();showSignupStage(savedSignup?'audience':'complete');}
 catch(error){signupStatus.textContent=error.message==='Failed to fetch'?'Please check your connection and try again.':error.message;signupPrimary.textContent='Join the waitlist';signupPrimary.disabled=false;}
});
async function readResult(response){try{return await response.json();}catch{return {};}}
function rememberRecipient(){if(helpFor)recipientDrafts[helpFor]={name:document.querySelector('#recipient-name').value,email:document.querySelector('#recipient-email').value,phone:document.querySelector('#recipient-phone').value};}
function phoneDigits(value){const digits=value.replace(/\D/g,'');return digits.length===11&&digits[0]==='1'?digits.slice(1):digits;}
function formatPhoneInput(input){const value=input.value;if(!/^[+\d\s().-]*$/.test(value))return;const digits=phoneDigits(value);if(digits.length>10)return;input.value=digits.length>6?digits.slice(0,3)+'-'+digits.slice(3,6)+'-'+digits.slice(6):digits.length>3?digits.slice(0,3)+'-'+digits.slice(3):digits;}
function validatePhoneInput(input){const value=input.value.trim(),digits=phoneDigits(value);input.setCustomValidity(!value||(/^[+\d\s().-]+$/.test(value)&&digits.length===10)?'':'Please enter all 10 digits, including the area code. For example: 212-555-1234. You can also leave this optional field blank.');}
for(const id of ['signup-phone','recipient-phone']){const input=document.getElementById(id);input.addEventListener('input',()=>{if(input.selectionStart===input.value.length)formatPhoneInput(input);validatePhoneInput(input);});input.addEventListener('blur',()=>{formatPhoneInput(input);validatePhoneInput(input);});}
async function saveRecipient(payload,retryLabel){
 signupPrimary.disabled=true;signupPrimary.textContent='Saving…';signupStatus.textContent='';
 try{const response=await fetch('/api/waitlist',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({...savedSignup,...payload})});const result=await readResult(response);if(!response.ok||!result.ok)throw new Error(result.error||'Could not save these details.');savedSignup=null;document.querySelector('#signup-complete-copy').textContent=helpFor==='other'?'Saved: your request for someone else and the contact details you entered.':'Saved: your request for scam help and your contact details.';showSignupStage('complete');}
 catch(error){signupStatus.textContent=error.message==='Failed to fetch'?'Your waitlist place is saved. Check your connection or select Skip and finish.':error.message;signupPrimary.disabled=false;signupPrimary.textContent=retryLabel;}
}
document.querySelector('#audience-form').addEventListener('submit',async e=>{
 e.preventDefault();if(!e.currentTarget.reportValidity())return;helpFor=new FormData(e.currentTarget).get('helpFor');
 if(helpFor==='self'&&signupPhone){await saveRecipient({helpFor:'self',step:'audience',finish:true},'Continue');return;}
 signupPrimary.disabled=true;signupPrimary.textContent='Saving…';signupStatus.textContent='';
 try{const response=await fetch('/api/waitlist',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({...savedSignup,step:'audience',helpFor})});const result=await readResult(response);if(!response.ok||!result.ok)throw new Error(result.error||'Could not save your choice.');}
 catch(error){signupStatus.textContent=error.message==='Failed to fetch'?'Please check your connection and try again.':error.message;signupPrimary.disabled=false;signupPrimary.textContent='Continue';return;}
 const self=helpFor==='self',draft=recipientDrafts[helpFor];
 document.querySelector('#other-person-fields').hidden=self;for(const id of ['recipient-name','recipient-email'])document.getElementById(id).disabled=self;
 document.querySelector('#recipient-name').value=draft?.name||'';document.querySelector('#recipient-email').value=draft?.email||'';document.querySelector('#recipient-phone').value=draft?.phone||'';document.querySelector('#recipient-phone').setCustomValidity('');
 document.querySelector('#recipient-phone-label').textContent=self?'Your phone number':'Their phone number';document.querySelector('#recipient-note').textContent=self?'Optional. This won’t start automated texts or calls.':'Share their details only with permission. We won’t contact them automatically.';showSignupStage('recipient');
});
document.querySelector('#signup-back').onclick=()=>{rememberRecipient();showSignupStage('audience');};
document.querySelector('#signup-skip').onclick=()=>{document.querySelector('#signup-complete-copy').textContent='Your initial contact details are saved. Any choices or details you already saved are kept. No unsaved fields were submitted.';showSignupStage('complete');};
signupPrimary.addEventListener('click',()=>{if(signupStage==='complete')waitlistDialog.close();});
document.querySelector('#recipient-form').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget;validatePhoneInput(document.querySelector('#recipient-phone'));if(!form.reportValidity()||!savedSignup)return;const data=new FormData(form);
 const payload=helpFor==='self'?{helpFor,phone:data.get('recipientPhone')}:{helpFor,recipientFirstName:data.get('recipientFirstName'),recipientEmail:data.get('recipientEmail'),recipientPhone:data.get('recipientPhone')};
 await saveRecipient(payload,'Save details');
});
const viewport=window.visualViewport;
function fitSignupToViewport(){const height=viewport?.height||innerHeight;waitlistDialog.style.setProperty('--signup-available-height',Math.round(height-24)+'px');waitlistDialog.style.setProperty('--signup-offset',Math.round((viewport?.offsetTop||0)+12)+'px');}
if(viewport){viewport.addEventListener('resize',fitSignupToViewport);viewport.addEventListener('scroll',fitSignupToViewport);}window.addEventListener('resize',fitSignupToViewport);fitSignupToViewport();
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
