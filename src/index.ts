export interface Env {
	WEBSOCKET_SERVERS: DurableObjectNamespace;
}

interface VideoState {
	url: string;
	paused: boolean;
	videoTime: number;
	timeStamp: number;
}

export class WebSocketServer {
	state: DurableObjectState;
	latestState!: VideoState;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		// Retrieve the latest room state from durable storage when waking up
		this.state.blockConcurrencyWhile(async () => {
			let latestState = await this.state.storage.get('videoState');
			console.log('Retrieved state:', latestState);
			if (latestState) {
				this.latestState = JSON.parse(latestState.toString());
			}
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
		console.log('Client joined. Total clients:', this.state.getWebSockets().length);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		const data = JSON.parse(message.toString());
		// Initial sync
		if (data.action === 'init') {
			// message: {"action":"init","videoTime":1337,"timeStamp":1711114514,"url":"https://www.youtube.com/watch?v=foobar","isPaused":true}
			if (this.latestState === undefined) {
				// init the room for the first client
				this.latestState = {url: data.url, paused: data.isPaused, videoTime: data.videoTime, timeStamp: data.timeStamp};
			}

			// Send the latest state to new clients, or echo back for the first client
			ws.send(JSON.stringify(this.latestState));
		} else {
			// Update the room state according to the message
			this.latestState.url = data.url;
			this.latestState.timeStamp = data.timeStamp;
			if (data.action === 'seek') {
				// message: {"action":"seek","seekTo":1337,"timeStamp":1711114514,"url":"https://www.youtube.com/watch?v=foobar"}
				this.latestState.videoTime = data.seekTo;
			} else if (data.action === 'pause') {
				// message: {"action":"pause","videoTime":1337,"timeStamp":1711114514,"url":"https://www.youtube.com/watch?v=foobar"}
				this.latestState.paused = true;
				this.latestState.videoTime = data.videoTime;
			} else if (data.action === 'play') {
				// message: {"action":"play","videoTime":1337,"timeStamp":1711114514,"url":"https://www.youtube.com/watch?v=foobar"}
				this.latestState.paused = false;
				this.latestState.videoTime = data.videoTime;
			} 

			// Then simply broadcast the event to all other connected clients in the room
			this.state.getWebSockets().forEach((client) => {
				(client !== ws) ? client.send(message) : null
			});
		}
		this.state.storage.put('videoState', JSON.stringify(this.latestState));
		console.log('State updated:', this.latestState);
	  }
	
	  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		let clientCount = this.state.getWebSockets().length;
		ws.close(1000, "Durable Object is closing WebSocket");
		// The websocket may not close immediately after the call, thus getWebSockets().length may not decrease.
		// we need to decrement our count here.
		clientCount--;
		console.log('Client left. Remaining clients:', clientCount);
		// If the last client leaves, clear all states for this room
		if(clientCount === 0) {
			this.state.storage.delete('videoState');
			console.log('State cleared.');
		}
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
