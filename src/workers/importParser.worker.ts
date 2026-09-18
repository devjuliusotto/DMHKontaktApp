import type { CalendarEvent } from "../types/calendar";
import { parseCalendarFile } from "../utils/calendar";
import { parseCsvBytes, parseXlsx, type ImportPreview } from "../utils/importers";

type ParserRequest =
  | { id: number; kind: "calendar"; bytes: Uint8Array; source: string }
  | { id: number; kind: "contacts-csv"; bytes: Uint8Array }
  | { id: number; kind: "contacts-xlsx"; bytes: Uint8Array };

type ParserResponse =
  | { id: number; ok: true; result: CalendarEvent[] | ImportPreview }
  | { id: number; ok: false; error: string };

interface ParserWorkerScope {
  onmessage: ((event: MessageEvent<ParserRequest>) => void) | null;
  postMessage(message: ParserResponse): void;
}

const workerScope = self as unknown as ParserWorkerScope;

workerScope.onmessage = async ({ data }) => {
  try {
    const result = data.kind === "calendar"
      ? parseCalendarFile(data.bytes, data.source)
      : data.kind === "contacts-xlsx"
        ? await parseXlsx(data.bytes)
        : parseCsvBytes(data.bytes);
    workerScope.postMessage({ id: data.id, ok: true, result });
  } catch (error) {
    workerScope.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
