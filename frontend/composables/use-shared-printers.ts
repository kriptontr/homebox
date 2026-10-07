import { ref } from "vue";
import type { PrintJob, SharedPrinter } from "~~/lib/api/classes/printers";

export type RemotePrintResult = { ok: true } | { ok: false; message?: string };

/**
 * Lists the printers shared in the current group and sends print jobs to them.
 * The server relays the job to the browser hosting the printer and waits for
 * the result, so `print` can take up to about a minute to resolve.
 */
export function useSharedPrinters() {
  const api = useUserApi();

  const printers = ref<SharedPrinter[]>([]);
  const selectedId = ref("");
  const sending = ref(false);

  async function refresh() {
    try {
      const { data, error } = await api.printers.list();
      printers.value = !error && Array.isArray(data) ? data : [];
    } catch (err) {
      console.error("Failed to load shared printers:", err);
      printers.value = [];
    }

    if (!printers.value.some(p => p.id === selectedId.value)) {
      selectedId.value = printers.value[0]?.id ?? "";
    }
  }

  async function print(job: PrintJob): Promise<RemotePrintResult> {
    const id = selectedId.value;
    if (!id) {
      return { ok: false };
    }

    sending.value = true;
    try {
      const { data, error } = await api.printers.print(id, job);
      // Contract: success is 200 {"ok":true}; be defensive about a 2xx carrying ok:false.
      if (!error && data?.ok !== false) {
        return { ok: true };
      }

      const message = data && typeof data === "object" && typeof data.error === "string" ? data.error : undefined;
      // The printer may have gone away; drop stale entries from the list.
      await refresh();
      return { ok: false, message };
    } catch (err) {
      console.error("Failed to send remote print job:", err);
      return { ok: false };
    } finally {
      sending.value = false;
    }
  }

  return { printers, selectedId, sending, refresh, print };
}
