/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import React, { ComponentProps } from "react";
import { fireEvent, render, RenderResult, screen, within } from "@testing-library/react";
import fetchMock from "fetch-mock-jest";
import { mocked } from "jest-mock";
import { ClientEvent, MatrixClient, MatrixEvent, Room, SyncState } from "matrix-js-sdk/src/matrix";
import { MediaHandler } from "matrix-js-sdk/src/webrtc/mediaHandler";
import * as MatrixJs from "matrix-js-sdk/src/matrix";
import { completeAuthorizationCodeGrant } from "matrix-js-sdk/src/oidc/authorize";
import { logger } from "matrix-js-sdk/src/logger";
import { OidcError } from "matrix-js-sdk/src/oidc/error";
import { BearerTokenResponse } from "matrix-js-sdk/src/oidc/validate";

import MatrixChat from "../../../src/components/structures/MatrixChat";
import * as StorageManager from "../../../src/utils/StorageManager";
import defaultDispatcher from "../../../src/dispatcher/dispatcher";
import { Action } from "../../../src/dispatcher/actions";
import { UserTab } from "../../../src/components/views/dialogs/UserTab";
import {
    clearAllModals,
    filterConsole,
    flushPromises,
    getMockClientWithEventEmitter,
    mockClientMethodsUser,
    mockPlatformPeg,
} from "../../test-utils";
import * as leaveRoomUtils from "../../../src/utils/leave-behaviour";
import * as voiceBroadcastUtils from "../../../src/voice-broadcast/utils/cleanUpBroadcasts";
import LegacyCallHandler from "../../../src/LegacyCallHandler";
import { CallStore } from "../../../src/stores/CallStore";
import { Call } from "../../../src/models/Call";
import { PosthogAnalytics } from "../../../src/PosthogAnalytics";
import PlatformPeg from "../../../src/PlatformPeg";
import EventIndexPeg from "../../../src/indexing/EventIndexPeg";

jest.mock("matrix-js-sdk/src/oidc/authorize", () => ({
    completeAuthorizationCodeGrant: jest.fn(),
}));

describe("<MatrixChat />", () => {
    const userId = "@alice:server.org";
    const deviceId = "qwertyui";
    const accessToken = "abc123";
    // reused in createClient mock below
    const getMockClientMethods = () => ({
        ...mockClientMethodsUser(userId),
        startClient: jest.fn(),
        stopClient: jest.fn(),
        setCanResetTimelineCallback: jest.fn(),
        isInitialSyncComplete: jest.fn(),
        getSyncState: jest.fn(),
        getSyncStateData: jest.fn().mockReturnValue(null),
        getThirdpartyProtocols: jest.fn().mockResolvedValue({}),
        getClientWellKnown: jest.fn().mockReturnValue({}),
        isVersionSupported: jest.fn().mockResolvedValue(false),
        isCryptoEnabled: jest.fn().mockReturnValue(false),
        getRoom: jest.fn(),
        getMediaHandler: jest.fn().mockReturnValue({
            setVideoInput: jest.fn(),
            setAudioInput: jest.fn(),
            setAudioSettings: jest.fn(),
            stopAllStreams: jest.fn(),
        } as unknown as MediaHandler),
        setAccountData: jest.fn(),
        store: {
            destroy: jest.fn(),
            startup: jest.fn(),
        },
        login: jest.fn(),
        loginFlows: jest.fn(),
        isGuest: jest.fn().mockReturnValue(false),
        clearStores: jest.fn(),
        setGuest: jest.fn(),
        setNotifTimelineSet: jest.fn(),
        getAccountData: jest.fn(),
        doesServerSupportUnstableFeature: jest.fn(),
        getDevices: jest.fn().mockResolvedValue({ devices: [] }),
        getProfileInfo: jest.fn(),
        getVisibleRooms: jest.fn().mockReturnValue([]),
        getRooms: jest.fn().mockReturnValue([]),
        userHasCrossSigningKeys: jest.fn(),
        setGlobalBlacklistUnverifiedDevices: jest.fn(),
        setGlobalErrorOnUnknownDevices: jest.fn(),
        getCrypto: jest.fn(),
        secretStorage: {
            isStored: jest.fn().mockReturnValue(null),
        },
        getDehydratedDevice: jest.fn(),
        whoami: jest.fn(),
        isRoomEncrypted: jest.fn(),
        logout: jest.fn(),
        getDeviceId: jest.fn(),
    });
    let mockClient = getMockClientWithEventEmitter(getMockClientMethods());
    const serverConfig = {
        hsUrl: "https://test.com",
        hsName: "Test Server",
        hsNameIsDifferent: false,
        isUrl: "https://is.com",
        isDefault: true,
        isNameResolvable: true,
        warning: "",
    };
    const defaultProps: ComponentProps<typeof MatrixChat> = {
        config: {
            brand: "Test",
            help_url: "help_url",
            help_encryption_url: "help_encryption_url",
            element_call: {},
            feedback: {
                existing_issues_url: "https://feedback.org/existing",
                new_issue_url: "https://feedback.org/new",
            },
            validated_server_config: serverConfig,
        },
        onNewScreen: jest.fn(),
        onTokenLoginCompleted: jest.fn(),
        makeRegistrationUrl: jest.fn(),
        realQueryParams: {},
    };
    const getComponent = (props: Partial<ComponentProps<typeof MatrixChat>> = {}) =>
        render(<MatrixChat {...defaultProps} {...props} />);
    let localStorageSetSpy = jest.spyOn(localStorage.__proto__, "setItem");
    let localStorageGetSpy = jest.spyOn(localStorage.__proto__, "getItem").mockReturnValue(undefined);
    let localStorageClearSpy = jest.spyOn(localStorage.__proto__, "clear");
    let sessionStorageSetSpy = jest.spyOn(sessionStorage.__proto__, "setItem");

    // make test results readable
    filterConsole("Failed to parse localStorage object");

    /**
     * Wait for a bunch of stuff to happen
     * between deciding we are logged in and removing the spinner
     * including waiting for initial sync
     */
    const waitForSyncAndLoad = async (client: MatrixClient, withoutSecuritySetup?: boolean): Promise<void> => {
        // need to wait for different elements depending on which flow
        // without security setup we go to a loading page
        if (withoutSecuritySetup) {
            // we think we are logged in, but are still waiting for the /sync to complete
            await screen.findByText("Logout");
            // initial sync
            client.emit(ClientEvent.Sync, SyncState.Prepared, null);
            // wait for logged in view to load
            await screen.findByLabelText("User menu");

            // otherwise we stay on login and load from there for longer
        } else {
            // we are logged in, but are still waiting for the /sync to complete
            await screen.findByText("Syncing…");
            // initial sync
            client.emit(ClientEvent.Sync, SyncState.Prepared, null);
        }

        // let things settle
        await flushPromises();
        // and some more for good measure
        // this proved to be a little flaky
        await flushPromises();
    };

    beforeEach(async () => {
        mockClient = getMockClientWithEventEmitter(getMockClientMethods());
        fetchMock.get("https://test.com/_matrix/client/versions", {
            unstable_features: {},
            versions: [],
        });
        localStorageSetSpy = jest.spyOn(localStorage.__proto__, "setItem");
        localStorageGetSpy = jest.spyOn(localStorage.__proto__, "getItem").mockReturnValue(undefined);
        localStorageClearSpy = jest.spyOn(localStorage.__proto__, "clear");
        sessionStorageSetSpy = jest.spyOn(sessionStorage.__proto__, "setItem");

        jest.spyOn(StorageManager, "idbLoad").mockReset();
        jest.spyOn(StorageManager, "idbSave").mockResolvedValue(undefined);
        jest.spyOn(defaultDispatcher, "dispatch").mockClear();

        await clearAllModals();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should render spinner while app is loading", () => {
        const { container } = getComponent();

        expect(container).toMatchSnapshot();
    });

    describe("with an existing session", () => {
        const mockidb: Record<string, Record<string, string>> = {
            acccount: {
                mx_access_token: accessToken,
            },
        };
        const mockLocalStorage: Record<string, string> = {
            mx_hs_url: serverConfig.hsUrl,
            mx_is_url: serverConfig.isUrl,
            mx_access_token: accessToken,
            mx_user_id: userId,
            mx_device_id: deviceId,
        };

        beforeEach(() => {
            localStorageGetSpy.mockImplementation((key: unknown) => mockLocalStorage[key as string] || "");

            jest.spyOn(StorageManager, "idbLoad").mockImplementation(async (table, key) => {
                const safeKey = Array.isArray(key) ? key[0] : key;
                return mockidb[table]?.[safeKey];
            });
        });

        const getComponentAndWaitForReady = async (): Promise<RenderResult> => {
            const renderResult = getComponent();

            // we think we are logged in, but are still waiting for the /sync to complete
            await screen.findByText("Logout");
            // initial sync
            mockClient.emit(ClientEvent.Sync, SyncState.Prepared, null);
            // wait for logged in view to load
            await screen.findByLabelText("User menu");
            // let things settle
            await flushPromises();
            // and some more for good measure
            // this proved to be a little flaky
            await flushPromises();

            return renderResult;
        };

        it("should render welcome page after login", async () => {
            getComponent();

            // we think we are logged in, but are still waiting for the /sync to complete
            const logoutButton = await screen.findByText("Logout");

            expect(logoutButton).toBeInTheDocument();
            expect(screen.getByRole("progressbar")).toBeInTheDocument();

            // initial sync
            mockClient.emit(ClientEvent.Sync, SyncState.Prepared, null);

            // wait for logged in view to load
            await screen.findByLabelText("User menu");
            // let things settle
            await flushPromises();
            expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
            expect(screen.getByText(`Welcome ${userId}`)).toBeInTheDocument();
        });

        describe("onAction()", () => {
            beforeEach(() => {
                jest.spyOn(defaultDispatcher, "dispatch").mockClear();
                jest.spyOn(defaultDispatcher, "fire").mockClear();
            });
            it("should open user device settings", async () => {
                await getComponentAndWaitForReady();

                defaultDispatcher.dispatch({
                    action: Action.ViewUserDeviceSettings,
                });

                await flushPromises();

                expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
                    action: Action.ViewUserSettings,
                    initialTabId: UserTab.SessionManager,
                });
            });

            describe("room actions", () => {
                const roomId = "!room:server.org";
                const spaceId = "!spaceRoom:server.org";
                const room = new Room(roomId, mockClient, userId);
                const spaceRoom = new Room(spaceId, mockClient, userId);

                beforeEach(() => {
                    mockClient.getRoom.mockImplementation(
                        (id) => [room, spaceRoom].find((room) => room.roomId === id) || null,
                    );
                    jest.spyOn(spaceRoom, "isSpaceRoom").mockReturnValue(true);
                });

                describe("leave_room", () => {
                    beforeEach(async () => {
                        await clearAllModals();
                        await getComponentAndWaitForReady();
                        // this is thoroughly unit tested elsewhere
                        jest.spyOn(leaveRoomUtils, "leaveRoomBehaviour").mockClear().mockResolvedValue(undefined);
                    });
                    const dispatchAction = () =>
                        defaultDispatcher.dispatch({
                            action: "leave_room",
                            room_id: roomId,
                        });
                    const publicJoinRule = new MatrixEvent({
                        type: "m.room.join_rules",
                        content: {
                            join_rule: "public",
                        },
                    });
                    const inviteJoinRule = new MatrixEvent({
                        type: "m.room.join_rules",
                        content: {
                            join_rule: "invite",
                        },
                    });
                    describe("for a room", () => {
                        beforeEach(() => {
                            jest.spyOn(room.currentState, "getJoinedMemberCount").mockReturnValue(2);
                            jest.spyOn(room.currentState, "getStateEvents").mockReturnValue(publicJoinRule);
                        });
                        it("should launch a confirmation modal", async () => {
                            dispatchAction();
                            const dialog = await screen.findByRole("dialog");
                            expect(dialog).toMatchSnapshot();
                        });
                        it("should warn when room has only one joined member", async () => {
                            jest.spyOn(room.currentState, "getJoinedMemberCount").mockReturnValue(1);
                            dispatchAction();
                            await screen.findByRole("dialog");
                            expect(
                                screen.getByText(
                                    "You are the only person here. If you leave, no one will be able to join in the future, including you.",
                                ),
                            ).toBeInTheDocument();
                        });
                        it("should warn when room is not public", async () => {
                            jest.spyOn(room.currentState, "getStateEvents").mockReturnValue(inviteJoinRule);
                            dispatchAction();
                            await screen.findByRole("dialog");
                            expect(
                                screen.getByText(
                                    "This room is not public. You will not be able to rejoin without an invite.",
                                ),
                            ).toBeInTheDocument();
                        });
                        it("should do nothing on cancel", async () => {
                            dispatchAction();
                            const dialog = await screen.findByRole("dialog");
                            fireEvent.click(within(dialog).getByText("Cancel"));

                            await flushPromises();

                            expect(leaveRoomUtils.leaveRoomBehaviour).not.toHaveBeenCalled();
                            expect(defaultDispatcher.dispatch).not.toHaveBeenCalledWith({
                                action: Action.AfterLeaveRoom,
                                room_id: roomId,
                            });
                        });
                        it("should leave room and dispatch after leave action", async () => {
                            dispatchAction();
                            const dialog = await screen.findByRole("dialog");
                            fireEvent.click(within(dialog).getByText("Leave"));

                            await flushPromises();

                            expect(leaveRoomUtils.leaveRoomBehaviour).toHaveBeenCalled();
                            expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
                                action: Action.AfterLeaveRoom,
                                room_id: roomId,
                            });
                        });
                    });

                    describe("for a space", () => {
                        const dispatchAction = () =>
                            defaultDispatcher.dispatch({
                                action: "leave_room",
                                room_id: spaceId,
                            });
                        beforeEach(() => {
                            jest.spyOn(spaceRoom.currentState, "getStateEvents").mockReturnValue(publicJoinRule);
                        });
                        it("should launch a confirmation modal", async () => {
                            dispatchAction();
                            const dialog = await screen.findByRole("dialog");
                            expect(dialog).toMatchSnapshot();
                        });
                        it("should warn when space is not public", async () => {
                            jest.spyOn(spaceRoom.currentState, "getStateEvents").mockReturnValue(inviteJoinRule);
                            dispatchAction();
                            await screen.findByRole("dialog");
                            expect(
                                screen.getByText(
                                    "This space is not public. You will not be able to rejoin without an invite.",
                                ),
                            ).toBeInTheDocument();
                        });
                    });
                });
            });

            describe("logout", () => {
                let logoutClient!: ReturnType<typeof getMockClientWithEventEmitter>;
                const call1 = { disconnect: jest.fn() } as unknown as Call;
                const call2 = { disconnect: jest.fn() } as unknown as Call;

                const dispatchLogoutAndWait = async (): Promise<void> => {
                    defaultDispatcher.dispatch({
                        action: "logout",
                    });

                    await flushPromises();
                };

                beforeEach(() => {
                    // stub out various cleanup functions
                    jest.spyOn(LegacyCallHandler.instance, "hangupAllCalls")
                        .mockClear()
                        .mockImplementation(() => {});
                    jest.spyOn(voiceBroadcastUtils, "cleanUpBroadcasts").mockImplementation(async () => {});
                    jest.spyOn(PosthogAnalytics.instance, "logout").mockImplementation(() => {});
                    jest.spyOn(EventIndexPeg, "deleteEventIndex").mockImplementation(async () => {});

                    jest.spyOn(CallStore.instance, "activeCalls", "get").mockReturnValue(new Set([call1, call2]));

                    mockPlatformPeg({
                        destroyPickleKey: jest.fn(),
                    });

                    logoutClient = getMockClientWithEventEmitter(getMockClientMethods());
                    mockClient = getMockClientWithEventEmitter(getMockClientMethods());
                    mockClient.logout.mockResolvedValue({});
                    mockClient.getDeviceId.mockReturnValue(deviceId);
                    // this is used to create a temporary client to cleanup after logout
                    jest.spyOn(MatrixJs, "createClient").mockClear().mockReturnValue(logoutClient);

                    jest.spyOn(logger, "warn").mockClear();
                });

                afterAll(() => {
                    jest.spyOn(voiceBroadcastUtils, "cleanUpBroadcasts").mockRestore();
                });

                it("should hangup all legacy calls", async () => {
                    await getComponentAndWaitForReady();
                    await dispatchLogoutAndWait();
                    expect(LegacyCallHandler.instance.hangupAllCalls).toHaveBeenCalled();
                });

                it("should cleanup broadcasts", async () => {
                    await getComponentAndWaitForReady();
                    await dispatchLogoutAndWait();
                    expect(voiceBroadcastUtils.cleanUpBroadcasts).toHaveBeenCalled();
                });

                it("should disconnect all calls", async () => {
                    await getComponentAndWaitForReady();
                    await dispatchLogoutAndWait();
                    expect(call1.disconnect).toHaveBeenCalled();
                    expect(call2.disconnect).toHaveBeenCalled();
                });

                it("should logout of posthog", async () => {
                    await getComponentAndWaitForReady();
                    await dispatchLogoutAndWait();

                    expect(PosthogAnalytics.instance.logout).toHaveBeenCalled();
                });

                it("should destroy pickle key", async () => {
                    await getComponentAndWaitForReady();
                    await dispatchLogoutAndWait();

                    expect(PlatformPeg.get()!.destroyPickleKey).toHaveBeenCalledWith(userId, deviceId);
                });

                describe("without delegated auth", () => {
                    it("should call /logout", async () => {
                        await getComponentAndWaitForReady();
                        await dispatchLogoutAndWait();

                        expect(mockClient.logout).toHaveBeenCalledWith(true);
                    });

                    it("should warn and do post-logout cleanup anyway when logout fails", async () => {
                        const error = new Error("test logout failed");
                        mockClient.logout.mockRejectedValue(error);
                        await getComponentAndWaitForReady();
                        await dispatchLogoutAndWait();

                        expect(logger.warn).toHaveBeenCalledWith(
                            "Failed to call logout API: token will not be invalidated",
                            error,
                        );

                        // stuff that happens in onloggedout
                        expect(defaultDispatcher.fire).toHaveBeenCalledWith(Action.OnLoggedOut, true);
                        expect(logoutClient.clearStores).toHaveBeenCalled();
                    });

                    it("should do post-logout cleanup", async () => {
                        await getComponentAndWaitForReady();
                        await dispatchLogoutAndWait();

                        // stuff that happens in onloggedout
                        expect(defaultDispatcher.fire).toHaveBeenCalledWith(Action.OnLoggedOut, true);
                        expect(EventIndexPeg.deleteEventIndex).toHaveBeenCalled();
                        expect(logoutClient.clearStores).toHaveBeenCalled();
                    });
                });
            });
        });
    });

    describe("login via key/pass", () => {
        let loginClient!: ReturnType<typeof getMockClientWithEventEmitter>;

        const mockCrypto = {
            getVerificationRequestsToDeviceInProgress: jest.fn().mockReturnValue([]),
            getUserDeviceInfo: jest.fn().mockResolvedValue(new Map()),
        };

        const userName = "ernie";
        const password = "ilovebert";

        const getComponentAndWaitForReady = async (): Promise<RenderResult> => {
            const renderResult = getComponent();
            // wait for welcome page chrome render
            await screen.findByText("powered by Matrix");

            // go to login page
            defaultDispatcher.dispatch({
                action: "start_login",
            });

            await flushPromises();

            return renderResult;
        };

        const getComponentAndLogin = async (withoutSecuritySetup?: boolean): Promise<void> => {
            await getComponentAndWaitForReady();

            fireEvent.change(screen.getByLabelText("Username"), { target: { value: userName } });
            fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });

            // sign in button is an input
            fireEvent.click(screen.getByDisplayValue("Sign in"));

            await waitForSyncAndLoad(loginClient, withoutSecuritySetup);
        };

        beforeEach(() => {
            loginClient = getMockClientWithEventEmitter(getMockClientMethods());
            // this is used to create a temporary client during login
            jest.spyOn(MatrixJs, "createClient").mockClear().mockReturnValue(loginClient);

            loginClient.login.mockClear().mockResolvedValue({
                access_token: "TOKEN",
                device_id: "IMADEVICE",
                user_id: userId,
            });
            loginClient.loginFlows.mockClear().mockResolvedValue({ flows: [{ type: "m.login.password" }] });

            loginClient.getProfileInfo.mockResolvedValue({
                displayname: "Ernie",
            });
        });

        it("should render login page", async () => {
            await getComponentAndWaitForReady();

            expect(screen.getAllByText("Sign in")[0]).toBeInTheDocument();
        });

        describe("post login setup", () => {
            beforeEach(() => {
                loginClient.isCryptoEnabled.mockReturnValue(true);
                loginClient.getCrypto.mockReturnValue(mockCrypto as any);
                loginClient.userHasCrossSigningKeys.mockClear().mockResolvedValue(false);
            });

            it("should go straight to logged in view when crypto is not enabled", async () => {
                loginClient.isCryptoEnabled.mockReturnValue(false);

                await getComponentAndLogin(true);

                expect(loginClient.userHasCrossSigningKeys).not.toHaveBeenCalled();
            });

            it("should go straight to logged in view when user does not have cross signing keys and server does not support cross signing", async () => {
                loginClient.doesServerSupportUnstableFeature.mockResolvedValue(false);

                await getComponentAndLogin(false);

                expect(loginClient.doesServerSupportUnstableFeature).toHaveBeenCalledWith(
                    "org.matrix.e2e_cross_signing",
                );

                await flushPromises();

                // logged in
                await screen.findByLabelText("User menu");
            });

            describe("when server supports cross signing and user does not have cross signing setup", () => {
                beforeEach(() => {
                    loginClient.doesServerSupportUnstableFeature.mockResolvedValue(true);
                    loginClient.userHasCrossSigningKeys.mockResolvedValue(false);
                });

                describe("when encryption is force disabled", () => {
                    const unencryptedRoom = new Room("!unencrypted:server.org", loginClient, userId);
                    const encryptedRoom = new Room("!encrypted:server.org", loginClient, userId);

                    beforeEach(() => {
                        loginClient.getClientWellKnown.mockReturnValue({
                            "io.element.e2ee": {
                                force_disable: true,
                            },
                        });

                        loginClient.isRoomEncrypted.mockImplementation((roomId) => roomId === encryptedRoom.roomId);
                    });

                    it("should go straight to logged in view when user is not in any encrypted rooms", async () => {
                        loginClient.getRooms.mockReturnValue([unencryptedRoom]);
                        await getComponentAndLogin(false);

                        await flushPromises();

                        // logged in, did not setup keys
                        await screen.findByLabelText("User menu");
                    });

                    it("should go to setup e2e screen when user is in encrypted rooms", async () => {
                        loginClient.getRooms.mockReturnValue([unencryptedRoom, encryptedRoom]);
                        await getComponentAndLogin();
                        await flushPromises();
                        // set up keys screen is rendered
                        expect(screen.getByText("Setting up keys")).toBeInTheDocument();
                    });
                });

                it("should go to setup e2e screen", async () => {
                    loginClient.doesServerSupportUnstableFeature.mockResolvedValue(true);

                    await getComponentAndLogin();

                    expect(loginClient.userHasCrossSigningKeys).toHaveBeenCalled();

                    await flushPromises();

                    // set up keys screen is rendered
                    expect(screen.getByText("Setting up keys")).toBeInTheDocument();
                });
            });

            it("should show complete security screen when user has cross signing setup", async () => {
                loginClient.userHasCrossSigningKeys.mockResolvedValue(true);

                await getComponentAndLogin();

                expect(loginClient.userHasCrossSigningKeys).toHaveBeenCalled();

                await flushPromises();

                // Complete security begin screen is rendered
                expect(screen.getByText("Unable to verify this device")).toBeInTheDocument();
            });

            it("should setup e2e when server supports cross signing", async () => {
                loginClient.doesServerSupportUnstableFeature.mockResolvedValue(true);

                await getComponentAndLogin();

                expect(loginClient.userHasCrossSigningKeys).toHaveBeenCalled();

                await flushPromises();

                // set up keys screen is rendered
                expect(screen.getByText("Setting up keys")).toBeInTheDocument();
            });
        });
    });

    describe("when query params have a loginToken", () => {
        const loginToken = "test-login-token";
        const realQueryParams = {
            loginToken,
        };

        const mockLocalStorage: Record<string, string> = {
            mx_sso_hs_url: serverConfig.hsUrl,
            mx_sso_is_url: serverConfig.isUrl,
            // these are only going to be set during login
            mx_hs_url: serverConfig.hsUrl,
            mx_is_url: serverConfig.isUrl,
        };

        let loginClient!: ReturnType<typeof getMockClientWithEventEmitter>;
        const userId = "@alice:server.org";
        const deviceId = "test-device-id";
        const accessToken = "test-access-token";
        const clientLoginResponse = {
            user_id: userId,
            device_id: deviceId,
            access_token: accessToken,
        };

        beforeEach(() => {
            loginClient = getMockClientWithEventEmitter(getMockClientMethods());
            // this is used to create a temporary client during login
            jest.spyOn(MatrixJs, "createClient").mockReturnValue(loginClient);

            loginClient.login.mockClear().mockResolvedValue(clientLoginResponse);

            localStorageGetSpy.mockImplementation((key: unknown) => mockLocalStorage[key as string] || "");
        });

        it("should show an error dialog when no homeserver is found in local storage", async () => {
            localStorageGetSpy.mockReturnValue(undefined);
            getComponent({ realQueryParams });

            expect(localStorageGetSpy).toHaveBeenCalledWith("mx_sso_hs_url");
            expect(localStorageGetSpy).toHaveBeenCalledWith("mx_sso_is_url");

            const dialog = await screen.findByRole("dialog");

            // warning dialog
            expect(
                within(dialog).getByText(
                    "We asked the browser to remember which homeserver you use to let you sign in, " +
                        "but unfortunately your browser has forgotten it. Go to the sign in page and try again.",
                ),
            ).toBeInTheDocument();
        });

        it("should attempt token login", async () => {
            getComponent({ realQueryParams });

            expect(loginClient.login).toHaveBeenCalledWith("m.login.token", {
                initial_device_display_name: undefined,
                token: loginToken,
            });
        });

        it("should call onTokenLoginCompleted", async () => {
            const onTokenLoginCompleted = jest.fn();
            getComponent({ realQueryParams, onTokenLoginCompleted });

            await flushPromises();

            expect(onTokenLoginCompleted).toHaveBeenCalled();
        });

        describe("when login fails", () => {
            beforeEach(() => {
                loginClient.login.mockRejectedValue(new Error("oups"));
            });
            it("should show a dialog", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                const dialog = await screen.findByRole("dialog");

                // warning dialog
                expect(
                    within(dialog).getByText(
                        "There was a problem communicating with the homeserver, please try again later.",
                    ),
                ).toBeInTheDocument();
            });

            it("should not clear storage", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(loginClient.clearStores).not.toHaveBeenCalled();
            });
        });

        describe("when login succeeds", () => {
            beforeEach(() => {
                jest.spyOn(StorageManager, "idbLoad").mockImplementation(
                    async (_table: string, key: string | string[]) => {
                        if (key === "mx_access_token") {
                            return accessToken as any;
                        }
                    },
                );
            });
            it("should clear storage", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                // just check we called the clearStorage function
                expect(loginClient.clearStores).toHaveBeenCalled();
                expect(localStorageClearSpy).toHaveBeenCalled();
            });

            it("should persist login credentials", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_hs_url", serverConfig.hsUrl);
                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_user_id", userId);
                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_has_access_token", "true");
                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_device_id", deviceId);
            });

            it("should set fresh login flag in session storage", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(sessionStorageSetSpy).toHaveBeenCalledWith("mx_fresh_login", "true");
            });

            it("should override hsUrl in creds when login response wellKnown differs from config", async () => {
                const hsUrlFromWk = "https://hsfromwk.org";
                const loginResponseWithWellKnown = {
                    ...clientLoginResponse,
                    well_known: {
                        "m.homeserver": {
                            base_url: hsUrlFromWk,
                        },
                    },
                };
                loginClient.login.mockResolvedValue(loginResponseWithWellKnown);
                getComponent({ realQueryParams });

                await flushPromises();

                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_hs_url", hsUrlFromWk);
            });

            it("should continue to post login setup when no session is found in local storage", async () => {
                getComponent({ realQueryParams });

                // logged in but waiting for sync screen
                await screen.findByText("Logout");
            });
        });
    });

    describe("when query params have a OIDC params", () => {
        const issuer = "https://auth.com/";
        const homeserverUrl = "https://matrix.org";
        const identityServerUrl = "https://is.org";
        const clientId = "xyz789";

        const code = "test-oidc-auth-code";
        const state = "test-oidc-state";
        const realQueryParams = {
            code,
            state: state,
        };

        const userId = "@alice:server.org";
        const deviceId = "test-device-id";
        const accessToken = "test-access-token-from-oidc";

        const mockLocalStorage: Record<string, string> = {
            // these are only going to be set during login
            mx_hs_url: homeserverUrl,
            mx_is_url: identityServerUrl,
            mx_user_id: userId,
            mx_device_id: deviceId,
        };

        const tokenResponse: BearerTokenResponse = {
            access_token: accessToken,
            refresh_token: "def456",
            scope: "test",
            token_type: "Bearer",
            expires_at: 12345,
        };

        let loginClient!: ReturnType<typeof getMockClientWithEventEmitter>;

        // for now when OIDC fails for any reason we just bump back to welcome
        // error handling screens in https://github.com/vector-im/element-web/issues/25665
        const expectOIDCError = async (): Promise<void> => {
            await flushPromises();
            // just check we're back on welcome page
            expect(document.querySelector(".mx_Welcome")!).toBeInTheDocument();
        };

        beforeEach(() => {
            mocked(completeAuthorizationCodeGrant).mockClear().mockResolvedValue({
                oidcClientSettings: {
                    clientId,
                    issuer,
                },
                tokenResponse,
                homeserverUrl,
                identityServerUrl,
            });

            jest.spyOn(logger, "error").mockClear();
        });

        beforeEach(() => {
            loginClient = getMockClientWithEventEmitter(getMockClientMethods());
            // this is used to create a temporary client during login
            jest.spyOn(MatrixJs, "createClient").mockReturnValue(loginClient);

            jest.spyOn(logger, "error").mockClear();
            jest.spyOn(logger, "log").mockClear();

            localStorageGetSpy.mockImplementation((key: unknown) => mockLocalStorage[key as string] || "");
            loginClient.whoami.mockResolvedValue({
                user_id: userId,
                device_id: deviceId,
                is_guest: false,
            });
        });

        it("should fail when query params do not include valid code and state", async () => {
            const queryParams = {
                code: 123,
                state: "abc",
            };
            getComponent({ realQueryParams: queryParams });

            await flushPromises();

            expect(logger.error).toHaveBeenCalledWith(
                "Failed to login via OIDC",
                new Error("Invalid query parameters for OIDC native login. `code` and `state` are required."),
            );

            await expectOIDCError();
        });

        it("should make correct request to complete authorization", async () => {
            getComponent({ realQueryParams });

            await flushPromises();

            expect(completeAuthorizationCodeGrant).toHaveBeenCalledWith(code, state);
        });

        it("should look up userId using access token", async () => {
            getComponent({ realQueryParams });

            await flushPromises();

            // check we used a client with the correct accesstoken
            expect(MatrixJs.createClient).toHaveBeenCalledWith({
                baseUrl: homeserverUrl,
                accessToken,
                idBaseUrl: identityServerUrl,
            });
            expect(loginClient.whoami).toHaveBeenCalled();
        });

        it("should log error and return to welcome page when userId lookup fails", async () => {
            loginClient.whoami.mockRejectedValue(new Error("oups"));
            getComponent({ realQueryParams });

            await flushPromises();

            expect(logger.error).toHaveBeenCalledWith(
                "Failed to login via OIDC",
                new Error("Failed to retrieve userId using accessToken"),
            );
            await expectOIDCError();
        });

        it("should call onTokenLoginCompleted", async () => {
            const onTokenLoginCompleted = jest.fn();
            getComponent({ realQueryParams, onTokenLoginCompleted });

            await flushPromises();

            expect(onTokenLoginCompleted).toHaveBeenCalled();
        });

        describe("when login fails", () => {
            beforeEach(() => {
                mocked(completeAuthorizationCodeGrant).mockRejectedValue(new Error(OidcError.CodeExchangeFailed));
            });

            it("should log and return to welcome page", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(logger.error).toHaveBeenCalledWith(
                    "Failed to login via OIDC",
                    new Error(OidcError.CodeExchangeFailed),
                );

                // warning dialog
                await expectOIDCError();
            });

            it("should not clear storage", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(loginClient.clearStores).not.toHaveBeenCalled();
            });

            it("should not store clientId or issuer", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(sessionStorageSetSpy).not.toHaveBeenCalledWith("mx_oidc_client_id", clientId);
                expect(sessionStorageSetSpy).not.toHaveBeenCalledWith("mx_oidc_token_issuer", issuer);
            });
        });

        describe("when login succeeds", () => {
            beforeEach(() => {
                localStorageGetSpy.mockImplementation((key: unknown) => mockLocalStorage[key as string] || "");
                jest.spyOn(StorageManager, "idbLoad").mockImplementation(
                    async (_table: string, key: string | string[]) => (key === "mx_access_token" ? accessToken : null),
                );
                loginClient.getProfileInfo.mockResolvedValue({
                    displayname: "Ernie",
                });
            });

            it("should persist login credentials", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_hs_url", homeserverUrl);
                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_user_id", userId);
                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_has_access_token", "true");
                expect(localStorageSetSpy).toHaveBeenCalledWith("mx_device_id", deviceId);
            });

            it("should store clientId and issuer in session storage", async () => {
                getComponent({ realQueryParams });

                await flushPromises();

                expect(sessionStorageSetSpy).toHaveBeenCalledWith("mx_oidc_client_id", clientId);
                expect(sessionStorageSetSpy).toHaveBeenCalledWith("mx_oidc_token_issuer", issuer);
            });

            it("should set logged in and start MatrixClient", async () => {
                getComponent({ realQueryParams });

                await flushPromises();
                await flushPromises();

                expect(logger.log).toHaveBeenCalledWith(
                    "setLoggedIn: mxid: " +
                        userId +
                        " deviceId: " +
                        deviceId +
                        " guest: " +
                        false +
                        " hs: " +
                        homeserverUrl +
                        " softLogout: " +
                        false,
                    " freshLogin: " + false,
                );

                // client successfully started
                expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({ action: "client_started" });

                // check we get to logged in view
                await waitForSyncAndLoad(loginClient, true);
            });
        });
    });
});
