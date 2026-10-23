/** Hold a real receipt-store commit at a FIFO output until the parent terminates it. */
import { serveContextReceipt } from "../../context-receipts.ts";
await serveContextReceipt(process.env.RECEIPT_PM_ROOT!, "## Focus\n- item-1\n", "text",
  { item_ids: ["item-1"], files: [] }, { author: "crash-writer", command: "context-pack" }, process.env.RECEIPT_FIFO!);
