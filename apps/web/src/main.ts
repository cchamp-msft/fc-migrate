import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useThemeStore } from "./stores/theme";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/backdrop.css";

const app = createApp(App);
app.use(createPinia());
useThemeStore();
app.use(router);
app.mount("#app");
