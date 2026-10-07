<template>
  <BaseContainer class="flex flex-col gap-4">
    <BaseCard>
      <template #title>
        <BaseSectionHeader>
          <MdiPrinter class="mr-2" />
          <span>{{ $t("menu.cat_printer") || "Cat Printer" }}</span>
          <template #description>Print custom text to a bluetooth thermal printer</template>
        </BaseSectionHeader>
      </template>

      <div class="flex flex-col gap-4 p-6">
        <div>
          <Label for="text-to-print" class="mb-2 block">Text to Print</Label>
          <Textarea id="text-to-print" v-model="text" rows="5" placeholder="Enter text here..." class="w-full" />
        </div>

        <div>
          <Label class="mb-2 block">Font Size</Label>
          <Select v-model="fontSize">
            <SelectTrigger class="w-full max-w-sm">
              <SelectValue placeholder="Select size" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="24">Small</SelectItem>
                <SelectItem value="48">Medium</SelectItem>
                <SelectItem value="72">Big</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div class="flex flex-wrap items-center gap-4 pt-4">
          <Button :disabled="printing || remotePrinting || !text.trim()" @click="printText">
            <MdiLoading v-if="printing" class="mr-2 animate-spin" />
            <MdiPrinterPos v-else class="mr-2" />
            Print via Bluetooth
          </Button>

          <template v-if="sharedPrinters.length > 0">
            <Select v-if="sharedPrinters.length > 1" v-model="selectedPrinterId" :disabled="remotePrinting">
              <SelectTrigger class="w-auto min-w-48">
                <SelectValue :placeholder="$t('components.printer.remote.select_printer')" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem v-for="p in sharedPrinters" :key="p.id" :value="p.id">
                    {{ $t("components.printer.remote.printer_option", { name: p.name, sharedBy: p.sharedBy }) }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              :disabled="printing || remotePrinting || !selectedPrinterId || !text.trim()"
              @click="printTextRemote"
            >
              <MdiLoading v-if="remotePrinting" class="mr-2 animate-spin" />
              <MdiPrinterPos v-else class="mr-2" />
              {{ $t("components.printer.remote.print") }}
            </Button>
          </template>
        </div>
      </div>
    </BaseCard>

    <PrinterShareCard />
  </BaseContainer>
</template>

<script setup lang="ts">
  import { ref } from "vue";
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import { BLACK_THRESHOLD, PRINTER_WIDTH, useCatPrinter } from "~/composables/use-cat-printer";
  import { useSharedPrinters } from "~/composables/use-shared-printers";
  import { bitmapToBase64 } from "~~/lib/api/classes/printers";
  import MdiPrinter from "~icons/mdi/printer";
  import MdiPrinterPos from "~icons/mdi/printer-pos";
  import MdiLoading from "~icons/mdi/loading";
  import { Label } from "@/components/ui/label";
  import { Textarea } from "@/components/ui/textarea";
  import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
  import { Button } from "@/components/ui/button";

  const { t } = useI18n();

  definePageMeta({
    middleware: ["auth"],
  });
  useHead({
    title: "HomeBox | " + (t("menu.cat_printer") || "Cat Printer"),
  });

  const text = ref("");
  const fontSize = ref("48");
  const printing = ref(false);

  const { printJobBitmap, rgbaToBits } = useCatPrinter();

  const {
    printers: sharedPrinters,
    selectedId: selectedPrinterId,
    sending: remotePrinting,
    refresh: refreshSharedPrinters,
    print: printOnShared,
  } = useSharedPrinters();

  onMounted(() => {
    refreshSharedPrinters();
  });

  function generateTextBitmap(textStr: string, size: number) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas 2d context");

    canvas.width = PRINTER_WIDTH;
    // We will resize height after calculating text height
    canvas.height = PRINTER_WIDTH;

    const lines = textStr.split("\n");
    const padding = 20;
    const lineHeight = size * 1.2;

    // First pass: wrap text and calculate total height
    ctx.font = `bold ${size}px sans-serif`;
    const wrappedLines: string[] = [];

    for (const line of lines) {
      if (!line) {
        wrappedLines.push("");
        continue;
      }
      let currentLine = "";
      const words = line.split(" ");

      for (const word of words) {
        const testLine = currentLine + (currentLine ? " " : "") + word;
        const metrics = ctx.measureText(testLine);
        if (metrics.width > PRINTER_WIDTH - padding * 2 && currentLine !== "") {
          wrappedLines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      wrappedLines.push(currentLine);
    }

    // Canvas dimensions are integers; round explicitly so height matches the bitmap.
    const totalHeight = Math.ceil(padding * 2 + wrappedLines.length * lineHeight);
    canvas.height = totalHeight;

    // Second pass: Draw text
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "black";
    ctx.textBaseline = "top";
    ctx.font = `bold ${size}px sans-serif`;

    let y = padding;
    for (const line of wrappedLines) {
      ctx.fillText(line, padding, y);
      y += lineHeight;
    }

    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      data: rgbaToBits(new Uint32Array(rgba.data.buffer), BLACK_THRESHOLD),
    };
  }

  function currentBitmap() {
    return generateTextBitmap(text.value, parseInt(fontSize.value, 10));
  }

  async function printText() {
    if (printing.value) return;
    printing.value = true;

    try {
      await printJobBitmap(currentBitmap());

      toast.success(t("components.global.label_maker.toast.print_success") || "Printed successfully");
    } catch (error) {
      console.error("Error during printing:", error);
      toast.error(t("components.global.label_maker.toast.print_failed") || "Failed to print");
    } finally {
      printing.value = false;
    }
  }

  async function printTextRemote() {
    if (remotePrinting.value || !text.value.trim()) return;

    let bitmap;
    try {
      bitmap = currentBitmap();
    } catch (error) {
      console.error("Error rendering text:", error);
      toast.error(t("components.global.label_maker.toast.print_failed"));
      return;
    }

    const result = await printOnShared({
      kind: "bitmap",
      width: bitmap.width,
      height: bitmap.height,
      data: bitmapToBase64(bitmap.data),
    });

    if (result.ok) {
      toast.success(t("components.global.label_maker.toast.print_success"));
    } else {
      toast.error(result.message || t("components.global.label_maker.toast.print_failed"));
    }
  }
</script>
