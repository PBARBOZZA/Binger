type PrivateEventEmitter = (userIds: string[], event: string, payload: unknown) => void;

let emitter: PrivateEventEmitter | undefined;

export function setPrivateEventEmitter(nextEmitter: PrivateEventEmitter | undefined) {
  emitter = nextEmitter;
}

export function emitPrivateEvent(userIds: string[], event: string, payload: unknown) {
  emitter?.(userIds, event, payload);
}
