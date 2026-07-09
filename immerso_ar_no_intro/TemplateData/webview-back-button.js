(function () {
  "use strict";

  var unityInstance = null;
  var isNavigatingBack = false;
  var inputBlockTimeout = null;

  var settings = {
    unityGameObjectName: "Manager",
    unityMethodName: "GoToGameplaySceneFromHtml",
    buttonId: "webview-back-button",
    inputBlockDurationMs: 900
  };

  function getButton() {
    return document.getElementById(settings.buttonId);
  }

  function getUnityCanvas() {
    return document.getElementById("unity-canvas");
  }

  function setUnityInstance(instance) {
    unityInstance = instance;
    window.unityInstance = instance;
  }

  function blockUnityCanvasInput(durationMs) {
    var canvas = getUnityCanvas();

    if (!canvas) {
      return;
    }

    canvas.style.pointerEvents = "none";

    if (inputBlockTimeout) {
      clearTimeout(inputBlockTimeout);
    }

    inputBlockTimeout = setTimeout(function () {
      canvas.style.pointerEvents = "";
      inputBlockTimeout = null;
    }, durationMs);
  }

  function showWebViewBackButton() {
    var button = getButton();

    if (!button) {
      console.warn("WebView back button was not found.");
      return;
    }

    isNavigatingBack = false;

    button.style.display = "block";
    button.style.pointerEvents = "auto";
    button.style.opacity = "1";
  }

  function hideWebViewBackButton() {
    var button = getButton();

    if (!button) {
      return;
    }

    button.style.display = "none";
    button.style.pointerEvents = "none";
    button.style.opacity = "1";

    isNavigatingBack = false;
  }

  function sendBackMessageToUnity() {
    var instance = unityInstance || window.unityInstance;

    if (!instance) {
      console.warn("Unity instance is not ready yet.");
      return;
    }

    if (typeof instance.SendMessage !== "function") {
      console.warn("Unity SendMessage is not available.");
      return;
    }

    instance.SendMessage(
      settings.unityGameObjectName,
      settings.unityMethodName
    );
  }

  function stopEvent(event) {
    if (!event) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.stopImmediatePropagation) {
      event.stopImmediatePropagation();
    }
  }

  function goToGameplaySceneFromHtml(event) {
    stopEvent(event);

    if (isNavigatingBack) {
      return false;
    }

    isNavigatingBack = true;

    var button = getButton();

    if (button) {
      button.style.opacity = "0.65";
      button.style.pointerEvents = "auto";
    }

    // Important:
    // This prevents the same mobile tap from reaching the Unity gameplay UI.
    blockUnityCanvasInput(settings.inputBlockDurationMs);

    sendBackMessageToUnity();

    // Do not hide instantly.
    // Keeping it alive for a short moment prevents tap-through.
    setTimeout(function () {
      hideWebViewBackButton();
    }, settings.inputBlockDurationMs);

    return false;
  }

  function setUnityTarget(gameObjectName, methodName) {
    if (gameObjectName && gameObjectName.length > 0) {
      settings.unityGameObjectName = gameObjectName;
    }

    if (methodName && methodName.length > 0) {
      settings.unityMethodName = methodName;
    }
  }

  function initializeButton() {
    var button = getButton();

    if (!button) {
      console.warn("WebView back button was not found during initialization.");
      return;
    }

    button.addEventListener("pointerdown", goToGameplaySceneFromHtml, true);

    button.addEventListener("click", function (event) {
      stopEvent(event);
      return false;
    }, true);

    button.addEventListener("touchstart", function (event) {
      stopEvent(event);
      return false;
    }, { capture: true, passive: false });

    button.addEventListener("touchend", function (event) {
      stopEvent(event);
      return false;
    }, { capture: true, passive: false });

    hideWebViewBackButton();
  }

  window.WebViewBackButton = {
    setUnityInstance: setUnityInstance,
    show: showWebViewBackButton,
    hide: hideWebViewBackButton,
    goToGameplay: goToGameplaySceneFromHtml,
    setUnityTarget: setUnityTarget
  };

  window.showWebViewBackButton = showWebViewBackButton;
  window.hideWebViewBackButton = hideWebViewBackButton;
  window.goToGameplaySceneFromHtml = goToGameplaySceneFromHtml;
  window.setWebViewBackUnityTarget = setUnityTarget;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeButton);
  } else {
    initializeButton();
  }
})();
