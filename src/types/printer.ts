export interface PrinterInfo {
  name: string;
  driverName: string;
  portName: string;
  printerStatus: string;
  shared: boolean;
  shareName: string;
  isDefault: boolean;
}

export interface PrinterDriver {
  name: string;
  manufacturer: string;
}

export interface AddNetworkPrinterRequest {
  mode: "shared" | "ip";
  connectionName: string;
  ipAddress: string;
  printerName: string;
  driverName: string;
}
