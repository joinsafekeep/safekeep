// The weekly Scam Alert sign-up on every alert page. Posts to /api/alerts, which sends a confirmation email.
(function () {
 var form = document.getElementById('alert-signup-form'); if (!form) return;
 var status = document.getElementById('alert-signup-status');
 form.addEventListener('submit', function (event) {
  event.preventDefault();
  var email = form.elements.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status.textContent = 'Please enter your email address.'; form.elements.email.focus(); return; }
  var button = form.querySelector('button'); button.disabled = true; status.textContent = 'Sending…';
  fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'subscribe', email: email, website: form.elements.website.value, source: location.pathname.slice(0, 40) }) })
   .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); })
   .then(function (d) { status.textContent = d.message; form.reset(); })
   .catch(function (e) { status.textContent = e.message || 'Something went wrong. Please try again.'; })
   .finally(function () { button.disabled = false; });
 });
})();
