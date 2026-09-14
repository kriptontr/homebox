<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { route } from "../../lib/api/base";
  // import {
  //   CAT_ADV_SRV,
  //   CAT_PRINT_RX_CHAR,
  //   CAT_PRINT_SRV,
  //   CAT_PRINT_TX_CHAR,
  //   DEF_CANVAS_WIDTH,
  //   DEF_CANVAS_HEIGHT,
  //   DEF_ENERGY,
  //   DEF_FINISH_FEED,
  //   DEF_SPEED,
  //   // STUFF_PAINT_INIT_URL,
  //   // DEF_SPEED,
  //   // STUFF_PAINT_INIT_URL,
  // } from "./constants.ts";
  // import { CatPrinter } from "./cat-protocol";
  // import { CatPrinter } from 'cat-printer';
  // const printer = new CatPrinter({ debug: true });
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

  function rgbaToBits(data: Uint32Array) {
    const length = (data.length / 8) | 0;
    const result = new Uint8Array(length);
    for (let i = 0, p = 0; i < data.length; ++p) {
      result[p] = 0;
      for (let d = 0; d < 8; ++i, ++d) result[p] |= data[i] & 0xff & (0b1 << d);
      result[p] ^= 0b11111111;
    }
    return result;
  }

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
  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  const bluetoothPrint = async () => {
    // debugger;
     try {
                /*
                if (!printer.isConnected()) {
                        await printer.connect();
                        console.log('Connected to printer!');
                } else {
                        console.log('Printer already connected.');
                }

                
                // Print text with custom options
                // await printer.printText('', { 
                //         fontSize: 24, 
                //         fontWeight: 'bold',
                //         align: 'center',
                //         lineSpacing: 8
                // });
                
                await printer.retract(30);
                const url = getLabelUrl(false);
                // Print an image using Floyd-Steinberg dithering
                await printer.printImage(url, {
                        dither: `threshold`,
                        brightness: 135,
                        offset: 10,
                        // flipV: true,
                        // rotate: 90,
                });
                
                // Feed the paper to finalize the printing job
                await printer.feed(80);
                */
                
                // Disconnect when the job is done
                // await printer.disconnect();
                console.log("Bluetooth printing disabled due to missing dependency");
        } catch (error) {
                console.error('Error during printing:', error);
        }
  };

  function concatArrays(bitmap: Uint8Array, emptyline: Uint8Array): Uint8Array {
    const result = new Uint8Array(bitmap.length + emptyline.length);
    result.set(bitmap, 0);
    result.set(emptyline, bitmap.length);
    return result;
  } </script>

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
            <Button type="submit" @click="bluetoothPrint">
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
