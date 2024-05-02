export interface Env {
	WEBSOCKET_SERVERS: DurableObjectNamespace;
}

interface VideoState {
	src: string;
	paused: boolean;
	currentTime: number;
	timestamp: number;
}

export class WebSocketServer {
	state: DurableObjectState;
	latestState!: VideoState;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		// Retrieve the latest room state from durable storage when waking up
		this.state.blockConcurrencyWhile(async () => {
			let latestState = await this.state.storage.get('videoState');
			console.log('waking up, retrieved state:', latestState);
			if (latestState) {
				this.latestState = JSON.parse(latestState.toString());
			}
			this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
		});
	}

	async fetch(request: Request): Promise<Response> {
		// Check if the request is a WebSocket upgrade request
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('The server expects websocket', { status: 426 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);
		this.state.acceptWebSocket(server);
		console.log('client joined. Total clients:', this.state.getWebSockets().length);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		const { type, videoState } = JSON.parse(message.toString());
		// Initial sync
		if (type === 'join') {
			if (this.latestState === undefined) {
				// init the room for the first client
				this.latestState = videoState;
			} else {
				if (this.latestState.src !== videoState.src) {
					// TODO: handle video source not match
					return;
				}
				// Send the latest state to new clients
				const message = { type: 'sync', videoState: this.latestState };
				ws.send(JSON.stringify(message));
			}
		} else if (type === 'sync') {
			if (this.latestState && videoState.timestamp <= this.latestState.timestamp) {
				return;
			}
			// TODO: only admin can change the video source
			if (this.latestState && videoState.src !== this.latestState.src) {
				return;
			}
			// Update the room state according to the message
			this.latestState = videoState;

			//ws.serializeAttachment(this.latestState);

			console.log('broadcasting the received state to all clients:', this.latestState);
			this.state.getWebSockets().forEach((client) => {
				if (client === ws) {
					return;
				}
				/* TODO: Desync detection, ack?
				let warning = '';
				let clientState: VideoState  = client.deserializeAttachment();

				if (clientState.url !== this.latestState.url) {
					warning = 'URL mismatch';
				}
				else if (clientState.paused !== this.latestState.paused) {
					warning = 'Pause state mismatch';
				}
				// TODO: Time mismatch detection

				if (warning !== '') {
					message = JSON.stringify({...data, warning});
				}
				*/
				// Then simply broadcast the event to all other connected clients in the room
				const message = { type: 'sync', videoState: this.latestState };
				client.send(JSON.stringify(message));
			});
		}
		this.state.storage.put('videoState', JSON.stringify(this.latestState));
		console.log('server state updated:', this.latestState);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		let clientCount = this.state.getWebSockets().length;

		ws.close(1000, 'Durable Object is closing WebSocket');
		// The websocket may not close immediately after the call, thus getWebSockets().length may not decrease.
		// we need to decrement our count here.
		clientCount--;
		console.log('client left. Remaining clients:', clientCount);
		// If the last client leaves, clear all states for this room
		if (clientCount === 0) {
			this.state.storage.deleteAll();
			console.log('the last client left the room, state cleared.');
		}
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Each Durable Object is identified by a unique ROOM_ID in the URL path
		let id: DurableObjectId = env.WEBSOCKET_SERVERS.idFromName(new URL(request.url).pathname);
		let stub: DurableObjectStub = env.WEBSOCKET_SERVERS.get(id);

		const url = new URL(request.url);
		if (url.pathname.startsWith('/join')) {
			return Response.redirect('https://chromewebstore.google.com/search/nyaplay', 301);
		}

		return stub.fetch(request);
	},
};
