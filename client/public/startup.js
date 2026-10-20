(() => {
  const showRecovery = () => {
    const shell = document.getElementById('app-startup');
    if (!shell) return;
    shell.querySelector('[data-startup-title]').textContent = '页面暂时没有加载完成';
    shell.querySelector('[data-startup-description]').textContent = '连接可能暂时中断，请重新加载页面。';
    shell.querySelector('[data-startup-recovery]').hidden = false;
  };
  window.addEventListener('error', showRecovery, true);
  window.addEventListener('unhandledrejection', showRecovery);
  window.setTimeout(showRecovery, 12000);
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('#startup-reload')) window.location.reload();
  });
})();
