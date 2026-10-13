/* =====================================================================
   Power Pump Men 2.0 — interacción de la página
   ===================================================================== */
(function () {
  'use strict';

  /* ─── CONFIGURACIÓN ─────────────────────────────────────────────
     whatsapp: número con código de país, sin "+" ni espacios
               (ej. '5491112345678'). Si queda vacío no se muestra
               el botón flotante de WhatsApp.
     Los pagos los procesa el servidor de Railway (server/pagos.ts):
     ahí se configuran el token de Mercado Pago y el email de pedidos.
     ────────────────────────────────────────────────────────────── */
  var CONFIG = {
    whatsapp: '',
    whatsappText: 'Hola! Quiero consultar por la Power Pump Men 2.0'
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ─── Header y menú móvil ─── */
  var header = $('.header');
  var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var toggle = $('.nav-toggle');
  var setNav = function (open) {
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
  };
  toggle.addEventListener('click', function () { setNav(!document.body.classList.contains('nav-open')); });
  $$('#nav a').forEach(function (a) { a.addEventListener('click', function () { setNav(false); }); });

  /* ─── Aparición al hacer scroll ─── */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    $$('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    $$('.reveal').forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ─── Comprar → checkout ─── */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-buy]');
    if (!b) return;
    e.preventDefault();
    window.location.href = 'checkout.html?kit=' + encodeURIComponent(b.getAttribute('data-buy'));
  });

  /* ─── WhatsApp ─── */
  if (CONFIG.whatsapp) {
    var wa = document.createElement('a');
    wa.className = 'wa-float';
    wa.href = 'https://wa.me/' + CONFIG.whatsapp + '?text=' + encodeURIComponent(CONFIG.whatsappText);
    wa.target = '_blank';
    wa.rel = 'noopener';
    wa.setAttribute('aria-label', 'Consultar por WhatsApp');
    wa.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm5.8 14.05c-.24.68-1.42 1.3-1.95 1.34-.5.05-.97.23-3.27-.68-2.77-1.09-4.52-3.92-4.66-4.1-.13-.18-1.11-1.48-1.11-2.82 0-1.34.7-2 .95-2.27.25-.27.54-.34.72-.34h.52c.17 0 .39-.06.61.47.24.56.79 1.92.86 2.06.07.14.11.3.02.48-.09.18-.14.3-.27.46-.14.16-.29.36-.41.48-.14.14-.28.29-.12.56.16.27.71 1.17 1.52 1.9 1.05.93 1.93 1.22 2.2 1.36.27.14.43.11.59-.07.16-.18.68-.79.86-1.07.18-.27.36-.23.61-.14.25.09 1.59.75 1.86.89.27.14.45.2.52.32.07.11.07.66-.17 1.33Z"/></svg>';
    document.body.appendChild(wa);
  }

  /* ─── Visores 3D ─── */
  $$('.v3d').forEach(function (el) {
    el.addEventListener('v3d:interact', function () {
      var stage = el.closest('[data-stage]');
      if (stage) stage.classList.add('is-used');
    });
  });

  function fallback(el) {
    el.classList.add('v3d--fallback');
    var src = el.getAttribute('data-fallback');
    if (src && !el.querySelector('img')) {
      var img = document.createElement('img');
      img.src = src;
      img.alt = el.getAttribute('aria-label') || 'Power Pump Men 2.0';
      img.loading = 'lazy';
      el.appendChild(img);
    }
  }

  var api = null;
  var ready = window.Pump3D ? window.Pump3D.ready : Promise.reject(new Error('Pump3D no disponible'));

  ready.then(function (a) {
    api = a;
    $$('.v3d[data-kit]').forEach(function (el) {
      try {
        var v = api.create(el, {
          kit: el.getAttribute('data-kit'),
          auto: el.getAttribute('data-auto') === 'hover' ? 'hover' : 'always',
          animate: el.getAttribute('data-animate') === 'true',
          hotspots: el.getAttribute('data-hotspots') === 'true',
          yaw: parseFloat(el.getAttribute('data-yaw') || '-0.45')
        });
        if (el.id === 'anatomyViewer') setupAnatomy(v);
      } catch (err) {
        console.warn('[3D] No se pudo iniciar el visor:', err);
        fallback(el);
      }
    });
  }).catch(function (err) {
    console.warn('[3D] No se pudo cargar three.js:', err);
    $$('.v3d').forEach(fallback);
    $$('.toolbar, .anatomy .hint-inline').forEach(function (t) { t.hidden = true; });
  });

  /* ─── Despiece interactivo ─── */
  function setupAnatomy(v) {
    var items = $$('#parts [data-hs]');
    var tools = {};
    $$('.toolbar [data-action]').forEach(function (b) { tools[b.getAttribute('data-action')] = b; });

    v.onFocus = function (id) {
      items.forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-hs') === id); });
    };
    items.forEach(function (b) {
      b.addEventListener('click', function () {
        /* en pantallas chicas la lista queda debajo del visor: subir hasta el modelo */
        if (window.innerWidth < 960) $('#anatomyStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
        v.focus(b.getAttribute('data-hs'));
      });
    });

    Object.keys(tools).forEach(function (k) {
      tools[k].addEventListener('click', function () {
        if (k === 'reset') {
          v.reset();
          tools.explode.setAttribute('aria-pressed', 'false');
          tools.dims.setAttribute('aria-pressed', 'false');
          tools.spin.setAttribute('aria-pressed', 'true');
          return;
        }
        var on = tools[k].getAttribute('aria-pressed') !== 'true';
        tools[k].setAttribute('aria-pressed', String(on));
        if (k === 'explode') {
          v.setExploded(on);
          if (on && tools.dims.getAttribute('aria-pressed') === 'true') {
            tools.dims.setAttribute('aria-pressed', 'false');
            v.setDims(false);
          }
        }
        if (k === 'dims') {
          v.setDims(on);
          if (on && tools.explode.getAttribute('aria-pressed') === 'true') {
            tools.explode.setAttribute('aria-pressed', 'false');
            v.setExploded(false);
          }
        }
        if (k === 'spin') v.setSpin(on);
      });
    });
  }

  /* ─── Modal 3D de cada kit ─── */
  var modal = $('#viewerModal');
  var modalViewer = null;

  function openModal(kit) {
    var card = $('.kit[data-kit="' + kit + '"]');
    if (!card || !modal) return;
    var name = $('h3', card).textContent;
    $('#modalTitle').textContent = name;
    $('#modalDesc').textContent = $('.kit-desc', card).textContent;
    $('#modalPrice').innerHTML = $('.kit-price', card).innerHTML;
    $('#modalIncludes').innerHTML = $('.checks', card).innerHTML;
    var buy = $('#modalBuy');
    buy.setAttribute('data-buy', kit);
    buy.textContent = 'Comprar ' + name;

    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
    document.documentElement.classList.add('modal-open');

    ready.then(function () {
      var el = $('#modalViewer');
      var yaw = parseFloat($('.v3d', card).getAttribute('data-yaw') || '-0.45');
      try {
        if (!modalViewer) modalViewer = api.create(el, { kit: kit, mode: 'orbit', yaw: yaw, margin: 1.02 });
        else { modalViewer.setKit(kit, yaw); modalViewer.resize(); modalViewer.reset(); }
      } catch (err) {
        el.setAttribute('data-fallback', $('.v3d', card).getAttribute('data-fallback'));
        fallback(el);
      }
    }).catch(function () {
      var el = $('#modalViewer');
      el.innerHTML = '';
      el.setAttribute('data-fallback', $('.v3d', card).getAttribute('data-fallback'));
      el.classList.remove('v3d--fallback');
      fallback(el);
    });
  }

  function closeModal() {
    if (!modal) return;
    if (typeof modal.close === 'function') modal.close();
    else { modal.removeAttribute('open'); document.documentElement.classList.remove('modal-open'); }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-open3d]');
    if (b) { e.preventDefault(); openModal(b.getAttribute('data-open3d')); }
  });
  if (modal) {
    $('.modal-close', modal).addEventListener('click', closeModal);
    modal.addEventListener('close', function () { document.documentElement.classList.remove('modal-open'); });
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  }

  /* ─── Año en el footer ─── */
  var y = $('#year');
  if (y) y.textContent = new Date().getFullYear();
})();
