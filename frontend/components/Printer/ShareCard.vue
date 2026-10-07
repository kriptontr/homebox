<script setup lang="ts">
  import { ref } from "vue";
  import { useI18n } from "vue-i18n";
  import { usePrinterHost } from "~/composables/use-printer-host";
  import { toast } from "@/components/ui/sonner";
  import { Switch } from "@/components/ui/switch";
  import { Label } from "@/components/ui/label";
  import { Badge } from "@/components/ui/badge";
  import MdiShareVariant from "~icons/mdi/share-variant";
  import MdiAlertCircleOutline from "~icons/mdi/alert-circle-outline";

  const { t } = useI18n();
  const { status, startSharing, stopSharing } = usePrinterHost();

  const starting = ref(false);

  async function onToggle(value: boolean) {
    if (!value) {
      stopSharing();
      return;
    }
    if (starting.value) return;
    starting.value = true;
    try {
      await startSharing();
      toast.success(t("components.printer.share.toast.started"));
    } catch (err) {
      console.error("failed to start printer sharing", err);
      toast.error(t("components.printer.share.toast.start_failed"));
    } finally {
      starting.value = false;
    }
  }
</script>

<template>
  <BaseCard>
    <template #title>
      <BaseSectionHeader>
        <MdiShareVariant class="mr-2" />
        <span>{{ $t("components.printer.share.title") }}</span>
        <template #description>{{ $t("components.printer.share.description") }}</template>
      </BaseSectionHeader>
    </template>

    <div class="flex flex-col gap-4 p-6">
      <div class="flex items-center gap-3">
        <Switch id="share-printer" :model-value="status.sharing" :disabled="starting" @update:model-value="onToggle" />
        <Label for="share-printer">{{ $t("components.printer.share.toggle") }}</Label>
      </div>

      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt class="text-muted-foreground">{{ $t("components.printer.share.printer") }}</dt>
        <dd>{{ status.printerName || $t("components.printer.share.no_printer") }}</dd>

        <dt class="text-muted-foreground">{{ $t("components.printer.share.status") }}</dt>
        <dd>
          <Badge v-if="!status.sharing" variant="secondary">{{ $t("components.printer.share.state.off") }}</Badge>
          <Badge v-else-if="!status.connected || !status.printerId" variant="outline">
            {{ $t("components.printer.share.state.connecting") }}
          </Badge>
          <Badge v-else-if="status.busy">{{ $t("components.printer.share.state.printing") }}</Badge>
          <Badge v-else>{{ $t("components.printer.share.state.sharing") }}</Badge>
        </dd>

        <dt class="text-muted-foreground">{{ $t("components.printer.share.jobs_printed") }}</dt>
        <dd>
          {{ status.jobsPrinted }}
          <span v-if="status.jobsFailed > 0" class="text-muted-foreground">
            ({{ $t("components.printer.share.jobs_failed", { count: status.jobsFailed }) }})
          </span>
        </dd>

        <template v-if="status.lastError">
          <dt class="text-muted-foreground">{{ $t("components.printer.share.last_error") }}</dt>
          <dd class="flex items-center gap-1 text-destructive">
            <MdiAlertCircleOutline class="shrink-0" />
            <span>{{ status.lastError }}</span>
          </dd>
        </template>
      </dl>

      <p class="text-sm text-muted-foreground">{{ $t("components.printer.share.keep_open") }}</p>
    </div>
  </BaseCard>
</template>
