import { readSharedRealtimeRoomMembership } from "../../helix-ask/realtime-room/room-store";
import { EnvironmentSessionPreparationIntentStore, PreparationIntentError } from "./preparation-intent-store";

type Presence = ConstructorParameters<typeof EnvironmentSessionPreparationIntentStore>[0];
const stores = new WeakMap<Presence, EnvironmentSessionPreparationIntentStore>();

/** One service-scoped mailbox shared by browser and MCP; no credentials stored. */
export function preparationIntentsFor(presence: Presence) {
  let store = stores.get(presence);
  if (!store) {
    store = new EnvironmentSessionPreparationIntentStore(presence, async input => {
      const member = await readSharedRealtimeRoomMembership({ roomId: input.roomId, profileId: input.profileRef });
      if (!member || member.roomStatus === "closed") throw new PreparationIntentError("preparation_room_unavailable");
      // Local chat reference is browser-declared and profile-scoped, like the
      // existing task-binding request. No chat history is read or authorized.
    });
    stores.set(presence, store);
  }
  return store;
}
