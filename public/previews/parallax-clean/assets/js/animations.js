// --- SETUP ---
gsap.registerPlugin(ScrollTrigger);

// --- LENIS SCROLL ---
const lenis = new Lenis({
  duration: 1.2,
  easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  direction: 'vertical',
  smooth: true,
});
function raf(time) {
  lenis.raf(time);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

// --- TEXT SPLITTER UTILITY ---
function splitTextToWords(element) {
  const text = element.innerText;
  const words = text.split(' ');
  element.innerHTML = '';
  words.forEach(word => {
    const wordWrap = document.createElement('span');
    wordWrap.classList.add('word-wrap');
    wordWrap.innerHTML = `<span class="word-inner">${word}&nbsp;</span>`;
    element.appendChild(wordWrap);
  });
}

// Apply split to all elements with class .split-animate
document.querySelectorAll('.split-animate').forEach(el => {
  splitTextToWords(el);
});

// --- LOADER ---
const loadTl = gsap.timeline({
  onComplete: () => {
    document.body.style.opacity = 1;
    initSite();
  }
});

loadTl.to('.loader-bar', { width: '100%', duration: 1.5, ease: 'power2.inOut' })
  .to('.loader-text', { y: -50, opacity: 0, duration: 0.5 })
  .to('.loader', { yPercent: -100, duration: 1, ease: 'power4.inOut' });

function initSite() {
  // Hero Animations
  gsap.to('.hero-text span', {
    y: 0,
    stagger: 0.1,
    duration: 1.5,
    ease: 'power4.out'
  });
  gsap.to('.hero-fade', { opacity: 1, duration: 1, delay: 0.5 });

  // Hero Parallax
  gsap.to('.hero-img', {
    yPercent: 30,
    ease: 'none',
    scrollTrigger: {
      trigger: '.hero-img',
      start: 'top top',
      end: 'bottom top',
      scrub: true
    }
  });

  // --- TEXT REVEAL ON SCROLL ---
  const splitElements = document.querySelectorAll('.split-animate');
  splitElements.forEach(el => {
    const words = el.querySelectorAll('.word-inner');
    gsap.to(words, {
      y: "0%",
      duration: 1,
      ease: "power3.out",
      stagger: 0.02,
      scrollTrigger: {
        trigger: el,
        start: "top 85%",
        toggleActions: "play none none reverse"
      }
    });
  });

  // --- CARD STACK ANIMATION ---
  const cards = gsap.utils.toArray('.card-item');

  cards.forEach((card, i) => {
    const nextCard = cards[i + 1];
    if (nextCard) {
      gsap.to(card.querySelector('.card-inner'), {
        scale: 0.9,
        opacity: 0.4,
        ease: "none",
        scrollTrigger: {
          trigger: nextCard,
          start: "top bottom",
          end: "top 10vh",
          scrub: true
        }
      });
    }
  });

  // Footer Parallax Effect
  gsap.from('.footer-sticky > div', {
    y: 100,
    opacity: 0.5,
    scale: 0.9,
    scrollTrigger: {
      trigger: '.footer-sticky',
      start: 'top bottom',
      end: 'bottom bottom',
      scrub: true
    }
  });
}
