import { createApp } from "vue";
import { createHomelabVuetify } from "@rackmarten/ui-kit";
import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import App from "./App.vue";
import { installInAppLinks, router } from "./router.js";

document.title = "Pinboard";

const vuetify = createHomelabVuetify({ accent: "#3fae6a" });

// phone push moved to ntfy. Drop the old Web Push service worker
// (and with it the device's push subscription) wherever it's still installed.
void navigator.serviceWorker?.getRegistrations().then((regs) => regs.forEach((r) => void r.unregister()));
installInAppLinks(router);

createApp(App).use(router).use(vuetify).mount("#app");
