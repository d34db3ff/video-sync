export interface Env {
	WEBSOCKET_SERVERS: DurableObjectNamespace;
}

export class WebSocketServer {
	state: DurableObjectState;
	/**
	 * The constructor is invoked every time the Durable Object is recovered from hibernation
	 *
	 * @param state - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.toml
	 */
	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
	}

	/**
	 * The Durable Object fetch handler will be invoked when a Durable Object instance receives a
	 * 	request from a Worker via an associated stub
	 *
	 * @param request - The request submitted to a Durable Object instance from a Worker
	 * @returns The response to be sent back to the Worker
	 */
	async fetch(request: Request): Promise<Response> {
		// Check if the request is a WebSocket upgrade request
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Durable Object expected Upgrade: websocket', { status: 426 });
		}

		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);
		this.state.acceptWebSocket(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		// Simply broadcast the message to all connected clients in the room
		this.state.getWebSockets().forEach((client) => {
		  if (client !== ws)
			client.send(`${message}`);
		});
	  }
	
	  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// If the client closes the connection, the runtime will invoke the webSocketClose() handler.
		ws.close(code, "Durable Object is closing WebSocket");
	  }
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Each Durable Object is identified by a unique ROOM_ID in the URL path
		let id: DurableObjectId = env.WEBSOCKET_SERVERS.idFromName(new URL(request.url).pathname);
		let stub: DurableObjectStub = env.WEBSOCKET_SERVERS.get(id);
		return stub.fetch(request);
	},
};
