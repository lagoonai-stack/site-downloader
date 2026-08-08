// Initialize Chart.js line chart for the Recovery Trajectory card
(function initChart() {
    const canvas = document.getElementById('recoveryChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Custom Gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(20, 184, 166, 0.15)'); // Teal 500 low opacity
    gradient.addColorStop(1, 'rgba(20, 184, 166, 0)');

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun'],
            datasets: [
                {
                    label: 'VITALIS',
                    data: [65, 78, 82, 85, 88, 92],
                    borderColor: '#14b8a6', // Teal 500
                    backgroundColor: gradient,
                    borderWidth: 2,
                    tension: 0.4,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#14b8a6',
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    fill: true
                },
                {
                    label: 'Média Nacional',
                    data: [45, 48, 52, 51, 54, 56],
                    borderColor: '#cbd5e1', // Slate 300
                    borderWidth: 2,
                    borderDash: [6, 6],
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#0f172a',
                    padding: 12,
                    titleFont: { family: 'Inter', size: 12, weight: 600 },
                    bodyFont: { family: 'Inter', size: 12 },
                    cornerRadius: 4,
                    displayColors: false,
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.parsed.y + '%';
                        }
                    }
                }
            },
            scales: {
                y: {
                    display: true,
                    beginAtZero: true,
                    max: 100,
                    grid: { color: '#f1f5f9', drawBorder: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: '#94a3b8', padding: 10 }
                },
                x: {
                    display: true,
                    grid: { display: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: '#94a3b8', padding: 10 }
                }
            },
            interaction: {
                intersect: false,
                mode: 'index',
            },
            animation: {
                duration: 2000,
                easing: 'easeOutQuart'
            }
        }
    });
})();
