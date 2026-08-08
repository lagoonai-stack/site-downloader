// Custom Cursor Logic
const cursor = document.getElementById('cursor');
const hoverElements = document.querySelectorAll('.cursor-hover');

document.addEventListener('mousemove', (e) => {
    cursor.style.left = e.clientX + 'px';
    cursor.style.top = e.clientY + 'px';
});

hoverElements.forEach(el => {
    el.addEventListener('mouseenter', () => cursor.classList.add('hovered'));
    el.addEventListener('mouseleave', () => cursor.classList.remove('hovered'));
});

// Preloader Logic
window.addEventListener('load', () => {
    const progress = document.getElementById('loader-progress');
    const preloader = document.getElementById('preloader');

    let loadVal = 0;
    const loadInterval = setInterval(() => {
        loadVal += Math.floor(Math.random() * 10) + 5;
        if (loadVal > 100) loadVal = 100;
        progress.style.width = loadVal + '%';

        if (loadVal === 100) {
            clearInterval(loadInterval);
            setTimeout(() => {
                preloader.classList.add('loaded');
                document.querySelector('#hero').classList.add('hero-revealed');
                setTimeout(revealOnScroll, 500);
            }, 500);
        }
    }, 50);
});

// PARALLAX ENGINE
let ticking = false;

function updateParallax() {
    const parallaxElements = document.querySelectorAll('.parallax-element');
    const scrollTop = window.scrollY;
    const windowHeight = window.innerHeight;

    parallaxElements.forEach(el => {
        const speed = parseFloat(el.getAttribute('data-parallax-speed')) || 0.1;
        const rect = el.parentElement.getBoundingClientRect();
        const elementTop = rect.top;
        const elementHeight = rect.height;

        if (elementTop < windowHeight && elementTop + elementHeight > 0) {
            let yPos = 0;
            const center = windowHeight / 2;
            const elCenter = elementTop + (elementHeight / 2);
            const diff = center - elCenter;
            yPos = diff * speed;

            el.style.transform = `translateY(${yPos}px)`;
        }
    });
    ticking = false;
}

window.addEventListener('scroll', () => {
    if (!ticking) {
        window.requestAnimationFrame(updateParallax);
        ticking = true;
    }
}, { passive: true });

updateParallax();

// Reveal on Scroll
function revealOnScroll() {
    const reveals = document.querySelectorAll('.reveal');
    const windowHeight = window.innerHeight;
    const elementVisible = 100;

    reveals.forEach((reveal) => {
        const elementTop = reveal.getBoundingClientRect().top;
        if (elementTop < windowHeight - elementVisible) {
            reveal.classList.add('active');
            const counters = reveal.querySelectorAll('.counter');
            counters.forEach(counter => {
                if (!counter.classList.contains('counted')) {
                    counter.classList.add('counted');
                    animateCounter(counter);
                }
            });
        }
    });
}
window.addEventListener('scroll', revealOnScroll);

// Counter
function animateCounter(el) {
    const target = +el.getAttribute('data-target');
    const duration = 2000;
    const step = target / (duration / 16);
    let current = 0;
    const timer = setInterval(() => {
        current += step;
        if (current >= target) {
            el.innerText = target + (target > 100 ? '+' : '');
            clearInterval(timer);
        } else {
            el.innerText = Math.ceil(current) + (target > 100 ? '+' : '');
        }
    }, 16);
}

// CAROUSEL STACK LOGIC
const cardsContainer = document.getElementById('cards-container');
const dots = [
    document.getElementById('dot-1'),
    document.getElementById('dot-2'),
    document.getElementById('dot-3'),
    document.getElementById('dot-4')
];

let currentCard = 1;
let isAnimating = false;

function updateDots() {
    if (!cardsContainer) return;
    dots.forEach((dot, index) => {
        if (index === currentCard - 1) {
            dot.className = 'cursor-hover w-3 h-3 rounded-full bg-[#007bff] transition-all duration-300 scale-125 shadow-[0_0_10px_#007bff]';
        } else {
            dot.className = 'cursor-hover w-2 h-2 rounded-full bg-white/20 hover:bg-white/50 transition-all duration-300';
        }
    });
}

function setActiveCard(cardNumber) {
    if (!cardsContainer) return;
    if (isAnimating || cardNumber === currentCard) return;

    isAnimating = true;
    cardsContainer.className = `stack-section card-${cardNumber}-active relative`;
    currentCard = cardNumber;
    updateDots();

    setTimeout(() => {
        isAnimating = false;
    }, 800);
}

dots.forEach((dot, index) => {
    if (dot) {
        dot.addEventListener('click', () => {
            setActiveCard(index + 1);
        });
    }
});

// Auto-rotate cards
if (cardsContainer) {
    setInterval(() => {
        if (!isAnimating) {
            const nextCard = currentCard === 4 ? 1 : currentCard + 1;
            setActiveCard(nextCard);
        }
    }, 5000);
}

// SERVICES TAB SWITCHING LOGIC
const tabs = document.querySelectorAll('.tab-btn');
const grids = document.querySelectorAll('.service-grid');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => {
            t.className = 'tab-btn cursor-hover px-6 py-2 text-xs font-semibold uppercase tracking-wide rounded text-gray-400 hover:text-white hover:bg-white/5 transition-all duration-300';
        });
        tab.className = 'tab-btn cursor-hover px-6 py-2 text-xs font-semibold uppercase tracking-wide rounded bg-[#007bff]/80 backdrop-blur-md text-white shadow-lg shadow-blue-900/20 transition-all duration-300';

        const target = tab.getAttribute('data-tab');
        grids.forEach(grid => {
            if (grid.id === `grid-${target}`) {
                grid.classList.remove('hidden');
                requestAnimationFrame(() => {
                    grid.classList.remove('opacity-0', 'transform', 'translate-y-4');
                });
            } else {
                grid.classList.add('opacity-0', 'transform', 'translate-y-4');
                setTimeout(() => {
                    if (grid.id !== `grid-${target}`) grid.classList.add('hidden');
                }, 500);
            }
        });
    });
});

// PORTFOLIO FILTER LOGIC
const filterButtons = document.querySelectorAll('#portfolio-filter .filter-btn');
const galleryItems = document.querySelectorAll('.gallery-item');

filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        filterButtons.forEach(b => {
            b.className = 'filter-btn cursor-pointer px-4 py-2 text-[10px] uppercase tracking-widest font-semibold text-gray-500 hover:text-white transition-all duration-300 rounded-full';
            b.innerHTML = b.textContent.trim();
        });

        btn.className = 'filter-btn cursor-pointer px-4 py-2 text-[10px] uppercase tracking-widest font-semibold text-white bg-white/10 rounded-full shadow-inner transition-all duration-300 flex items-center gap-2';
        const text = btn.textContent.trim();
        btn.innerHTML = `<span class="w-2 h-2 rounded-full bg-[#007bff] shadow-[0_0_10px_#007bff]"></span> ${text}`;

        const filter = btn.getAttribute('data-filter');

        galleryItems.forEach(item => {
            if (filter === 'all' || item.getAttribute('data-category') === filter) {
                item.classList.remove('hidden-item');
                requestAnimationFrame(() => {
                    item.classList.remove('fading-out');
                });
            } else {
                item.classList.add('fading-out');
                setTimeout(() => {
                    item.classList.add('hidden-item');
                }, 500);
            }
        });
    });
});
