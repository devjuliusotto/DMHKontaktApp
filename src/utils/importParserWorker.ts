import type { CalendarEvent } from "../types/calendar";
import type { ImportPreview } from "./importers";

type ParserKind = "calendar" | "contacts-csv" | "contacts-xlsx";

type ParserResponse<T> =
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string };

let nextRequestId = 1;

function runParserWorker<T>(kind: ParserKind, bytes: Uint8Array, source = ""): Promise<T> {
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("Die Hintergrundverarbeitung ist auf diesem Gerät nicht verfügbar."));
  }

  const requestId = nextRequestId++;
  const worker = new Worker(new URL("../workers/importParser.worker.ts", import.meta.url), { type: "module" });
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<ParserResponse<T>>) => {
      if (data.id !== requestId) return;
      worker.terminate();
      if (data.ok) resolve(data.result);
      else reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Die Datei konnte im Hintergrund nicht verarbeitet werden."));
    };
    worker.postMessage({ id: requestId, kind, bytes, source }, [bytes.buffer]);
  });
}

export function parseCalendarFileInWorker(bytes: Uint8Array, source: string) {
  return runParserWorker<CalendarEvent[]>("calendar", bytes, source);
}

export function parseContactFileInWorker(bytes: Uint8Array, xlsx: boolean) {
  return runParserWorker<ImportPreview>(xlsx ? "contacts-xlsx" : "contacts-csv", bytes);
}
