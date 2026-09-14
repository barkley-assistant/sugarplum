export function healthRoutes() {
  return {
    "/api/health": {
      GET: () => new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
  };
}