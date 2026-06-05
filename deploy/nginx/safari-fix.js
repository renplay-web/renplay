(function () {
  'use strict';

  // WebKit (Safari/Orion) on macOS may generate pointerdown/pointerup instead
  // of mousedown/mouseup for trackpad taps on non-interactive elements.
  // Ren'Py's Emscripten SDL layer only listens for mousedown/mouseup on the
  // canvas, so we forward pointer events as mouse events.  Only activate in
  // WebKit to avoid double-dispatch in Blink/Firefox.

  var isWebKit = typeof navigator !== 'undefined' &&
    /AppleWebKit/i.test(navigator.userAgent) &&
    !/Chrome/i.test(navigator.userAgent);

  if (!isWebKit) return;

  function run() {
    var canvas = document.getElementById('canvas');
    var overlay = document.getElementById('overlayDiv');
    if (!canvas) return;

    canvas.removeAttribute('tabindex');
    canvas.style.cursor = 'pointer';

    function forward(overlayEl, srcType, dstType) {
      overlayEl.addEventListener(srcType, function (e) {
        e.preventDefault();
        canvas.dispatchEvent(new MouseEvent(dstType, {
          clientX: e.clientX,
          clientY: e.clientY,
          button: e.button,
          buttons: e.buttons,
          bubbles: true,
          cancelable: true,
        }));
        if (srcType === 'pointerup' && overlayEl !== canvas) {
          overlayEl.remove();
        }
      });
    }

    if (overlay) {
      overlay.style.cursor = 'pointer';
      forward(overlay, 'pointerdown', 'mousedown');
      forward(overlay, 'pointerup', 'mouseup');
      forward(overlay, 'pointermove', 'mousemove');
    }

    forward(canvas, 'pointerdown', 'mousedown');
    forward(canvas, 'pointerup', 'mouseup');
    forward(canvas, 'pointermove', 'mousemove');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
