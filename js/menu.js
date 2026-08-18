/**
 * Header dropdown menus.
 *
 * The toolbar previously carried eleven buttons in a 48px row. Grouping the
 * import and export actions behind two triggers keeps the same actions (and the
 * same element ids, so shortcuts and tests are unaffected) without the clutter.
 *
 * Menus close on selection, on outside click, on Escape, and on window blur.
 */

(function () {
  function closeAll(except) {
    document.querySelectorAll('[data-menu].open').forEach(menu => {
      if (menu === except) return;
      menu.classList.remove('open');
      const trigger = menu.querySelector('[data-menu-trigger]');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function bind() {
    const menus = document.querySelectorAll('[data-menu]');

    menus.forEach(menu => {
      const trigger = menu.querySelector('[data-menu-trigger]');
      const panel = menu.querySelector('[data-menu-panel]');
      if (!trigger || !panel) return;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        closeAll(menu);
        menu.classList.toggle('open', willOpen);
        trigger.setAttribute('aria-expanded', String(willOpen));
      });

      // Selecting an action always dismisses the menu. Listening on the panel
      // rather than each item means items added later still work. Items marked
      // keep-open are settings for the actions below them rather than actions
      // themselves — closing on those would mean reopening the menu to use the
      // choice just made.
      panel.addEventListener('click', (e) => {
        if (e.target.closest('[data-menu-keep-open]')) return;
        if (e.target.closest('.menu-item')) closeAll();
      });
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-menu]')) closeAll();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll();
    });

    window.addEventListener('blur', () => closeAll());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.closeAllMenus = closeAll;
})();
