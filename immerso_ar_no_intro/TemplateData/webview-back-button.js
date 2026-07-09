(function () {
  var button;
  var unityInstance;

  function getButton() {
    if (!button) button = document.getElementById("webview-back-button");
    return button;
  }

  function show() {
    var btn = getButton();
    if (btn) btn.style.display = "block";
  }

  function hide() {
    var btn = getButton();
    if (btn) btn.style.display = "none";
  }

  function sendToUnity(message) {
    if (!unityInstance || !unityInstance.SendMessage) {
      console.warn("Unity instance not ready. Message:", message);
      return;
    }

    // Change these names to match your Unity receiver object/script.
    unityInstance.SendMessage("WebViewBridge", "OnWebBackButton", message);
  }

  window.WebViewBackButton = {
    setUnityInstance: function (instance) {
      unityInstance = instance;
    },
    show: show,
    hide: hide
  };

  document.addEventListener("DOMContentLoaded", function () {
    var btn = getButton();
    if (!btn) return;

    btn.addEventListener("click", function () {
      sendToUnity("back");
    });
  });
})();
