// Confirms a free-list sign-up (?c=token) or offers the unsubscribe button (?u=email&s=signature).
(function () {
 var params = new URLSearchParams(location.search), $ = function (id) { return document.getElementById(id); };
 var confirmToken = params.get('c'), email = params.get('u'), sig = params.get('s');
 if (location.search) history.replaceState({}, '', location.pathname);
 function post(body) {
  return fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
 }
 function done(text) { $('status').textContent = ''; $('done-copy').textContent = text; $('done').hidden = false; $('unsubscribe').hidden = true; }
 if (confirmToken) {
  post({ action: 'confirm', token: confirmToken }).then(function (d) {
   $('title').textContent = d.confirmed ? 'You’re on the list' : 'This link has expired';
   done(d.confirmed ? 'Thank you. The weekly Scam Alert will come to your inbox starting with the next one. Every email has an unsubscribe link at the bottom.' : 'Confirmation links work for seven days. You can sign up again from any Scam Alert page and we’ll send a fresh one.');
  }).catch(function () { $('status').textContent = 'Something went wrong. Please try the link again in a few minutes.'; });
 } else if (email && sig) {
  $('status').textContent = ''; $('unsubscribe-copy').textContent = 'We’ll stop sending the weekly Scam Alert to ' + email + '.'; $('unsubscribe').hidden = false;
  $('unsubscribe-button').addEventListener('click', function () {
   this.disabled = true;
   post({ action: 'unsubscribe', email: email, sig: sig }).then(function (d) {
    $('title').textContent = d.unsubscribed ? 'You’re unsubscribed' : 'That link didn’t work';
    done(d.unsubscribed ? 'You won’t get the weekly Scam Alert any more. You can sign up again from any Scam Alert page whenever you like.' : 'Please use the unsubscribe link from the most recent alert email, or reply to that email and we’ll take you off the list.');
   });
  });
 } else { $('status').textContent = 'This page needs the link from your email.'; }
})();
