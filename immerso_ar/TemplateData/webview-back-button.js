(function () {
  "use strict";

  var unityInstance = null;

  var settings = {
    unityGameObjectName: "Manager",
    unityMethodName: "GoToGameplaySceneFromHtml",
    buttonId: "webview-back-button"
  };

  function getButton() {
    return document.getElementById(settings.buttonId);
  }

  function setUnityInstance(instance) {
    unityInstance = instance;
    window.unityInstance = instance;
  }

  function showWebViewBackButton() {
    var button = getButton();

    if (!button) {
      console.warn("WebView back button was not found.");
      return;
    }

    button.style.display = "block";
    button.style.pointerEvents = "auto";
  }

  function hideWebViewBackButton() {
    var button = getButton();

    if (!button) {
      return;
    }

    button.style.display = "none";
    button.style.pointerEvents = "none";
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

  function goToGameplaySceneFromHtml() {
    hideWebViewBackButton();
    sendBackMessageToUnity();
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

    button.addEventListener("pointerup", function (event) {
      event.preventDefault();
      event.stopPropagation();

      goToGameplaySceneFromHtml();
    });

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