// Tab switching logic
function switchTab(tabName, btn) {
  const allBtns = document.querySelectorAll('.icon-btn');
  allBtns.forEach(b => {
    b.classList.remove('active', 'text-white');
    b.classList.add('text-white/40');
  });
  btn.classList.add('active', 'text-white');
  btn.classList.remove('text-white/40');

  const contents = document.querySelectorAll('.tab-content');
  contents.forEach(c => c.classList.add('hidden'));

  const target = document.getElementById(`tab-${tabName}`);
  if (target) {
    target.classList.remove('hidden');
    target.style.animation = 'none';
    target.offsetHeight; /* trigger reflow */
    target.style.animation = null;
  }
}

// Internal scroll logic
const scrollContainer = document.getElementById('main-scroll-container');

function scrollToSection(id) {
  const element = document.getElementById(id);
  if (element) {
    const topPos = element.offsetTop;
    scrollContainer.scrollTo({
      top: topPos,
      behavior: 'smooth'
    });
  }
}

function scrollToTop() {
  scrollContainer.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
}

// Intersection Observer for scroll animations
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
    }
  });
}, {
  root: scrollContainer,
  threshold: 0.1
});

document.querySelectorAll('.feature-card').forEach((el) => {
  observer.observe(el);
});
