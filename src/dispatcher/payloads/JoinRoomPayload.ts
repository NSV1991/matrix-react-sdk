/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { JoinedRoom as JoinedRoomEvent } from "@matrix-org/analytics-events/types/typescript/JoinedRoom";
import { IJoinRoomOpts } from "matrix-js-sdk/src/@types/requests";

import { ActionPayload } from "../payloads";
import { Action } from "../actions";

/* eslint-disable camelcase */
export interface JoinRoomPayload extends Pick<ActionPayload, "action"> {
    action: Action.JoinRoom;

    roomId: string;
    opts?: IJoinRoomOpts;

    // additional parameters for the purpose of metrics & instrumentation
    metricsTrigger: JoinedRoomEvent["trigger"];

    canAskToJoin?: boolean;
}
/* eslint-enable camelcase */
