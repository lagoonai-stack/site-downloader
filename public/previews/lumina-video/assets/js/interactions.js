// Initialize Lucide icons and wire up the interactive Steps + Card Stack.
lucide.createIcons({
  attrs: {
    'stroke-width': 1.5
  }
});

let currentStep = 1;

function activateStep(step) {
  if (step === currentStep) return;

  // Update UI for Steps List
  const prevStep = currentStep;
  currentStep = step;
  updateStepStyles(prevStep, step);

  // Update Stack Visuals
  updateCardStack(step);
}

function updateCardStack(activeId) {
  const cards = [1, 2, 3];

  cards.forEach(id => {
    const card = document.getElementById(`card-${id}`);

    if (id === activeId) {
      // Active Card: Front, Opaque, Full Scale
      card.style.transform = 'translateY(0px) scale(1)';
      card.style.zIndex = '30';
      card.style.opacity = '1';
    } else {
      const relativePos = (id - activeId + 3) % 3;

      if (relativePos === 1) {
        // Middle of stack
        card.style.transform = 'translateY(12px) scale(0.95)';
        card.style.zIndex = '20';
        card.style.opacity = '0.6';
      } else {
        // Bottom of stack
        card.style.transform = 'translateY(24px) scale(0.9)';
        card.style.zIndex = '10';
        card.style.opacity = '0.4';
      }
    }
  });
}

function updateStepStyles(prev, next) {
  // Reset Previous
  const prevStepEl = document.getElementById(`step-${prev}`);
  const prevBadge = document.getElementById(`badge-${prev}`);
  const prevText = document.getElementById(`text-${prev}`);
  const prevIcon = document.getElementById(`icon-${prev}`);

  prevStepEl.className = "step-item flex items-center gap-4 p-2 rounded-lg hover:bg-white/5 border border-transparent transition-all duration-300 cursor-pointer group";
  prevBadge.className = "w-6 h-6 rounded-full bg-transparent flex items-center justify-center text-[10px] font-bold text-gray-500 group-hover:text-orange-400 transition-colors duration-300";
  prevText.className = "text-sm font-medium text-gray-400 group-hover:text-white transition-colors duration-300";
  prevIcon.classList.add('opacity-0', 'text-gray-600');
  prevIcon.classList.remove('opacity-100', 'text-orange-500');

  // Set Active
  const nextStepEl = document.getElementById(`step-${next}`);
  const nextBadge = document.getElementById(`badge-${next}`);
  const nextText = document.getElementById(`text-${next}`);
  const nextIcon = document.getElementById(`icon-${next}`);

  nextStepEl.className = "step-item flex items-center gap-4 p-2 rounded-lg bg-white/5 border border-white/10 backdrop-blur-md translate-x-[-10px] shadow-xl cursor-pointer transition-all duration-300";
  nextBadge.className = "w-6 h-6 rounded-full bg-orange-500 flex items-center justify-center text-[10px] font-bold text-black shadow-lg shadow-orange-500/20 transition-colors duration-300";
  nextText.className = "text-sm font-medium text-white transition-colors duration-300";
  nextIcon.classList.remove('opacity-0', 'text-gray-600');
  nextIcon.classList.add('opacity-100', 'text-orange-500');
}
