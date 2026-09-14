import { ref } from "vue";
import { CatPrinter } from "../components/global/cat-protocol";
import { CAT_ADV_SRV, CAT_PRINT_SRV, CAT_PRINT_TX_CHAR, CAT_PRINT_RX_CHAR } from "../components/global/constants";

export type LabelBitmap = { width: number; height: number; data: Uint8Array };

// Pack RGBA pixels into 1 bit per pixel, LSB-first, 1 = black.
export function rgbaToBits(rgba: Uint32Array, threshold: number): Uint8Array {
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

export function useCatPrinter() {
  const printer = ref<CatPrinter | null>(null);
  let device: BluetoothDevice | null = null;

  async function connectPrinter(): Promise<CatPrinter> {
    if (printer.value && device?.gatt?.connected) {
      return printer.value;
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

    await rx.startNotifications();
    rx.addEventListener("characteristicvaluechanged", event => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value) {
        instance.notify(new Uint8Array(value.buffer));
      }
    });

    device.addEventListener("gattserverdisconnected", () => {
      printer.value = null;
      device = null;
    });

    printer.value = instance;
    return instance;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function printBitmap(instance: CatPrinter, bitmap: LabelBitmap) {
    const bytesPerRow = Math.ceil(bitmap.width / 8);
    const ROWS_PER_CHUNK = 8;
    const CHUNK_DELAY_MS = 20;

    for (let row = 0; row < bitmap.height; row++) {
      const start = row * bytesPerRow;
      await instance.draw(bitmap.data.slice(start, start + bytesPerRow));

      if (row % ROWS_PER_CHUNK === ROWS_PER_CHUNK - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
  }

  return {
    connectPrinter,
    printBitmap,
    rgbaToBits,
  };
}
