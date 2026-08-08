// Render Lucide icons (any <i data-lucide> placeholders)
if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
}

// Mobile Menu Toggle
const menuBtn = document.getElementById('open-menu');
const closeBtn = document.getElementById('close-menu');
const mobileMenu = document.getElementById('mobile-menu');
const body = document.body;

function toggleMenu() {
    const isHidden = mobileMenu.classList.contains('hidden-menu');
    if (isHidden) {
        mobileMenu.classList.remove('hidden-menu');
        mobileMenu.classList.add('visible-menu');
        body.style.overflow = 'hidden';
    } else {
        mobileMenu.classList.remove('visible-menu');
        mobileMenu.classList.add('hidden-menu');
        body.style.overflow = '';
    }
}

if (menuBtn) menuBtn.addEventListener('click', toggleMenu);
if (closeBtn) closeBtn.addEventListener('click', toggleMenu);

// Scroll Animation Observer (reveal on scroll)
const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.1
};

const observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

document.querySelectorAll('.scroll-reveal').forEach(el => {
    observer.observe(el);
});

// FAQ accordion: toggle visibility of next sibling on click
document.querySelectorAll('[data-faq-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
        const panel = btn.nextElementSibling;
        if (panel) panel.classList.toggle('hidden');
    });
});

// Bento grid mouse-tracking glow
document.querySelectorAll('[data-bento-grid]').forEach(grid => {
    grid.addEventListener('mousemove', (event) => {
        for (const card of grid.children) {
            const rect = card.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            card.style.setProperty('--mouse-x', x + 'px');
            card.style.setProperty('--mouse-y', y + 'px');
        }
    });
});

// Unicorn Studio background loader
(function () {
    if (!window.UnicornStudio) {
        window.UnicornStudio = { isInitialized: false };
        const i = document.createElement('script');
        i.src = 'https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v1.4.29/dist/unicornStudio.umd.js';
        i.onload = function () {
            if (!window.UnicornStudio.isInitialized) {
                UnicornStudio.init();
                window.UnicornStudio.isInitialized = true;
            }
        };
        (document.head || document.body).appendChild(i);
    }
})();

// Image fallback handler — swaps broken images for known-good Supabase replacements
(function () {
    const f = [
        'https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/917d6f93-fb36-439a-8c48-884b67b35381_1600w.jpg',
        'https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/4734259a-bad7-422f-981e-ce01e79184f2_1600w.jpg',
        'https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/c543a9e1-f226-4ced-80b0-feb8445a75b9_1600w.jpg',
        'https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/5bab247f-35d9-400d-a82b-fd87cfe913d2_1600w.webp',
        'https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/30104e3c-5eea-4b93-93e9-5313698a7156_1600w.webp'
    ];
    const h = new Set();
    function g(s) {
        let x = 0;
        for (let i = 0; i < s.length; i++) x = (x << 5) - x + s.charCodeAt(i) | 0;
        return f[Math.abs(x) % f.length];
    }
    function r(t) {
        const s = t.src;
        if (s && !h.has(s)) {
            h.add(s);
            t.src = g(s);
        }
    }
    window.addEventListener('error', function (e) {
        const t = e.target;
        if (t && t.tagName === 'IMG') r(t);
    }, true);
    function c() {
        document.querySelectorAll('img').forEach(function (i) {
            if (i.complete && !i.naturalWidth && i.src) r(i);
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', c);
    } else {
        c();
    }
})();
