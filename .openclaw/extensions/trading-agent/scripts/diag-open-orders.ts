/**
 * Diagnostic script: read-only open orders + positions + executions.
 * Read-only Tagesdiagnose bis E4/E5 verifiziert.
 * Uses clientId 99 to avoid interfering with the trading agent (clientId 1).
 * Output: structured JSON per section to stdout.
 *
 * DO NOT COMMIT — disposable diagnostic tool.
 */

import { IBApi, EventName, type Contract, type Order, type OrderState } from "@stoqey/ib";

const HOST = process.env.IBKR_HOST || "127.0.0.1";
const PORT = Number(process.env.IBKR_PORT) || 7497;
const CLIENT_ID = 99; // dedicated diagnostic clientId

interface OrderInfo {
  orderId: number;
  permId?: number;
  clientId?: number;
  symbol: string;
  conId: number;
  action: string;
  orderType: string;
  totalQty: number;
  lmtPrice?: number;
  auxPrice?: number;
  tif: string;
  ocaGroup: string;
  ocaType: number;
  status: string;
  parentId: number;
  orderRef: string;
}

interface PositionInfo {
  account: string;
  symbol: string;
  conId: number;
  qty: number;
  avgCost: number;
}

interface ExecInfo {
  orderId: number;
  symbol: string;
  conId: number;
  side: string;
  shares: number;
  price: number;
  cumQty: number;
  avgPrice: number;
  execId: string;
  time: string;
  orderRef: string;
}

function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    const api = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
    const orders: OrderInfo[] = [];
    const positions: PositionInfo[] = [];
    const executions: ExecInfo[] = [];
    const orderStatuses = new Map<number, string>();

    let phase = 0; // 0=connecting, 1=orders, 2=positions, 3=executions
    let done = false;

    const outputAndExit = () => {
      if (done) return;
      done = true;
      // Merge statuses into orders
      for (const o of orders) {
        const st = orderStatuses.get(o.orderId);
        if (st) o.status = st;
      }
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        orders,
        positions,
        executions,
      }, null, 2));
      try { api.disconnect(); } catch {}
      resolve();
    };

    const timeout = setTimeout(() => {
      console.error("[diag] Timeout after 30s");
      outputAndExit();
    }, 30_000);

    api.on(EventName.error, (err: Error, code: number, reqId: number) => {
      // Ignore non-critical info messages
      if (code === -1 || code === 2104 || code === 2106 || code === 2158 || code === 2174) return;
      console.error(`[diag] Error code=${code} reqId=${reqId}: ${err.message}`);
      // If execution request fails, output what we have
      if (reqId === 9001 && code === 321) {
        console.error("[diag] Execution request failed, outputting without executions");
        clearTimeout(timeout);
        outputAndExit();
      }
    });

    api.on(EventName.connected, () => {
      console.error("[diag] Connected");
      // Phase 1: request all open orders
      phase = 1;

      api.on(EventName.orderStatus, (
        orderId: number, status: string,
      ) => {
        orderStatuses.set(orderId, String(status));
      });

      api.on(EventName.openOrder, (
        orderId: number, contract: Contract, order: Order, orderState: OrderState,
      ) => {
        orders.push({
          orderId,
          permId: order.permId,
          clientId: order.clientId,
          symbol: contract.symbol ?? "",
          conId: contract.conId ?? 0,
          action: order.action ?? "",
          orderType: order.orderType ?? "",
          totalQty: order.totalQuantity ?? 0,
          lmtPrice: order.lmtPrice,
          auxPrice: order.auxPrice,
          tif: order.tif ?? "",
          ocaGroup: order.ocaGroup ?? "",
          ocaType: order.ocaType ?? 0,
          status: String(orderState.status ?? ""),
          parentId: order.parentId ?? 0,
          orderRef: order.orderRef ?? "",
        });
      });

      api.on(EventName.openOrderEnd, () => {
        console.error(`[diag] openOrderEnd: ${orders.length} orders`);

        // Phase 2: positions
        phase = 2;

        api.on(EventName.position, (
          account: string, contract: Contract, pos: number, avgCost?: number,
        ) => {
          positions.push({
            account,
            symbol: contract.symbol ?? "",
            conId: contract.conId ?? 0,
            qty: pos,
            avgCost: avgCost ?? 0,
          });
        });

        api.on(EventName.positionEnd, () => {
          console.error(`[diag] positionEnd: ${positions.length} positions`);

          // Phase 3: executions (today's SELL fills)
          phase = 3;
          const today = new Date();
          const timeStr = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, "0")}${String(today.getUTCDate()).padStart(2, "0")}-00:00:00`;

          api.on(EventName.execDetails, (
            _reqId: number, contract: Contract, execution: any,
          ) => {
            executions.push({
              orderId: execution.orderId ?? 0,
              symbol: contract.symbol ?? "",
              conId: contract.conId ?? 0,
              side: execution.side ?? "",
              shares: execution.shares ?? 0,
              price: execution.price ?? 0,
              cumQty: execution.cumQty ?? 0,
              avgPrice: execution.avgPrice ?? 0,
              execId: execution.execId ?? "",
              time: execution.time ?? "",
              orderRef: execution.orderRef ?? "",
            });
          });

          api.on(EventName.execDetailsEnd, () => {
            console.error(`[diag] execDetailsEnd: ${executions.length} executions`);
            clearTimeout(timeout);
            outputAndExit();
          });

          api.reqExecutions(9001, { time: timeStr });
        });

        api.reqPositions();
      });

      api.reqAllOpenOrders();
    });

    api.connect();
  });
}

run().catch((e) => {
  console.error("[diag] Fatal:", e);
  process.exit(1);
});
