// Disable Lenis and ensure native scroll
(function () {
  // Prevent Lenis from being created
  var originalLenis = window.Lenis;
  window.Lenis = function () {
    console.log('Lenis disabled for offline compatibility');
    return {
      destroy: function () {},
      raf: function () {},
      scrollTo: function () {}
    };
  };

  // Force overflow on load
  function forceScroll() {
    document.documentElement.style.setProperty('overflow-y', 'auto', 'important');
    document.body.style.setProperty('overflow-y', 'auto', 'important');
    document.body.style.opacity = '1';

    // Hide loaders
    var loaders = document.querySelectorAll('.loader, .preloader');
    loaders.forEach(function (l) {
      l.style.display = 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', forceScroll);
  } else {
    forceScroll();
  }

  window.addEventListener('load', forceScroll);
  setTimeout(forceScroll, 100);
  setTimeout(forceScroll, 500);
})();
