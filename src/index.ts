export interface Env {
	WEBSOCKET_SERVERS: DurableObjectNamespace;
}

interface VideoState {
	id: string;
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
			if (request.method === 'POST') {
				return this.handleGetRoomInfo(request);
			}

			// Default response for non-handled requests
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

	async handleGetRoomInfo(request: Request): Promise<Response> {
		return new Response((await this.state.storage.get('roomInfo')) || '', { status: 200 });
		try {
			const requestData: any = await request.json(); // Assuming request has JSON body

			if (requestData.type === 'getRoomInfo') {
				// Simulate retrieving room information based on roomId
				const roomInfo: any = JSON.parse((await this.state.storage.get('roomInfo')) || '{}');
				return new Response(JSON.stringify({ url: roomInfo.url }), { status: 200 });
			} else {
				throw new Error('Invalid request');
			}
		} catch (e) {
			return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
		}
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		// ws.send((await this.state.storage.get('roomInfo')) || '');
		// ws.send(ws.url + JSON.stringify(this.latestState));
		let type, videoState, url;

		try {
			const parsedMessage = JSON.parse(message.toString());
			type = parsedMessage.type;
			videoState = parsedMessage.videoState;
			url = parsedMessage.url;
		} catch (e) {
			console.error(e);
			return;
		}

		const updateServerState = () => {
			this.latestState = videoState;
			this.state.storage.put('videoState', JSON.stringify(this.latestState));
			console.log('server state updated:', this.latestState);
		};

		// Initial sync
		switch (type) {
			case 'create':
				updateServerState();
				this.state.storage.put('roomInfo', JSON.stringify({ url: url }));
				break;
			case 'fetch':
				// Send the latest state to the client
				const message = { type: 'sync', videoState: this.latestState };
				ws.send(JSON.stringify(message));
				break;
			case 'sync':
				if (this.latestState && videoState.timestamp <= this.latestState.timestamp) {
					return;
				}
				// TODO: only admin can change the video source
				if (this.latestState && videoState.id !== this.latestState.id) {
					return;
				}
				// Update the room state according to the message
				updateServerState();

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

				if (warning !== '') {
					message = JSON.stringify({...data, warning});
				}
				*/
					// Then simply broadcast the event to all other connected clients in the room
					const message = { type: 'sync', videoState: this.latestState };
					client.send(JSON.stringify(message));
				});
				break;
			default:
				console.error('unknown message type:', type);
				return;
		}
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
		if (request.method === 'GET' && url.pathname.startsWith('/join')) {
			return await fetch('https://video-sync.pages.dev/', request);
		}

		return stub.fetch(request);
	},
};
