/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as mssql from "vscode-mssql";
import ConnectionManager from "../controllers/connectionManager";
import * as vscode from "vscode";
import * as LocalizedConstants from "../constants/locConstants";
import { IConnectionProfile } from "../models/interfaces";
import { generateGuid } from "../models/utils";
import SqlToolsServiceClient from "../languageservice/serviceclient";
import { RequestType, NotificationType } from "vscode-languageclient";
import VscodeWrapper from "../controllers/vscodeWrapper";
import { Logger } from "../models/logger";
import * as Constants from "../constants/constants";
import { ScriptingService } from "../scripting/scriptingService";
import { ScriptOperation } from "../models/contracts/scripting/scriptingRequest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONNECTION_SHARING_PERMISSIONS_KEY = "mssql.connectionSharing.extensionPermissions";

type ExtensionPermission = "approved" | "denied";
type ExtensionPermissionsMap = Record<string, ExtensionPermission>;

export enum ConnectionSharingErrorCode {
    PERMISSION_DENIED = "PERMISSION_DENIED",
    PERMISSION_REQUIRED = "PERMISSION_REQUIRED",
    NO_ACTIVE_EDITOR = "NO_ACTIVE_EDITOR",
    NO_ACTIVE_CONNECTION = "NO_ACTIVE_CONNECTION",
    CONNECTION_NOT_FOUND = "CONNECTION_NOT_FOUND",
    CONNECTION_FAILED = "CONNECTION_FAILED",
    INVALID_CONNECTION_URI = "INVALID_CONNECTION_URI",
    QUERY_EXECUTION_FAILED = "QUERY_EXECUTION_FAILED",
    EXTENSION_NOT_FOUND = "EXTENSION_NOT_FOUND",
}

export class ConnectionSharingError extends Error {
    constructor(
        public readonly code: ConnectionSharingErrorCode,
        message: string,
        public readonly extensionId?: string,
        public readonly connectionId?: string,
    ) {
        super(message);
        this.name = "ConnectionSharingError";
    }
}

export class ConnectionSharingService implements mssql.IConnectionSharingService {
    private _logger: Logger;
    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _client: SqlToolsServiceClient,
        private readonly _connectionManager: ConnectionManager,
        private readonly _vscodeWrapper: VscodeWrapper,
        private readonly _scriptingService: ScriptingService,
    ) {
        this._logger = Logger.create(this._vscodeWrapper.outputChannel, "ConnectionSharingService");
        this.registerCommands();
    }

    private registerCommands(): void {
        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getActiveEditorConnectionId",
                (extensionId: string) => this.getActiveEditorConnectionId(extensionId),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getActiveDatabase",
                (extensionId: string) => this.getActiveDatabase(extensionId),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getDatabaseForConnectionId",
                (extensionId: string, connectionId: string) =>
                    this.getDatabaseForConnectionId(extensionId, connectionId),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.connect",
                (extensionId: string, connectionId: string, databaseName?: string) =>
                    this.connect(extensionId, connectionId, databaseName),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.disconnect",
                (connectionUri: string) => this.disconnect(connectionUri),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.isConnected",
                (connectionUri: string) => this.isConnected(connectionUri),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.executeSimpleQuery",
                (connectionUri: string, query: string) =>
                    this.executeSimpleQuery(connectionUri, query),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getServerInfo",
                (connectionUri: string) => this.getServerInfo(connectionUri),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.editConnectionSharingPermissions",
                async (extensionId?: string) => this.editConnectionSharingPermissions(extensionId),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.listDatabases",
                (connectionUri: string) => this.listDatabases(connectionUri),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.scriptOperation",
                (
                    connectionUri: string,
                    operation: ScriptOperation,
                    scriptingObject: mssql.IScriptingObject,
                ) => this.scriptObject(connectionUri, operation, scriptingObject),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.clearAllConnectionSharingPermissions",
                async () => {
                    const response = await vscode.window.showInformationMessage(
                        LocalizedConstants.ConnectionSharing.ClearAllPermissions,
                        LocalizedConstants.ConnectionSharing.Clear,
                        LocalizedConstants.ConnectionSharing.Cancel,
                    );

                    if (response !== LocalizedConstants.ConnectionSharing.Clear) {
                        this._logger.info("User canceled clearing connection sharing permissions.");
                        return;
                    }
                    await this.setApprovedExtensions({});
                    vscode.window.showInformationMessage(
                        LocalizedConstants.ConnectionSharing.AllPermissionsCleared,
                    );
                },
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getConnectionString",
                (extensionId: string, connectionId: string) =>
                    this.getConnectionString(extensionId, connectionId),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getAccessToken",
                (extensionId: string, connectionId: string) =>
                    this.getAccessToken(extensionId, connectionId),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getAvailableKernels",
                (extensionId: string) => this.getAvailableKernels(extensionId),
            ),
        );

        this._context.subscriptions.push(
            vscode.commands.registerCommand(
                "mssql.connectionSharing.getCompletions",
                (connectionUri: string, text: string, line: number, column: number) =>
                    this.getCompletions(connectionUri, text, line, column),
            ),
        );
    }

    private async getStoredExtensionPermissions(): Promise<ExtensionPermissionsMap> {
        const serializedPermissions = await this._context.secrets.get(
            CONNECTION_SHARING_PERMISSIONS_KEY,
        );

        if (!serializedPermissions) {
            // If no approved extensions are found, initialize with an empty array
            const emptyPermissions: ExtensionPermissionsMap = {};
            await this.storeExtensionPermissions(emptyPermissions);
            return emptyPermissions;
        }
        try {
            return JSON.parse(serializedPermissions) as ExtensionPermissionsMap;
        } catch (error) {
            this._logger.error("Failed to parse stored extension permissions:", error);
            const emptyPermissions: ExtensionPermissionsMap = {};
            await this.storeExtensionPermissions(emptyPermissions);
            return emptyPermissions;
        }
    }

    private async storeExtensionPermissions(permissions: ExtensionPermissionsMap): Promise<void> {
        await this._context.secrets.store(
            CONNECTION_SHARING_PERMISSIONS_KEY,
            JSON.stringify(permissions),
        );
    }

    private async getExtensionPermission(
        extensionId: string,
    ): Promise<ExtensionPermission | undefined> {
        const approvedExtensions = await this.getStoredExtensionPermissions();
        return approvedExtensions[extensionId];
    }

    private async updateExtensionPermission(
        extensionId: string,
        newPermission: ExtensionPermission,
    ): Promise<void> {
        const currentPermissions = await this.getStoredExtensionPermissions();
        const updatedPermissions = {
            ...currentPermissions,
            [extensionId]: newPermission,
        };
        await this.storeExtensionPermissions(updatedPermissions);
    }

    private async setApprovedExtensions(extensions: ExtensionPermissionsMap): Promise<void> {
        await this._context.secrets.store(
            CONNECTION_SHARING_PERMISSIONS_KEY,
            JSON.stringify(extensions),
        );
    }

    private async requestConnectionSharingPermission(extensionId: string): Promise<boolean> {
        this._logger.info(`Requesting connection sharing permission for extension: ${extensionId}`);

        const currentPermission = await this.getExtensionPermission(extensionId);

        if (currentPermission === "approved") {
            this._logger.info(`Connection sharing already approved for extension: ${extensionId}`);
            return true;
        }

        if (currentPermission === "denied") {
            this._logger.info(`Connection sharing denied for extension: ${extensionId}`);
            return false;
        }

        this._logger.info(
            `No existing permission for extension: ${extensionId}, requesting approval`,
        );

        const userChoice = await vscode.window.showInformationMessage(
            LocalizedConstants.ConnectionSharing.connectionSharingRequestNotification(extensionId),
            {},
            LocalizedConstants.ConnectionSharing.Approve,
            LocalizedConstants.ConnectionSharing.Deny,
        );

        if (!userChoice) {
            this._logger.info(
                `User canceled connection sharing request for extension: ${extensionId}`,
            );
            return false;
        }

        switch (userChoice) {
            case "Approve":
                this._logger.info(`User approved connection sharing for extension: ${extensionId}`);
                await this.updateExtensionPermission(extensionId, "approved");
                return true;
            case "Deny":
                this._logger.info(`User denied connection sharing for extension: ${extensionId}`);
                await this.updateExtensionPermission(extensionId, "denied");
                return false;
        }
    }

    private async validateExtensionPermission(extensionId: string): Promise<void> {
        const hasPermission = await this.requestConnectionSharingPermission(extensionId);

        if (!hasPermission) {
            const currentStatus = await this.getExtensionPermission(extensionId);

            if (currentStatus === "denied") {
                throw new ConnectionSharingError(
                    ConnectionSharingErrorCode.PERMISSION_DENIED,
                    LocalizedConstants.ConnectionSharing.permissionDenied(extensionId),
                    extensionId,
                );
            } else {
                throw new ConnectionSharingError(
                    ConnectionSharingErrorCode.PERMISSION_REQUIRED,
                    LocalizedConstants.ConnectionSharing.permissionRequired(extensionId),
                    extensionId,
                );
            }
        }
    }

    private validateConnection(connectionUri: string) {
        if (!connectionUri) {
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.INVALID_CONNECTION_URI,
                LocalizedConstants.ConnectionSharing.invalidConnectionUri,
            );
        }

        if (!this._connectionManager.isConnected(connectionUri)) {
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.NO_ACTIVE_CONNECTION,
                LocalizedConstants.ConnectionSharing.connectionNotActive,
            );
        }
    }

    private getExtensionDisplayName(extensionId: string): string {
        const extension = vscode.extensions.getExtension(extensionId);
        if (extension) {
            return `${extension.packageJSON.displayName} (${extensionId}), ${extension.packageJSON.publisher})`;
        }
        return extensionId;
    }

    public async getActiveEditorConnectionId(extensionId: string): Promise<string | undefined> {
        await this.validateExtensionPermission(extensionId);

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.NO_ACTIVE_EDITOR,
                LocalizedConstants.ConnectionSharing.noActiveEditorError,
                extensionId,
            );
        }

        const activeEditorUri = activeEditor.document.uri.toString(true);
        const isConnected = this._connectionManager.isConnected(activeEditorUri);

        if (!isConnected) {
            return undefined; // No active connection for the editor
        }

        const connectionDetails = this._connectionManager.getConnectionInfoFromUri(activeEditorUri);
        if (!connectionDetails) {
            return undefined; // No connection details found
        }

        return (connectionDetails as IConnectionProfile).id;
    }

    public async getActiveDatabase(extensionId: string): Promise<string | undefined> {
        await this.validateExtensionPermission(extensionId);

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.NO_ACTIVE_EDITOR,
                LocalizedConstants.ConnectionSharing.noActiveEditorError,
                extensionId,
            );
        }

        const activeEditorUri = activeEditor.document.uri.toString(true);
        const isConnected = this._connectionManager.isConnected(activeEditorUri);

        if (!isConnected) {
            return undefined; // No active connection for the editor
        }

        const connectionDetails = this._connectionManager.getConnectionInfoFromUri(activeEditorUri);
        if (!connectionDetails) {
            return undefined; // No connection details found
        }

        return connectionDetails.database;
    }

    public async getDatabaseForConnectionId(
        extensionId: string,
        connectionId: string,
    ): Promise<string | undefined> {
        await this.validateExtensionPermission(extensionId);

        const connections =
            await this._connectionManager.connectionStore.connectionConfig.getConnections();
        const targetConnection = connections.find((conn) => conn.id === connectionId);

        if (!targetConnection) {
            return undefined; // Connection not found
        }

        return targetConnection.database;
    }

    public async connect(
        extensionId: string,
        connectionId: string,
        databaseName?: string,
    ): Promise<string | undefined> {
        await this.validateExtensionPermission(extensionId);

        const connections =
            await this._connectionManager.connectionStore.connectionConfig.getConnections();
        const targetConnection = connections.find((conn) => conn.id === connectionId);

        if (!targetConnection) {
            this._logger.error(
                `Connection with ID "${connectionId}" not found for extension "${extensionId}".`,
            );
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.CONNECTION_NOT_FOUND,
                LocalizedConstants.ConnectionSharing.connectionNotFoundError(connectionId),
                extensionId,
                connectionId,
            );
        }

        const connectionUri = generateGuid();
        if (databaseName) {
            targetConnection.database = databaseName; // Set the database if provided
        }

        const connectionResult = await this._connectionManager.connect(
            connectionUri,
            targetConnection,
            {
                connectionSource: "connectionSharingService",
            },
        );

        if (!connectionResult) {
            this._logger.error(
                `Failed to establish connection with ID "${connectionId}" for extension "${extensionId}".`,
            );
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.CONNECTION_FAILED,
                LocalizedConstants.ConnectionSharing.failedToEstablishConnectionError(connectionId),
                extensionId,
                connectionId,
            );
        }
        this._logger.info(
            `Successfully connected to database with ID "${connectionId}" for extension "${extensionId}".`,
        );
        return connectionUri; // Return the connection URI
    }

    public disconnect(connectionUri: string): void {
        if (!connectionUri) {
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.INVALID_CONNECTION_URI,
                LocalizedConstants.ConnectionSharing.invalidConnectionUri,
            );
        }
        void this._connectionManager.disconnect(connectionUri);
    }

    public isConnected(connectionUri: string): boolean {
        if (!connectionUri) {
            return false;
        }
        return this._connectionManager.isConnected(connectionUri);
    }

    public async executeSimpleQuery(
        connectionUri: string,
        queryString: string,
    ): Promise<mssql.SimpleExecuteResult> {
        if (!connectionUri) {
            this._logger.error("Invalid connection URI provided for query execution.");
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.INVALID_CONNECTION_URI,
                LocalizedConstants.ConnectionSharing.invalidConnectionUri,
            );
        }

        if (!this.isConnected(connectionUri)) {
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.NO_ACTIVE_CONNECTION,
                LocalizedConstants.ConnectionSharing.connectionNotActive,
            );
        }

        const result = await this._client.sendRequest(
            new RequestType<
                { ownerUri: string; queryString: string },
                mssql.SimpleExecuteResult,
                void,
                void
            >("query/simpleexecute"),
            {
                ownerUri: connectionUri,
                queryString: queryString,
            },
        );
        return result;
    }

    public getServerInfo(connectionUri: string): mssql.IServerInfo {
        this._logger.info(`Retrieving server info for connection URI: ${connectionUri}`);
        this.validateConnection(connectionUri);
        const connectionDetails = this._connectionManager.getConnectionInfoFromUri(connectionUri);
        return this._connectionManager.getServerInfo(connectionDetails);
    }

    public async listDatabases(connectionUri: string): Promise<string[]> {
        this._logger.info(`Listing databases for connection URI: ${connectionUri}`);
        this.validateConnection(connectionUri);
        return await this._connectionManager.listDatabases(connectionUri);
    }

    public async scriptObject(
        connectionUri: string,
        operation: ScriptOperation,
        scriptingObject: mssql.IScriptingObject,
    ) {
        this._logger.info(
            `Executing script operation "${operation}" for connection URI: ${connectionUri}`,
        );
        this.validateConnection(connectionUri);
        const serverInfo = this.getServerInfo(connectionUri); // Ensure connection is valid
        const scriptingParams = this._scriptingService.createScriptingRequestParams(
            serverInfo,
            scriptingObject,
            connectionUri,
            operation,
        );
        return await this._scriptingService.script(scriptingParams);
    }

    public async editConnectionSharingPermissions(
        extensionId?: string,
    ): Promise<ExtensionPermission | undefined> {
        this._logger.info(
            `Editing connection sharing permissions for extension: ${extensionId ?? "not specified"}`,
        );
        if (!extensionId) {
            this._logger.info("No extension ID provided, prompting user to select an extension.");
            const extensionQuickPickItems: vscode.QuickPickItem[] = vscode.extensions.all
                .filter((ext) => ext.id !== Constants.extensionId) // Exclude self
                .map((extension) => ({
                    label: this.getExtensionDisplayName(extension.id),
                    detail: extension.id,
                    description: extension.packageJSON.description,
                }));

            const selectedExtension = await vscode.window.showQuickPick(extensionQuickPickItems, {
                canPickMany: false,
                placeHolder: LocalizedConstants.ConnectionSharing.SelectAnExtensionToManage,
                matchOnDescription: true,
            });

            if (!selectedExtension?.detail) {
                this._logger.info("User cancelled the extension selection.");
                return undefined; // User cancelled selection
            }
            this._logger.info(`User selected extension: ${selectedExtension.detail}`);
            extensionId = selectedExtension.detail;
        }

        const currentPermission = await this.getExtensionPermission(extensionId);
        const extensionDisplayName = this.getExtensionDisplayName(extensionId);

        this._logger.info(
            `Current permission for extension "${extensionDisplayName}" (${extensionId}): ${currentPermission}`,
        );

        const newPermission = await vscode.window.showQuickPick(
            [
                {
                    label:
                        currentPermission === "approved"
                            ? LocalizedConstants.ConnectionSharing.GrantAccessCurrent
                            : LocalizedConstants.ConnectionSharing.GrantAccess,
                    description:
                        LocalizedConstants.ConnectionSharing
                            .AllowThisExtensionToAccessYourConnections,
                    detail: "approved",
                },
                {
                    label:
                        currentPermission === "denied"
                            ? LocalizedConstants.ConnectionSharing.DenyAccessCurrent
                            : LocalizedConstants.ConnectionSharing.DenyAccess,
                    description:
                        LocalizedConstants.ConnectionSharing
                            .BlockThisExtensionFromAccessingYourConnections,
                    detail: "denied",
                },
            ],
            {
                placeHolder:
                    LocalizedConstants.ConnectionSharing.SelectNewPermission(extensionDisplayName),
            },
        );

        this._logger.info(`User selected new permission: ${newPermission?.detail}`);

        if (!newPermission) {
            return; // User canceled the selection
        }

        const newApproval: ExtensionPermission = newPermission.detail as ExtensionPermission;
        await this.updateExtensionPermission(extensionId, newApproval);
        this._logger.info(
            `Updated permission for extension "${extensionDisplayName}" (${extensionId}) to: ${newApproval}`,
        );
        return newApproval;
    }

    public async getConnectionString(
        extensionId: string,
        connectionId: string,
    ): Promise<string | undefined> {
        await this.validateExtensionPermission(extensionId);

        const connections =
            await this._connectionManager.connectionStore.connectionConfig.getConnections();
        const targetConnection = connections.find((conn) => conn.id === connectionId);

        if (!targetConnection) {
            this._logger.error(
                `Connection with ID "${connectionId}" not found for extension "${extensionId}".`,
            );
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.CONNECTION_NOT_FOUND,
                LocalizedConstants.ConnectionSharing.connectionNotFoundError(connectionId),
                extensionId,
                connectionId,
            );
        }

        // Use ConnectionManager's getConnectionString method
        const connectionDetails = this._connectionManager.createConnectionDetails(targetConnection);
        const connectionString = await this._connectionManager.getConnectionString(
            connectionDetails,
            true, // includePassword
            false, // do not include appName
        );

        this._logger.info(
            `Retrieved connection string for connection ID "${connectionId}" for extension "${extensionId}".`,
        );
        return connectionString;
    }

    public async getAccessToken(
        extensionId: string,
        connectionId: string,
    ): Promise<string | undefined> {
        await this.validateExtensionPermission(extensionId);

        const connections =
            await this._connectionManager.connectionStore.connectionConfig.getConnections();
        const targetConnection = connections.find((conn) => conn.id === connectionId);

        if (!targetConnection) {
            this._logger.error(
                `Connection with ID "${connectionId}" not found for extension "${extensionId}".`,
            );
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.CONNECTION_NOT_FOUND,
                LocalizedConstants.ConnectionSharing.connectionNotFoundError(connectionId),
                extensionId,
                connectionId,
            );
        }

        // Only return token for Azure MFA connections
        if (targetConnection.authenticationType !== 'AzureMFA') {
            this._logger.info(
                `Connection "${connectionId}" does not use Azure MFA authentication.`,
            );
            return undefined;
        }

        try {
            // Get the account from the account store
            const account = await this._connectionManager.accountStore.getAccount(targetConnection.accountId);
            if (!account) {
                this._logger.error(`Account not found for connection "${connectionId}".`);
                return undefined;
            }

            // Get the SQL resource settings for the account's cloud provider
            const { getCloudProviderSettings } = await import("../azure/providerSettings");
            const providerSettings = getCloudProviderSettings(account.key.providerId);
            const sqlResource = providerSettings.settings.sqlResource;

            // Get the access token for SQL
            const tenantId = targetConnection.tenantId || account.properties.owningTenant?.id;
            const token = await this._connectionManager.azureController.getAccountSecurityToken(
                account,
                tenantId,
                sqlResource,
            );

            if (token) {
                this._logger.info(
                    `Retrieved access token for connection ID "${connectionId}" for extension "${extensionId}".`,
                );
                return token.token;
            }

            return undefined;
        } catch (error) {
            this._logger.error(
                `Failed to get access token for connection "${connectionId}": ${error}`,
            );
            return undefined;
        }
    }

    public async getAvailableKernels(
        extensionId: string,
    ): Promise<mssql.IConnectionKernelInfo[]> {
        await this.validateExtensionPermission(extensionId);

        const connections =
            await this._connectionManager.connectionStore.connectionConfig.getConnections();

        const kernels: mssql.IConnectionKernelInfo[] = connections.map((conn) => ({
            id: conn.id,
            name: conn.profileName || `${conn.server}/${conn.database}`,
            server: conn.server,
            database: conn.database,
            authenticationType: conn.authenticationType,
            userName: conn.user,
        }));

        this._logger.info(
            `Retrieved ${kernels.length} available kernels for extension "${extensionId}".`,
        );

        return kernels;
    }

    // Map of connectionUri to temp file info for completions
    private _completionTempFiles: Map<string, { path: string; version: number; lastText: string; isOpen: boolean; isConnected: boolean }> = new Map();

    /**
     * Get SQL completions (intellisense) for a given connection and SQL text.
     * Uses the SQL Tools Service's LSP completion endpoint.
     * Optimized to reuse temp files and use didChange instead of didOpen for updates.
     */
    public async getCompletions(
        connectionUri: string,
        text: string,
        line: number,
        column: number,
    ): Promise<mssql.ICompletionItem[]> {
        if (!connectionUri) {
            this._logger.error("Invalid connection URI provided for completions.");
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.INVALID_CONNECTION_URI,
                LocalizedConstants.ConnectionSharing.invalidConnectionUri,
            );
        }

        if (!this.isConnected(connectionUri)) {
            this._logger.error(`Connection not active for URI: ${connectionUri}`);
            throw new ConnectionSharingError(
                ConnectionSharingErrorCode.NO_ACTIVE_CONNECTION,
                LocalizedConstants.ConnectionSharing.connectionNotActive,
            );
        }

        try {
            // Get or create temp file info for this connection
            let fileInfo = this._completionTempFiles.get(connectionUri);
            if (!fileInfo) {
                const tempFilePath = path.join(os.tmpdir(), `mssql-completion-${generateGuid()}.sql`);
                fileInfo = { path: tempFilePath, version: 0, lastText: "", isOpen: false, isConnected: false };
                this._completionTempFiles.set(connectionUri, fileInfo);
                this._logger.info(`Created temp file for completions: ${tempFilePath}`);
            }

            // Connect the temp file to the database if not already connected
            // This is required for database-specific intellisense (tables, schemas, etc.)
            if (!fileInfo.isConnected) {
                const connectionInfo = this._connectionManager.getConnectionInfoFromUri(connectionUri);
                if (connectionInfo) {
                    this._logger.info(`Connecting temp file ${fileInfo.path} to database for intellisense`);
                    
                    // Use the connection/connect request to bind the temp file to the connection
                    const connectResult = await this._client.sendRequest(
                        new RequestType<any, boolean, void, void>("connection/connect"),
                        {
                            ownerUri: fileInfo.path,
                            connection: {
                                serverName: connectionInfo.server,
                                databaseName: connectionInfo.database,
                                authenticationType: connectionInfo.authenticationType,
                                userName: connectionInfo.user,
                                password: connectionInfo.password,
                                // Copy other connection options
                                connectTimeout: 30,
                                applicationName: "mssql-polyglot-notebooks-completions",
                            },
                        },
                    );
                    
                    if (connectResult) {
                        fileInfo.isConnected = true;
                        this._logger.info(`Temp file connected to database successfully`);
                        
                        // Wait a bit for intellisense to initialize
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        this._logger.warn(`Failed to connect temp file to database`);
                    }
                }
            }

            // Check if content has changed
            const contentChanged = fileInfo.lastText !== text;
            
            if (contentChanged) {
                fileInfo.version++;
                fileInfo.lastText = text;
                
                // Write text to temp file (needed for STS to read)
                await fs.promises.writeFile(fileInfo.path, text, "utf8");
                
                if (!fileInfo.isOpen) {
                    // First time - send didOpen
                    await this._client.sendNotification(
                        new NotificationType<{ textDocument: { uri: string; languageId: string; version: number; text: string } }, void>(
                            "textDocument/didOpen"
                        ),
                        {
                            textDocument: {
                                uri: fileInfo.path,
                                languageId: "sql",
                                version: fileInfo.version,
                                text: text,
                            },
                        },
                    );
                    fileInfo.isOpen = true;
                } else {
                    // Subsequent updates - send didChange (much faster)
                    await this._client.sendNotification(
                        new NotificationType<{ textDocument: { uri: string; version: number }; contentChanges: { text: string }[] }, void>(
                            "textDocument/didChange"
                        ),
                        {
                            textDocument: {
                                uri: fileInfo.path,
                                version: fileInfo.version,
                            },
                            contentChanges: [{ text: text }],
                        },
                    );
                }
            }

            // Send completion request to SQL Tools Service
            const result = await this._client.sendRequest(
                new RequestType<
                    {
                        textDocument: { uri: string };
                        position: { line: number; character: number };
                        context: { triggerKind: number };
                    },
                    any[],
                    void,
                    void
                >("textDocument/completion"),
                {
                    textDocument: { uri: fileInfo.path },
                    position: { line: line, character: column },
                    context: { triggerKind: 1 }, // Invoked
                },
            );

            if (!result || result.length === 0) {
                return [];
            }

            // Map LSP completion items to our interface
            const completions: mssql.ICompletionItem[] = result.map((item: any) => ({
                label: item.label || "",
                kind: this.mapCompletionItemKind(item.kind),
                detail: item.detail,
                documentation:
                    typeof item.documentation === "string"
                        ? item.documentation
                        : item.documentation?.value,
                insertText: item.insertText || item.label,
                filterText: item.filterText,
                sortText: item.sortText,
            }));

            return completions;
        } catch (error) {
            this._logger.error(`Failed to get completions: ${error}`);
            return [];
        }
    }

    /**
     * Map LSP CompletionItemKind to a number.
     * LSP CompletionItemKind values (1-25) map to VS Code's CompletionItemKind (0-24).
     */
    private mapCompletionItemKind(kind: number | undefined): number {
        // LSP uses 1-based, VS Code uses 0-based
        if (kind === undefined || kind < 1 || kind > 25) {
            return 0; // Text
        }
        return kind - 1;
    }
}
