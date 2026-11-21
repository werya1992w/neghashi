import { GameRoom } from "./room.js";
import { Matchmaker } from "./matchmaker.js";

export { GameRoom, Matchmaker };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // بازی سریع: یک اتاق عمومی که جا دارد (یا اتاق جدید) برمی‌گرداند
    if (url.pathname === "/api/quickplay") {
      const code = await env.MATCHMAKER.getByName("main").findOrCreate();
      return Response.json({ code }, { headers: { "cache-control": "no-store" } });
    }

    // اتصال WebSocket به اتاق: /ws/ABCDE
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,12})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return env.ROOMS.getByName(m[1].toUpperCase()).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
