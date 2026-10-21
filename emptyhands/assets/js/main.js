/* EmptyHands — small progressive enhancements. Every page works without this file. */
(function () {
  'use strict';
  var doc = document.documentElement;
  doc.classList.remove('no-js');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* Header: solid once scrolled */
  var header = $('.site-header');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 40); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* Mobile menu */
  var toggle = $('.menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = document.body.classList.toggle('menu-open');
      toggle.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    });
  }

  /* Dropdowns */
  $$('.nav-group').forEach(function (group) {
    var btn = $('button', group);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !group.classList.contains('open');
      $$('.nav-group.open').forEach(function (g) { g.classList.remove('open'); $('button', g).setAttribute('aria-expanded', 'false'); });
      group.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  });
  document.addEventListener('click', function () {
    $$('.nav-group.open').forEach(function (g) { g.classList.remove('open'); $('button', g).setAttribute('aria-expanded', 'false'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $$('.nav-group.open').forEach(function (g) { g.classList.remove('open'); $('button', g).focus(); });
    if (document.body.classList.contains('menu-open')) toggle.click();
  });

  /* Reveal on scroll */
  var reveals = $$('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* Background videos: respect reduced motion, pause offscreen, hero toggle */
  $$('video[data-bg]').forEach(function (v) {
    if (reduceMotion) { v.removeAttribute('autoplay'); v.pause(); return; }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { if (!v.dataset.userPaused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } }
          else v.pause();
        });
      }).observe(v);
    }
  });
  var vt = $('.video-toggle');
  if (vt) {
    var hv = $('.hero video');
    var setIcon = function () {
      vt.innerHTML = hv.paused
        ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
      vt.setAttribute('aria-label', hv.paused ? 'Play background video' : 'Pause background video');
    };
    vt.addEventListener('click', function () {
      if (hv.paused) { delete hv.dataset.userPaused; hv.play(); } else { hv.dataset.userPaused = '1'; hv.pause(); }
      setIcon();
    });
    hv.addEventListener('play', setIcon); hv.addEventListener('pause', setIcon);
    setIcon();
  }

  /* Dojo film: plays with its music when scrolled into view. Browsers only allow sound
     after the visitor has tapped or clicked the page, so until then it plays muted
     with a "tap for sound" button. */
  var userGestured = false;
  $$('.film').forEach(function (film) {
    var btn = $('.film-play', film), v = $('video', film), meta = $('.film-meta', film);
    if (!v) return;
    var started = false, userPaused = false, autoPausing = false;
    var sound = document.createElement('button');
    sound.className = 'film-sound';
    sound.type = 'button';
    sound.hidden = true;
    sound.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>Tap for sound';
    film.appendChild(sound);

    var unmute = function () { v.muted = false; sound.hidden = true; };
    var start = function (withSound) {
      if (!started) {
        started = true;
        v.setAttribute('controls', '');
        if (btn) btn.remove();
        if (meta) meta.remove();
      }
      v.muted = !(withSound || userGestured);
      var p = v.play();
      if (p && p.catch) {
        p.then(function () { sound.hidden = !v.muted; }).catch(function (err) {
          // Only fall back to muted for the browser's autoplay block, not a pause mid-start
          if (!err || err.name !== 'NotAllowedError') return;
          v.muted = true;
          sound.hidden = false;
          v.play().catch(function () {});
        });
      } else {
        sound.hidden = !v.muted;
      }
    };

    if (btn) btn.addEventListener('click', function () { userGestured = true; userPaused = false; start(true); });
    sound.addEventListener('click', function () { userGestured = true; unmute(); });
    v.addEventListener('volumechange', function () { if (!v.muted) sound.hidden = true; });
    v.addEventListener('pause', function () {
      if (autoPausing) autoPausing = false;
      else if (!v.ended) userPaused = true;
    });
    v.addEventListener('play', function () { userPaused = false; });

    if ('IntersectionObserver' in window && !reduceMotion) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting && en.intersectionRatio >= 0.5) {
            if (!userPaused && v.paused && !v.ended) start(false);
          } else if (!v.paused) {
            autoPausing = true; v.pause();
          }
        });
      }, { threshold: [0, 0.5] }).observe(film);
    }

    /* The first tap or key press anywhere on the page unlocks sound for a muted film */
    var unlock = function () {
      userGestured = true;
      if (started && v.muted && !v.paused) unmute();
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, unlock, { passive: true }); });
  });

  /* Testimonial carousel arrows */
  $$('.quotes').forEach(function (wrap) {
    var track = $('.quote-track', wrap);
    var step = function (dir) {
      var card = $('.quote', track);
      var w = card ? card.getBoundingClientRect().width + 20 : 400;
      track.scrollBy({ left: dir * w, behavior: reduceMotion ? 'auto' : 'smooth' });
    };
    $$('[data-dir]', wrap).forEach(function (b) { b.addEventListener('click', function () { step(+b.dataset.dir); }); });
  });

  /* Person modal (yudansha / mentors) */
  var modal = $('#person-modal');
  if (modal && typeof modal.showModal === 'function') {
    $$('[data-person]').forEach(function (card) {
      card.addEventListener('click', function () {
        var d = JSON.parse(card.getAttribute('data-person'));
        $('img', modal).src = d.img; $('img', modal).alt = d.name;
        $('.rank', modal).textContent = d.rank;
        $('h2', modal).textContent = d.name;
        $('.date', modal).textContent = d.date ? 'Awarded ' + d.date : '';
        $('.about', modal).textContent = d.about;
        modal.showModal();
      });
    });
    $('.modal-close', modal).addEventListener('click', function () { modal.close(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.close(); });
  }

  /* Lightbox gallery */
  var lb = $('.lightbox');
  if (lb) {
    var items = $$('.gallery button'), idx = 0, lbImg = $('img', lb), count = $('.lb-count', lb), last;
    var show = function (i) {
      idx = (i + items.length) % items.length;
      var im = $('img', items[idx]);
      lbImg.src = im.currentSrc || im.src; lbImg.alt = im.alt;
      count.textContent = (idx + 1) + ' / ' + items.length;
    };
    var close = function () { lb.classList.remove('open'); document.body.style.overflow = ''; if (last) last.focus(); };
    items.forEach(function (b, i) { b.addEventListener('click', function () { last = b; show(i); lb.classList.add('open'); document.body.style.overflow = 'hidden'; $('.lb-close', lb).focus(); }); });
    $('.lb-close', lb).addEventListener('click', close);
    $('.lb-prev', lb).addEventListener('click', function () { show(idx - 1); });
    $('.lb-next', lb).addEventListener('click', function () { show(idx + 1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
  }

  /* Blog filter + search */
  var filters = $('.filters');
  if (filters) {
    var cards = $$('.posts .post-card'), cat = 'All', q = '', empty = $('.no-results');
    var apply = function () {
      var shown = 0;
      cards.forEach(function (c) {
        var ok = (cat === 'All' || c.dataset.cat === cat) && (!q || c.textContent.toLowerCase().indexOf(q) > -1);
        c.classList.toggle('is-hidden', !ok); if (ok) shown++;
      });
      if (empty) empty.hidden = shown > 0;
    };
    $$('button', filters).forEach(function (b) {
      b.addEventListener('click', function () {
        $$('button', filters).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true'); cat = b.dataset.cat; apply();
      });
    });
    var input = $('input', filters);
    if (input) input.addEventListener('input', function () { q = input.value.trim().toLowerCase(); apply(); });
  }

  /* Fee tabs */
  var tabs = $$('.fee-tabs [role="tab"]');
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', 'false'); x.tabIndex = -1; $('#' + x.getAttribute('aria-controls')).hidden = true; });
      t.setAttribute('aria-selected', 'true'); t.tabIndex = 0; $('#' + t.getAttribute('aria-controls')).hidden = false;
    });
    t.addEventListener('keydown', function (e) {
      var n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (n) { var nx = tabs[(i + n + tabs.length) % tabs.length]; nx.focus(); nx.click(); }
    });
  });
  if (location.hash && $(location.hash + '-tab')) $(location.hash + '-tab').click();

  /* Copy link */
  $$('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(function () { b.title = 'Link copied'; b.setAttribute('aria-label', 'Link copied'); });
    });
  });

  /* Forms: no server — compose an email (or WhatsApp) from the fields */
  $$('form[data-mailto]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;
      var data = new FormData(form), lines = [], seen = {};
      data.forEach(function (val, key) {
        if (key.charAt(0) === '_') return;
        if (seen[key]) { seen[key].push(val); return; }
        seen[key] = [val];
      });
      Object.keys(seen).forEach(function (k) { if (seen[k].join('').trim()) lines.push(k + ': ' + seen[k].join(', ')); });
      var body = lines.join('\n');
      var subject = form.getAttribute('data-subject') || 'Website enquiry';
      var via = e.submitter && e.submitter.value === 'whatsapp' ? 'whatsapp' : 'email';
      if (via === 'whatsapp') {
        window.open('https://wa.me/447931300470?text=' + encodeURIComponent(subject + '\n\n' + body), '_blank', 'noopener');
      } else {
        location.href = 'mailto:' + form.getAttribute('data-mailto') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
      }
      var st = $('.form-status', form);
      if (st) st.classList.add('show');
    });
  });

  var y = $('#year'); if (y) y.textContent = new Date().getFullYear();
})();
