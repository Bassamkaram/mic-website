/* ============================================================
   Metn Innovation Campus — v2
   Shared scripts (no dependencies)
   ============================================================ */

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    initReveal();
    initMobileMenu();
    initModals();
    initCountdown();
    initMapTabs();
    initWorkshops();
    initBlogToggles();
    initServiceRequest();
  }

  /* ---------------------------------------------------------
     Reveal animation (progressive enhancement)
     Default: content visible. JS opts in via .js-anim class.
     --------------------------------------------------------- */
  function initReveal() {
    if (!('IntersectionObserver' in window)) return;
    document.documentElement.classList.add('js-anim');
    var nodes = document.querySelectorAll('.reveal');
    if (!nodes.length) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    nodes.forEach(function (el) { io.observe(el); });

    // Safety net: any element still hidden after 2.5s gets revealed.
    setTimeout(function () {
      nodes.forEach(function (el) {
        if (!el.classList.contains('in')) el.classList.add('in');
      });
    }, 2500);
  }

  /* ---------------------------------------------------------
     Mobile menu toggle
     --------------------------------------------------------- */
  function initMobileMenu() {
    var burger = document.getElementById('navBurger');
    var menu   = document.getElementById('mobileMenu');
    if (!burger || !menu) return;

    burger.addEventListener('click', function () {
      var open = burger.classList.toggle('open');
      menu.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    });

    // Close on link click
    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        burger.classList.remove('open');
        menu.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
  }

  /* ---------------------------------------------------------
     Modal system
     Triggers: [data-modal="modal-id"]
     Modals: .modal-backdrop with id="modal-id"
     Forms inside a modal show .modal-success on submit.
     --------------------------------------------------------- */
  var openBackdrop = null;
  var lastFocus    = null;

  function initModals() {
    // Triggers (delegated)
    document.addEventListener('click', function (e) {
      var trigger = e.target.closest('[data-modal]');
      if (trigger) {
        e.preventDefault();
        openModal(trigger.getAttribute('data-modal'));
        return;
      }

      // Close on backdrop click
      if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
        closeModal();
      }

      // Close on close button
      if (e.target.closest('[data-modal-close]')) {
        closeModal();
      }
    });

    // Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openBackdrop) closeModal();
    });

    // Form submission
    document.querySelectorAll('.modal form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        handleFormSubmit(form);
      });
    });
  }

  function openModal(id) {
    var backdrop = document.getElementById(id);
    if (!backdrop) return;
    lastFocus = document.activeElement;
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    openBackdrop = backdrop;

    // Reset success state if user reopens modal
    var form = backdrop.querySelector('form');
    var success = backdrop.querySelector('.modal-success');
    if (form && success) {
      form.style.display = '';
      success.style.display = 'none';
      form.reset && form.reset();
    }

    // Focus first input
    setTimeout(function () {
      var firstInput = backdrop.querySelector('input, textarea, select, button');
      if (firstInput) firstInput.focus();
    }, 80);
  }

  function closeModal() {
    if (!openBackdrop) return;
    openBackdrop.classList.remove('open');
    openBackdrop.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (lastFocus) lastFocus.focus();
    openBackdrop = null;
  }

  function handleFormSubmit(form) {
    var modal       = form.closest('.modal');
    var success     = modal ? modal.querySelector('.modal-success') : null;
    var submitBtn   = form.querySelector('button[type="submit"]');
    var originalBtn = submitBtn ? submitBtn.innerHTML : null;

    // Disable the submit button while in flight to prevent double-submits
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
    }

    // Remove any prior error message from a previous failed attempt
    var prevError = form.querySelector('.form-error');
    if (prevError) prevError.remove();

    // Build the submission payload. File-upload forms need multipart encoding
    // (the browser sets Content-Type automatically with the multipart boundary
    // when you pass a FormData body without setting Content-Type yourself).
    // Other forms use URL-encoded encoding which Netlify accepts cleanly.
    var formData    = new FormData(form);
    var enctype     = (form.getAttribute('enctype') || '').toLowerCase();
    var isMultipart = enctype.indexOf('multipart') !== -1;

    var fetchOptions = { method: 'POST' };
    if (isMultipart) {
      fetchOptions.body = formData;
    } else {
      fetchOptions.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      fetchOptions.body    = new URLSearchParams(formData).toString();
    }

    // Netlify Forms receives the POST at the current page URL. Static deploys
    // also accept "/" as the target. We use the form's resolved action which
    // defaults to the current page URL when no action attribute is set.
    fetch(form.action || '/', fetchOptions)
      .then(function (response) {
        if (!response.ok) throw new Error('Netlify returned ' + response.status);

        // Success — swap form for the modal-success panel
        if (success) {
          form.style.display    = 'none';
          success.style.display = 'block';
        } else {
          form.innerHTML = '<p style="text-align:center;padding:20px;color:var(--cedar);font-family:var(--serif);font-size:20px;">Thank you. We will be in touch.</p>';
        }
      })
      .catch(function (err) {
        // Failure — re-enable the button and surface an honest error message
        // with a mailto fallback so the lead isn't lost
        console.error('Form submission failed:', err);
        if (submitBtn) {
          submitBtn.disabled = false;
          if (originalBtn) submitBtn.innerHTML = originalBtn;
        }
        var error = document.createElement('p');
        error.className   = 'form-error';
        error.style.cssText = 'color:#DC2626;font-size:13px;margin-top:12px;text-align:center;line-height:1.5;';
        error.innerHTML   = 'Something went wrong. Please try again, or email us directly at <a href="mailto:info@mic-lb.com" style="color:#DC2626;text-decoration:underline;">info@mic-lb.com</a>.';
        form.appendChild(error);
      });
  }

  /* ---------------------------------------------------------
     Countdown timer
     Target: Tuesday, October 20, 2026, 08:00:00 Lebanon (UTC+3)
     --------------------------------------------------------- */
  function initCountdown() {
    var root = document.getElementById('countdown');
    if (!root) return;

    var target = new Date('2026-10-20T08:00:00+03:00').getTime();
    var done   = document.getElementById('countdownDone');

    function tick() {
      var now  = Date.now();
      var diff = target - now;

      if (diff <= 0) {
        root.style.display = 'none';
        if (done) done.style.display = 'block';
        return true;
      }

      var d = Math.floor(diff / (1000 * 60 * 60 * 24));
      var h = Math.floor((diff / (1000 * 60 * 60)) % 24);
      var m = Math.floor((diff / (1000 * 60)) % 60);
      var s = Math.floor((diff / 1000) % 60);

      setCell('cdDays', d);
      setCell('cdHours', h);
      setCell('cdMins', m);
      setCell('cdSecs', s);
      return false;
    }

    function setCell(id, val) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = String(val).padStart(2, '0');
    }

    if (!tick()) {
      setInterval(tick, 1000);
    }
  }

  /* ---------------------------------------------------------
     Map tabs — toggle marker visibility on a fixed map view.
     The iframe itself is centered on Collège de la Sagesse and
     never reloads; we just show/hide the relevant pins.
     --------------------------------------------------------- */
  function initMapTabs() {
    var tabs  = document.querySelectorAll('.map-tab');
    var frame = document.getElementById('mapFrame');
    var hint  = document.getElementById('mapHintText');
    var link  = document.getElementById('mapLink');
    if (!tabs.length || !frame) return;

    // Campus location — the fixed center the map stays anchored to.
    var CAMPUS_LAT = 33.89023889807643;
    var CAMPUS_LNG = 35.57016743794244;
    var campusName = 'Collège de la Sagesse Jdeideh Lebanon';

    // Google Maps Embed API key (free, restricted to this site + the
    // Maps Embed API in Google Cloud Console).
    var MAPS_KEY = 'AIzaSyCIq5hvp_koHIj-1aQvMCvV8lJ0nk8fFx0';

    // Zoom 15 keeps the visible area to roughly a 2 km span centered on the
    // campus, so businesses further out simply fall outside the frame.
    var FIXED_ZOOM = 15;

    var areaSuffix = ' Jdeideh Metn Lebanon';
    var SEARCH = {
      campus:      campusName,
      fnb:         'restaurants cafes bars' + areaSuffix,
      fitness:     'gym fitness sports' + areaSuffix,
      healthcare:  'hospital clinic medical' + areaSuffix,
      pharmacy:    'pharmacy' + areaSuffix,
      beauty:      'hair salon beauty salon' + areaSuffix,
      grocery:     'supermarket grocery' + areaSuffix,
      nursery:     'nursery daycare' + areaSuffix,
      hotel:       'hotel' + areaSuffix,
      carrental:   'car rental' + areaSuffix,
      mechanic:    'car repair mechanic' + areaSuffix,
      electronics: 'electronics store' + areaSuffix,
      flowers:     'florist flower shop' + areaSuffix,
      vet:         'veterinary pet shop' + areaSuffix,
      religious:   'church mosque' + areaSuffix,
      government:  'government office municipality' + areaSuffix
    };

    function buildEmbedUrl(cat) {
      var term = SEARCH[cat] || campusName;
      var center = CAMPUS_LAT + ',' + CAMPUS_LNG;
      // Embed API "search" mode: q is the query, center pins the view on the
      // campus, zoom locks the span so far-away results stay out of frame.
      return 'https://www.google.com/maps/embed/v1/search'
        + '?key=' + MAPS_KEY
        + '&q=' + encodeURIComponent(term)
        + '&center=' + encodeURIComponent(center)
        + '&zoom=' + FIXED_ZOOM;
    }

    function setActive(cat, label) {
      frame.src = buildEmbedUrl(cat);

      if (hint) {
        hint.textContent = (cat === 'campus')
          ? "Tap a category above to see what's nearby — live from Google Maps."
          : "Showing " + label.toLowerCase() + " near the campus (centered on the map), live from Google Maps.";
      }
      if (link) {
        if (cat === 'campus') {
          link.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(campusName);
          link.textContent = 'Open in Google Maps →';
        } else {
          var q = encodeURIComponent(SEARCH[cat] || '');
          link.href = 'https://www.google.com/maps/search/?api=1&query=' + q;
          link.textContent = 'See all ' + label.toLowerCase() + ' on Google Maps →';
        }
      }
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var cat = tab.getAttribute('data-cat');
        var label = tab.getAttribute('data-label') || tab.textContent.trim();
        setActive(cat, label);
      });
    });
  }

  /* ---------------------------------------------------------
     Workshops — expandable details panels + pre-register modal
     context injection.
     --------------------------------------------------------- */
  function initWorkshops() {
    // Details toggle: expand/collapse the panel beneath each workshop card.
    var toggles = document.querySelectorAll('.workshop-toggle');
    toggles.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var targetId = btn.getAttribute('aria-controls');
        var panel = targetId ? document.getElementById(targetId) : null;
        if (!panel) return;

        var card = btn.closest('.workshop-card');
        var isOpen = btn.getAttribute('aria-expanded') === 'true';

        if (isOpen) {
          panel.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
          btn.classList.remove('is-open');
          if (card) card.classList.remove('is-expanded');
          // Reset label
          btn.firstChild.nodeValue = 'Details ';
        } else {
          panel.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
          btn.classList.add('is-open');
          if (card) card.classList.add('is-expanded');
          btn.firstChild.nodeValue = 'Hide details ';
        }
      });
    });

    // Pre-register modal: capture which workshop was clicked and inject the
    // name into the modal title + hidden form field so the submission carries it.
    var nameLabel = document.getElementById('pre-workshop-name');
    var nameInput = document.getElementById('pre-workshop-input');
    var preTriggers = document.querySelectorAll('[data-modal="modal-pre-register"][data-workshop]');
    preTriggers.forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        var ws = trigger.getAttribute('data-workshop') || 'Workshop';
        if (nameLabel) nameLabel.textContent = ws;
        if (nameInput) nameInput.value = ws;
      });
    });
  }

  /* ---------------------------------------------------------
     Blog post toggles — expand/collapse the body of each post,
     keeping only the lede visible by default.
     --------------------------------------------------------- */
  function initBlogToggles() {
    var toggles = document.querySelectorAll('.blog-toggle');
    toggles.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var panel = document.getElementById(btn.getAttribute('aria-controls'));
        if (!panel) return;

        var isOpen = btn.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
          panel.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
          btn.classList.remove('is-open');
          // First text node is the label
          btn.firstChild.nodeValue = 'Read more ';
        } else {
          panel.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
          btn.classList.add('is-open');
          btn.firstChild.nodeValue = 'Read less ';
        }
      });
    });
  }

  /* ---------------------------------------------------------
     Service request — capture which service card the user clicked
     and inject the name into the Request a call modal.
     --------------------------------------------------------- */
  function initServiceRequest() {
    var nameLabel = document.getElementById('call-service-name');
    var nameInput = document.getElementById('call-service-input');
    var triggers = document.querySelectorAll('[data-modal="modal-request-call"][data-service]');
    triggers.forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        var svc = trigger.getAttribute('data-service') || 'Service';
        if (nameLabel) nameLabel.textContent = svc;
        if (nameInput) nameInput.value = svc;
      });
    });
  }

})();
