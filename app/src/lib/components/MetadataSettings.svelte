<script lang="ts">
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { saveSettings } from "$lib/settings-store";
  import { i18n } from "$lib/i18n/index.svelte";
  import type { MetadataDisplayField } from "$lib/metadata";
  const m = $derived(i18n.m);
  let fields = $state<MetadataDisplayField[]>(
    JSON.parse(JSON.stringify(settingsStore.settings.metadataDisplayFields))
  );
  let error = $state(false);
  function move(index: number, delta: number) {
    const result = [...fields];
    [result[index], result[index + delta]] = [result[index + delta], result[index]];
    fields = result;
  }
  async function save() {
    try {
      settingsStore.setMetadataDisplayFields(fields);
      error = false;
      await saveSettings();
    } catch {
      error = true;
    }
  }
</script>

<details class="border-b py-2">
  <summary class="cursor-pointer py-2 text-xs font-semibold text-muted-foreground"
    >{m.metadata.fields}</summary
  >
  <div class="space-y-3 pb-2">
    {#each fields as field, index (index)}
      <div class="space-y-2 rounded border p-2">
        <div class="flex justify-end gap-2 text-xs">
          <button
            type="button"
            disabled={index === 0}
            onclick={() => move(index, -1)}
            class="disabled:opacity-30">{m.metadata.up}</button
          >
          <button
            type="button"
            disabled={index === fields.length - 1}
            onclick={() => move(index, 1)}
            class="disabled:opacity-30">{m.metadata.down}</button
          >
          <button type="button" onclick={() => (fields = fields.filter((_, i) => i !== index))}
            >{m.metadata.remove}</button
          >
        </div>
        <label class="block text-xs"
          >{m.metadata.key}<input
            class="mt-1 w-full rounded border bg-background p-1"
            maxlength="128"
            bind:value={field.key}
          /></label
        >
        <label class="block text-xs"
          >{m.metadata.label}<input
            class="mt-1 w-full rounded border bg-background p-1"
            maxlength="128"
            bind:value={field.label}
          /></label
        >
        <label class="block text-xs"
          >{m.metadata.mappings}<textarea
            class="mt-1 w-full rounded border bg-background p-1"
            rows="2"
            maxlength="8192"
            value={Object.entries(field.values)
              .map(([value, label]) => `${value}=${label}`)
              .join("\n")}
            onchange={(event) => {
              field.values = Object.fromEntries(
                event.currentTarget.value
                  .split("\n")
                  .filter((line) => line.includes("="))
                  .map((line) => {
                    const pos = line.indexOf("=");
                    return [line.slice(0, pos), line.slice(pos + 1)];
                  })
              );
            }}></textarea></label
        >
      </div>
    {/each}
    <div class="flex gap-3 text-sm">
      <button
        type="button"
        class="rounded border px-2 py-1 disabled:opacity-30"
        disabled={fields.length >= 12}
        onclick={() => (fields = [...fields, { key: "", label: "", values: {} }])}
        >{m.metadata.add}</button
      >
      <button type="button" class="rounded border px-2 py-1" onclick={save}
        >{m.metadata.save}</button
      >
    </div>
    {#if error}<p class="text-xs text-destructive" role="alert">
        {m.metadata.invalidSettings}
      </p>{/if}
  </div>
</details>
