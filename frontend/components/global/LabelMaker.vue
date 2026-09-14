<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { route } from "../../lib/api/base";
  import { CatPrinter } from "./cat-protocol";
  import { CAT_ADV_SRV, CAT_PRINT_SRV, CAT_PRINT_TX_CHAR, CAT_PRINT_RX_CHAR } from "./constants";
  import PageQRCode from "./PageQRCode.vue";
  import { toast } from "@/components/ui/sonner";
  import MdiLoading from "~icons/mdi/loading";
  import MdiPrinterPos from "~icons/mdi/printer-pos";
  import MdiFileDownload from "~icons/mdi/file-download";
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogDescription,
  } from "@/components/ui/dialog";
  import { useDialog } from "@/components/ui/dialog-provider";
  import { Button, ButtonGroup } from "@/components/ui/button";
  import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

  const { t } = useI18n();
  const { openDialog, closeDialog } = useDialog();

  const props = defineProps<{
    type: string;
    id: string;
  }>();

  const pubApi = usePublicApi();

  const { data: status } = useAsyncData(async () => {
    const { data, error } = await pubApi.status();
    if (error) {
      toast.error(t("components.global.label_maker.toast.load_status_failed"));
      return;
    }

    return data;
  });

  const serverPrinting = ref(false);
  const bluetoothPrinting = ref(false);

  let printer: CatPrinter | null = null;
  let device: BluetoothDevice | null = null;

  // Print head is 384 dots wide; anything wider gets scaled down before printing.
  const PRINTER_WIDTH = 384;
  const QUIET_ZONE_ROWS = 24;
  const BLACK_THRESHOLD = 170;
  const PRINT_SPEED = 32;
  const PRINT_ENERGY = 24000;
  const FINISH_FEED = 80;

  function browserPrint() {
    const printWindow = window.open(getLabelUrl(false), "popup=true");

    if (printWindow !== null) {
      printWindow.onload = () => {
        printWindow.print();
      };
    }
  }

  async function serverPrint() {
    serverPrinting.value = true;
    try {
      await fetch(getLabelUrl(true));
    } catch (err) {
      console.error("Failed to print labels:", err);
      serverPrinting.value = false;
      toast.error(t("components.global.label_maker.toast.print_failed"));
      return;
    }

    toast.success(t("components.global.label_maker.toast.print_success"));
    closeDialog("print-label");
    serverPrinting.value = false;
  }

  function downloadLabel() {
    const link = document.createElement("a");
    link.download = `label-${props.id}.png`;
    link.href = getLabelUrl(false);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function getLabelUrl(print: boolean): string {
    const params = { print };

    if (props.type === "item") {
      return route(`/labelmaker/item/${props.id}`, params);
    } else if (props.type === "location") {
      return route(`/labelmaker/location/${props.id}`, params);
    } else if (props.type === "asset") {
      return route(`/labelmaker/asset/${props.id}`, params);
    } else {
      throw new Error(`Unexpected labelmaker type ${props.type}`);
    }
  }
  type LabelBitmap = { width: number; height: number; data: Uint8Array };

  // Pack RGBA pixels into 1 bit per pixel, LSB-first, 1 = black.
  // Inlined because the SDK's package exports map has no "types" condition,
  // so importing its rgbaToBits resolves at runtime but not for typecheck.
  function rgbaToBits(rgba: Uint32Array, threshold: number): Uint8Array {
    const out = new Uint8Array(Math.ceil(rgba.length / 8));
    for (let i = 0; i < rgba.length; i++) {
      const px = rgba[i];
      const r = px & 0xff;
      const g = (px >> 8) & 0xff;
      const b = (px >> 16) & 0xff;
      if ((r + g + b) / 3 < threshold) {
        out[i >> 3] |= 1 << i % 8;
      }
    }
    return out;
  }

  // Render the label PNG into a 1-bit bitmap sized exactly for the print head.
  async function labelToBitmap(): Promise<LabelBitmap> {
    // Fetch through the app origin so the session cookie authenticates the request.
    // The SDK loads images with crossOrigin="anonymous", which strips that cookie.
    const res = await fetch(getLabelUrl(false), { credentials: "include" });
    if (!res.ok) {
      throw new Error(`failed to load label: ${res.status}`);
    }

    const objectUrl = URL.createObjectURL(await res.blob());
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("failed to decode label image"));
        img.src = objectUrl;
      });

      // Never upscale past the head width, and never resample a label that already
      // fits: resampling blurs the QR module edges and the threshold pass then eats
      // them, which is why only part of the code came out.
      const scale = Math.min(1, PRINTER_WIDTH / img.width);
      const drawWidth = Math.round(img.width * scale);
      const drawHeight = Math.round(img.height * scale);
      const height = drawHeight + QUIET_ZONE_ROWS * 2;

      const canvas = document.createElement("canvas");
      canvas.width = PRINTER_WIDTH;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("canvas 2d context unavailable");
      }

      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Inset vertically so the QR code keeps the quiet zone a scanner needs.
      ctx.drawImage(img, 0, QUIET_ZONE_ROWS, drawWidth, drawHeight);

      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        width: canvas.width,
        height,
        data: rgbaToBits(new Uint32Array(rgba.data.buffer), BLACK_THRESHOLD),
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  // Connect over Web Bluetooth and drive cat-protocol.ts over the GATT TX
  // characteristic. The @opuu SDK is not used for printing: it parses the
  // printer's "paused" (buffer-full) flag but never waits on it, and never
  // sends the Lattice begin/end markers, so a tall bitmap overruns the device
  // FIFO partway through and the remaining rows collapse together.
  async function connectPrinter(): Promise<CatPrinter> {
    if (printer && device?.gatt?.connected) {
      return printer;
    }

    if (!navigator.bluetooth) {
      throw new Error("Bluetooth API is not available in this browser");
    }

    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [CAT_ADV_SRV] }],
      optionalServices: [CAT_PRINT_SRV],
    });

    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(CAT_PRINT_SRV);
    const tx = await service.getCharacteristic(CAT_PRINT_TX_CHAR);
    const rx = await service.getCharacteristic(CAT_PRINT_RX_CHAR);

    const instance = new CatPrinter(device.name ?? "", data => tx.writeValueWithoutResponse(data as BufferSource));

    // Feed notifications back in so flush() can block while the printer is
    // paused. This is the backpressure the squeezed output was missing.
    await rx.startNotifications();
    rx.addEventListener("characteristicvaluechanged", event => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value) {
        instance.notify(new Uint8Array(value.buffer));
      }
    });

    device.addEventListener("gattserverdisconnected", () => {
      printer = null;
      device = null;
    });

    printer = instance;
    return instance;
  }

  const bluetoothPrint = async () => {
    if (bluetoothPrinting.value) {
      return;
    }
    bluetoothPrinting.value = true;

    try {
      const cat = await connectPrinter();
      const bitmap = await labelToBitmap();

      // prepare() sends speed/energy and startLattice; finish() sends
      // endLattice plus the trailing feed.
      await cat.prepare(PRINT_SPEED, PRINT_ENERGY);

      const bytesPerRow = Math.ceil(bitmap.width / 8);
      for (let row = 0; row < bitmap.height; row++) {
        const start = row * bytesPerRow;
        // Send every row, blank ones included: dropping them is what
        // compresses the label vertically. draw() buffers to the MTU and
        // flush() waits while the printer reports paused.
        await cat.draw(bitmap.data.slice(start, start + bytesPerRow));
      }

      await cat.finish(FINISH_FEED);

      toast.success(t("components.global.label_maker.toast.print_success"));
      closeDialog("print-label");
    } catch (error) {
      console.error("Error during printing:", error);
      toast.error(t("components.global.label_maker.toast.print_failed"));
    } finally {
      bluetoothPrinting.value = false;
    }
  };
</script>

<template>
  <div>
    <Dialog dialog-id="print-label">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {{ $t("components.global.label_maker.print") }}
          </DialogTitle>
          <DialogDescription>
            {{ $t("components.global.label_maker.confirm_description") }}
          </DialogDescription>
        </DialogHeader>
        <img :src="getLabelUrl(false)" />
        <DialogFooter>
          <ButtonGroup>
            <Button v-if="status?.labelPrinting || false" type="submit" :disabled="serverPrinting" @click="serverPrint">
              <MdiLoading v-if="serverPrinting" class="animate-spin" />
              {{ $t("components.global.label_maker.server_print") }}
            </Button>
            <Button type="submit" :disabled="bluetoothPrinting" @click="bluetoothPrint">
              <MdiLoading v-if="bluetoothPrinting" class="animate-spin" />
              {{ $t("components.global.label_maker.bluetooth_print") }}
            </Button>
            <Button type="submit" @click="browserPrint">
              {{ $t("components.global.label_maker.browser_print") }}
            </Button>
          </ButtonGroup>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <TooltipProvider :delay-duration="0">
      <ButtonGroup>
        <Button variant="outline" disabled class="disabled:opacity-100">
          {{ $t("components.global.label_maker.titles") }}
        </Button>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button size="icon" @click="downloadLabel">
              <MdiFileDownload name="mdi-file-download" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {{ $t("components.global.label_maker.download") }}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button size="icon" @click="openDialog('print-label')">
              <MdiPrinterPos name="mdi-printer-pos" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {{ $t("components.global.label_maker.browser_print") }}
          </TooltipContent>
        </Tooltip>

        <PageQRCode />
      </ButtonGroup>
    </TooltipProvider>
  </div>
</template>
