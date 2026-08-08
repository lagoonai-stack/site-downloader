/* =========================================================
   Sanok Demo 9 — Interactions (rewritten from inline scripts)
   - Header scroll state
   - Hero slider (auto-rotate, click controls)
   - Portfolio filtering (Cubeportfolio-like)
   - Testimonials hover-switch
   - Reveal-on-scroll
   - Back-to-top
   ========================================================= */
(function(){
  'use strict';

  /* ---------- Header scroll state ---------- */
  var header = document.querySelector('.site-header');
  function onScroll(){
    if (!header) return;
    if (window.scrollY > 60) header.classList.add('scrolled');
    else header.classList.remove('scrolled');
    var bt = document.querySelector('.back-top');
    if (bt){
      if (window.scrollY > 300) bt.classList.add('show');
      else bt.classList.remove('show');
    }
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  onScroll();

  /* ---------- Hero slider ---------- */
  var slides = document.querySelectorAll('.hero-slide');
  var controls = document.querySelectorAll('.hero-control');
  var progress = document.querySelector('.hero-progress');
  var current = 0;
  var slideDuration = 6000;
  var slideTimer = null;
  var progressStart = 0;

  function showSlide(idx){
    slides.forEach(function(s, i){ s.classList.toggle('active', i === idx); });
    controls.forEach(function(c, i){ c.classList.toggle('active', i === idx); });
    current = idx;
    progressStart = Date.now();
    if (progress) progress.style.width = '0%';
  }

  function nextSlide(){
    showSlide((current + 1) % slides.length);
  }

  function tickProgress(){
    if (!progress || !slides.length) return;
    var elapsed = Date.now() - progressStart;
    var pct = Math.min(100, (elapsed / slideDuration) * 100);
    progress.style.width = pct + '%';
    requestAnimationFrame(tickProgress);
  }

  if (slides.length){
    showSlide(0);
    slideTimer = setInterval(nextSlide, slideDuration);
    requestAnimationFrame(tickProgress);
    controls.forEach(function(c, i){
      c.addEventListener('click', function(){
        clearInterval(slideTimer);
        showSlide(i);
        slideTimer = setInterval(nextSlide, slideDuration);
      });
    });
    var prev = document.querySelector('.hero-prev');
    var next = document.querySelector('.hero-next');
    if (prev) prev.addEventListener('click', function(){
      clearInterval(slideTimer);
      showSlide((current - 1 + slides.length) % slides.length);
      slideTimer = setInterval(nextSlide, slideDuration);
    });
    if (next) next.addEventListener('click', function(){
      clearInterval(slideTimer);
      nextSlide();
      slideTimer = setInterval(nextSlide, slideDuration);
    });
  }

  /* ---------- Portfolio filtering ---------- */
  var filters = document.querySelectorAll('.cbp-filter-item');
  var items = document.querySelectorAll('.cbp-item');
  filters.forEach(function(f){
    f.addEventListener('click', function(){
      filters.forEach(function(x){ x.classList.remove('active'); });
      f.classList.add('active');
      var filter = f.getAttribute('data-filter');
      items.forEach(function(it){
        if (filter === '*' || it.classList.contains(filter.replace('.',''))){
          it.style.display = '';
        } else {
          it.style.display = 'none';
        }
      });
    });
  });

  /* ---------- Testimonials hover switching ---------- */
  var tNavLinks = document.querySelectorAll('.testimonial-nav a');
  var tItems = document.querySelectorAll('.testimonial');
  function activateTestimonial(target){
    tNavLinks.forEach(function(n){ n.classList.toggle('active', n.getAttribute('data-target') === target); });
    tItems.forEach(function(t){ t.classList.toggle('active', t.id === target); });
  }
  tNavLinks.forEach(function(n){
    n.addEventListener('mouseenter', function(){ activateTestimonial(n.getAttribute('data-target')); });
    n.addEventListener('click', function(e){ e.preventDefault(); activateTestimonial(n.getAttribute('data-target')); });
  });

  /* ---------- Reveal on scroll ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length && 'IntersectionObserver' in window){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting){
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, {threshold:.12, rootMargin:'0px 0px -8% 0px'});
    revealEls.forEach(function(el){ io.observe(el); });
  } else {
    revealEls.forEach(function(el){ el.classList.add('in'); });
  }

  /* ---------- Smooth anchor scrolling ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function(a){
    a.addEventListener('click', function(e){
      var hash = a.getAttribute('href');
      if (hash.length > 1){
        var t = document.querySelector(hash);
        if (t){
          e.preventDefault();
          window.scrollTo({top: t.getBoundingClientRect().top + window.scrollY - 40, behavior:'smooth'});
        }
      }
    });
  });
})();
