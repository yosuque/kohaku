<script setup lang="ts">
import { onMounted, ref } from "vue";

const props = defineProps<{ code: string }>();
const host = ref<HTMLElement | null>(null);
let counter = 0;

onMounted(async () => {
  const { default: mermaid } = await import("mermaid");
  const dark = document.documentElement.classList.contains("dark");
  // mermaid 12 defaults to the ELK layout engine and a new look; keep the dagre layout and classic look the
  // design diagrams were written and reviewed with.
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", layout: "dagre", look: "classic" });
  counter += 1;
  const { svg } = await mermaid.render(`kohaku-mermaid-${counter}-${Date.now()}`, props.code);
  if (host.value != null) host.value.innerHTML = svg;
});
</script>

<template>
  <div ref="host" class="kohaku-mermaid"><pre>{{ code }}</pre></div>
</template>

<style scoped>
.kohaku-mermaid { margin: 16px 0; overflow-x: auto; }
.kohaku-mermaid :deep(svg) { max-width: 100%; height: auto; }
</style>
