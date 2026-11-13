import { createRouter, createWebHashHistory } from "vue-router";

export const router = createRouter({
  // Hash routing keeps deep links working on any static host.
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "overview", component: () => import("./views/OverviewView.vue") },
    { path: "/configuration", name: "configuration", component: () => import("./views/ConfigurationView.vue") },
    { path: "/cli", name: "cli", component: () => import("./views/CliView.vue") },
    { path: "/migrate", name: "migrate", component: () => import("./views/MigrateView.vue") },
    { path: "/bootstrap", name: "bootstrap", component: () => import("./views/BootstrapView.vue") },
    // Alpha Migrate is closed for repair: its page is off the site and old links go home.
    { path: "/alpha", redirect: "/" },
    { path: "/appearance", name: "appearance", component: () => import("./views/AppearanceView.vue") },
    { path: "/about", name: "about", component: () => import("./views/AboutView.vue") },
  ],
});
